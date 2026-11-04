// Fetches structural SEO signals for our own site plus every competitor in
// _data/competitors.yml (title/meta, heading counts, rough word count,
// structured data, sitemap size, and a PageSpeed Insights mobile score),
// and writes the raw results to reports/competitor-raw-<date>.json.
//
// This only runs from GitHub Actions (not from a Claude Code sandbox):
// fetching arbitrary third-party sites needs unrestricted outbound network
// access, which a sandboxed session does not have but a GitHub-hosted
// runner does.
//
// This script deliberately does NOT write any narrative/analysis - it only
// collects raw, verifiable facts. The "strengths/weaknesses/recommendations"
// report is written separately (by Claude, reading this JSON), so that
// factual data and interpretive analysis are never mixed in one file.
//
// Optional env vars:
//   PAGESPEED_API_KEY - raises the PageSpeed Insights quota above the
//                        shared keyless limit. Works without one too, just
//                        more likely to hit a 429.

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const REQUEST_DELAY_MS = 2000; // politeness delay between sites
const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT =
  "IranRunnersCompetitorResearchBot/1.0 (+https://iranrunners.com; one-off manual competitive research, respects robots.txt)";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal, headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) } });
  } finally {
    clearTimeout(t);
  }
}

// Minimal robots.txt check: looks for a "User-agent: *" block and returns
// whether the given path is disallowed under it. Not a full spec
// implementation, but enough to honor the common case responsibly.
function isDisallowed(robotsTxt, urlPath) {
  if (!robotsTxt) return false;
  const lines = robotsTxt.split(/\r?\n/).map((l) => l.trim());
  let inWildcardBlock = false;
  let applies = false;
  const disallows = [];
  for (const raw of lines) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      inWildcardBlock = value === "*";
      if (inWildcardBlock) applies = true;
    } else if (key === "disallow" && inWildcardBlock) {
      if (value) disallows.push(value);
    }
  }
  if (!applies) return false;
  return disallows.some((d) => urlPath.indexOf(d) === 0);
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countTag(html, tag) {
  const re = new RegExp(`<${tag}[\\s>]`, "gi");
  return (html.match(re) || []).length;
}

function extractJsonLdTypes(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  const types = [];
  for (const b of blocks) {
    try {
      const data = JSON.parse(b[1].trim());
      const entries = Array.isArray(data) ? data : [data];
      for (const e of entries) {
        if (e && e["@type"]) types.push(e["@type"]);
      }
    } catch (e) {
      // malformed JSON-LD on the target site - not our bug, just skip it
    }
  }
  return types;
}

async function analyzeSite(baseUrl) {
  const result = { url: baseUrl, fetchedAt: new Date().toISOString() };
  const origin = new URL(baseUrl).origin;

  let robotsTxt = "";
  try {
    const robotsRes = await fetchWithTimeout(`${origin}/robots.txt`);
    if (robotsRes.ok) robotsTxt = await robotsRes.text();
  } catch (e) {
    // no robots.txt is not an error - treat as "nothing disallowed"
  }

  if (isDisallowed(robotsTxt, "/")) {
    result.blockedByRobots = true;
    return result;
  }

  try {
    const res = await fetchWithTimeout(origin + "/");
    result.httpStatus = res.status;
    if (res.ok) {
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
      result.title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, " ") : null;
      result.titleLength = result.title ? result.title.length : 0;
      result.metaDescription = descMatch ? descMatch[1].trim() : null;
      result.metaDescriptionLength = result.metaDescription ? result.metaDescription.length : 0;
      result.h1Count = countTag(html, "h1");
      result.h2Count = countTag(html, "h2");
      result.h3Count = countTag(html, "h3");
      const text = stripTags(html);
      result.wordCountHomepage = text.split(/\s+/).filter(Boolean).length;
      result.jsonLdTypes = extractJsonLdTypes(html);
      result.hasJsonLd = result.jsonLdTypes.length > 0;
    }
  } catch (e) {
    result.fetchError = String(e.message || e);
  }

  await sleep(500);
  if (!isDisallowed(robotsTxt, "/sitemap.xml")) {
    try {
      const smRes = await fetchWithTimeout(`${origin}/sitemap.xml`);
      if (smRes.ok) {
        const xml = await smRes.text();
        const locs = [...xml.matchAll(/<loc>/g)];
        result.sitemapUrlCount = locs.length;
        result.hasSitemap = true;
        // Sitemap index files point at other sitemaps instead of pages -
        // report that distinctly rather than a misleading low page count.
        result.isSitemapIndex = /<sitemapindex/i.test(xml);
      } else {
        result.hasSitemap = false;
      }
    } catch (e) {
      result.hasSitemap = false;
      result.sitemapError = String(e.message || e);
    }
  } else {
    result.hasSitemap = null;
    result.sitemapBlockedByRobots = true;
  }

  await sleep(500);
  try {
    const key = process.env.PAGESPEED_API_KEY;
    const psUrl =
      `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(origin + "/")}` +
      `&strategy=mobile&category=performance&category=seo` +
      (key ? `&key=${encodeURIComponent(key)}` : "");
    const psRes = await fetchWithTimeout(psUrl);
    if (psRes.ok) {
      const ps = await psRes.json();
      const cats = (ps.lighthouseResult && ps.lighthouseResult.categories) || {};
      result.pageSpeedMobile = {
        performanceScore: cats.performance ? Math.round(cats.performance.score * 100) : null,
        seoScore: cats.seo ? Math.round(cats.seo.score * 100) : null,
      };
    } else {
      result.pageSpeedError = `HTTP ${psRes.status}`;
    }
  } catch (e) {
    result.pageSpeedError = String(e.message || e);
  }

  return result;
}

async function main() {
  const competitorsPath = path.join(__dirname, "..", "_data", "competitors.yml");
  const competitors = yaml.load(fs.readFileSync(competitorsPath, "utf8")) || {};
  const pinned = competitors.pinned || [];
  const excluded = new Set((competitors.excluded || []).map((u) => u.replace(/\/$/, "")));

  const sites = [{ url: "https://iranrunners.com", name: "ایران رانرز (خودمون)", isUs: true }];
  for (const c of pinned) {
    if (excluded.has(c.url.replace(/\/$/, ""))) continue;
    sites.push({ url: c.url, name: c.name, reason: c.reason, isUs: false });
  }

  const results = [];
  for (const site of sites) {
    console.log(`Analyzing ${site.name} (${site.url})...`);
    const data = await analyzeSite(site.url);
    results.push({ ...site, ...data });
    await sleep(REQUEST_DELAY_MS);
  }

  const date = todayISO();
  const reportsDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const outPath = path.join(reportsDir, `competitor-raw-${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ date, sites: results }, null, 2) + "\n");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
