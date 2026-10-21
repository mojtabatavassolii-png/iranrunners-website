// One-off diagnostic (not part of the regular pipeline): what search
// queries actually show iranrunners.com pages for marathon-plan-related
// searches, and what the "آماده‌سازی ماراتن" article's own top queries
// are. Answers a concrete user question ("why doesn't my indexed article
// show up when I search 'برنامه ماراتن'?") with real Search Console data
// instead of guessing. Meant to be removed after use.
const { GoogleAuth } = require("google-auth-library");

const SITE_URL = (process.env.SITE_URL || "https://iranrunners.com").replace(/\/$/, "");

function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

async function getAccessToken(credentials, scopes) {
  const auth = new GoogleAuth({ credentials, scopes });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function discoverGscSiteUrl(token) {
  const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  const entries = data.siteEntry || [];
  const match = entries.find((e) => e.siteUrl.includes("iranrunners.com"));
  if (!match) throw new Error("No Search Console property visible");
  return match.siteUrl;
}

async function query(token, gscSiteUrl, body) {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(gscSiteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`query failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const token = await getAccessToken(credentials, ["https://www.googleapis.com/auth/webmasters.readonly"]);
  const gscSiteUrl = await discoverGscSiteUrl(token);

  const startDate = daysAgoISO(480); // full available history
  const endDate = daysAgoISO(3);

  const out = { startDate, endDate, siteWideMarathonQueries: [], articleTopQueries: [], articleTotals: null };

  // 1) Any query containing "ماراتن" that showed ANY page of this site, ever.
  const siteWide = await query(token, gscSiteUrl, {
    startDate,
    endDate,
    dimensions: ["query", "page"],
    dimensionFilterGroups: [{ filters: [{ dimension: "query", operator: "contains", expression: "ماراتن" }] }],
    rowLimit: 200,
  });
  out.siteWideMarathonQueries = (siteWide.rows || [])
    .map((r) => ({ query: r.keys[0], page: r.keys[1].replace(SITE_URL, ""), clicks: r.clicks, impressions: r.impressions, position: r.position }))
    .sort((a, b) => b.impressions - a.impressions);

  // 2) The marathon-prep article's own top queries (whatever little it gets).
  // NB: Search Console stores/matches the percent-encoded form (confirmed
  // against the live sitemap.xml - a raw Persian-text URL silently matches
  // zero rows via the "equals" filter), so this must be encoded the same
  // way Jekyll's sitemap generator encodes it.
  const articleUrl = `${SITE_URL}${encodeURI("/وبلاگ/آماده-سازی-ماراتن.html")}`;
  const articleQ = await query(token, gscSiteUrl, {
    startDate,
    endDate,
    dimensions: ["query"],
    dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "equals", expression: articleUrl }] }],
    rowLimit: 50,
  });
  out.articleTopQueries = (articleQ.rows || [])
    .map((r) => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: r.position }))
    .sort((a, b) => b.impressions - a.impressions);

  // 3) Article totals (no query dimension) for context.
  const totals = await query(token, gscSiteUrl, {
    startDate,
    endDate,
    dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "equals", expression: articleUrl }] }],
  });
  const row = (totals.rows || [])[0];
  out.articleTotals = row ? { clicks: row.clicks, impressions: row.impressions, position: row.position } : { clicks: 0, impressions: 0, position: null };

  const fs = require("fs");
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/_diag-query-check.json", JSON.stringify(out, null, 2) + "\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
