// Generates a dated SEO/analytics report for iranrunners.com combining:
//   - Google Search Console: sitemap URL list, per-URL indexing status
//     (URL Inspection API), and Search Analytics (clicks/impressions/CTR/
//     position) for the last ~30 days.
//   - GA4 Data API (optional, skipped if GA4_PROPERTY_ID is unset):
//     session/user totals, top pages, traffic source breakdown.
//
// Output: reports/report-YYYY-MM-DD.md (plus the same data as JSON next
// to it, for anything that wants to read it programmatically), and
// assets/data/dashboard-latest.json - a chart-ready snapshot consumed by
// the live admin/dashboard.html page (unlike reports/, assets/ is not
// excluded from the Jekyll build, so this file is actually servable).
//
// Required env vars:
//   GOOGLE_SERVICE_ACCOUNT_JSON - full contents of the shared service
//                                 account key (same one used for GA4
//                                 pageviews; must also be added as a
//                                 "Full" user on the Search Console
//                                 property - see CONTENT_GUIDELINES.md
//                                 or the setup instructions given with
//                                 this script).
// Optional env vars:
//   GA4_PROPERTY_ID - numeric GA4 property id. GA section is skipped if
//                      not set.
//   SITE_URL        - defaults to https://iranrunners.com

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { GoogleAuth } = require("google-auth-library");

const SITE_URL = (process.env.SITE_URL || "https://iranrunners.com").replace(/\/$/, "");
const GA4_PROPERTY_ID = process.env.GA4_PROPERTY_ID || "";

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getAccessToken(credentials, scopes) {
  const auth = new GoogleAuth({ credentials, scopes });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

// Shared GA4 Data API report runner, used by the per-page/geography/source
// breakdowns below (runGa4Report further down keeps its own copy for the
// totals/topPages/channels/daily report, left untouched to minimize risk).
async function ga4Report(token, body) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`GA4 Data API request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// --- canonical URL resolution -------------------------------------------
// GA4 tracks raw request paths, which fragments real per-page totals across
// known-duplicate paths: "/" and "/index.html" are the same homepage (both
// live, both linked from different places), and old pre-redirect paths like
// "/gallery.html" still carry historical pageviews for what is now
// "/گالری.html". Without collapsing these, "top pages" and per-page view
// counts under-count real pages and list stale duplicates as if they were
// separate pages. This builds an alias -> canonical map from the site's own
// redirect_from front matter (the same data jekyll-redirect-from uses to
// generate the redirect stubs) plus the "/" -> "/index.html" GitHub Pages
// special case.
function parseFrontMatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try {
    return yaml.load(m[1]) || {};
  } catch (e) {
    return {};
  }
}

function loadSiteConfig() {
  const configPath = path.join(__dirname, "..", "_config.yml");
  return yaml.load(fs.readFileSync(configPath, "utf8"));
}

function permalinkPatternFor(config, collectionType) {
  if (collectionType === "posts") return config.permalink;
  const def = (config.defaults || []).find(
    (d) => d.scope && d.scope.type === collectionType && d.values && d.values.permalink
  );
  return def ? def.values.permalink : null;
}

function slugFor(frontMatter, filePath, stripDatePrefix) {
  if (frontMatter.slug) return frontMatter.slug;
  let base = path.basename(filePath, path.extname(filePath));
  if (stripDatePrefix) base = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
  return base;
}

function collectAliasMap() {
  const repoRoot = path.join(__dirname, "..");
  const config = loadSiteConfig();
  const aliasToCanonical = new Map();
  aliasToCanonical.set("/", "/index.html");

  function processCollection(dir, collectionType, stripDatePrefix) {
    const pattern = permalinkPatternFor(config, collectionType);
    const fullDir = path.join(repoRoot, dir);
    if (!pattern || !fs.existsSync(fullDir)) return;
    for (const fname of fs.readdirSync(fullDir)) {
      if (!fname.endsWith(".md") && !fname.endsWith(".html")) continue;
      const fpath = path.join(fullDir, fname);
      const fm = parseFrontMatter(fs.readFileSync(fpath, "utf8"));
      if (!fm.redirect_from) continue;
      const canonical = fm.permalink || pattern.replace(":title", slugFor(fm, fpath, stripDatePrefix));
      const redirects = Array.isArray(fm.redirect_from) ? fm.redirect_from : [fm.redirect_from];
      redirects.forEach((r) => aliasToCanonical.set(r, canonical));
    }
  }

  processCollection("_posts", "posts", true);
  processCollection("_classes", "classes", false);
  processCollection("_events", "events", false);

  // root-level static pages set their own explicit `permalink:` front matter
  for (const fname of fs.readdirSync(repoRoot)) {
    if (!fname.endsWith(".html")) continue;
    const fpath = path.join(repoRoot, fname);
    if (!fs.statSync(fpath).isFile()) continue;
    const fm = parseFrontMatter(fs.readFileSync(fpath, "utf8"));
    if (!fm.redirect_from || !fm.permalink) continue;
    const redirects = Array.isArray(fm.redirect_from) ? fm.redirect_from : [fm.redirect_from];
    redirects.forEach((r) => aliasToCanonical.set(r, fm.permalink));
  }

  return aliasToCanonical;
}

function canonicalizePath(rawPath, aliasMap) {
  let p = rawPath.split("?")[0].split("#")[0];
  try {
    p = decodeURIComponent(p);
  } catch (e) {
    // leave as-is if it's not validly percent-encoded
  }
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return aliasMap.has(p) ? aliasMap.get(p) : p;
}

// --- new breakdowns: per-page views, geography, traffic source/medium ---
async function fetchAllPageViews(token, startDate, endDate) {
  const data = await ga4Report(token, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "screenPageViews" }],
    limit: 10000,
  });
  return (data.rows || []).map((r) => ({
    pagePath: r.dimensionValues[0].value,
    views: Number(r.metricValues[0].value),
  }));
}

async function fetchGeography(token, startDate, endDate) {
  const countries = await ga4Report(token, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "country" }],
    metrics: [{ name: "activeUsers" }, { name: "sessions" }],
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    limit: 15,
  });
  const cities = await ga4Report(token, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "country" }, { name: "city" }],
    metrics: [{ name: "activeUsers" }, { name: "sessions" }],
    orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
    limit: 15,
  });
  return {
    countries: (countries.rows || []).map((r) => ({
      country: r.dimensionValues[0].value,
      activeUsers: Number(r.metricValues[0].value),
      sessions: Number(r.metricValues[1].value),
    })),
    cities: (cities.rows || [])
      .map((r) => ({
        country: r.dimensionValues[0].value,
        city: r.dimensionValues[1].value,
        activeUsers: Number(r.metricValues[0].value),
        sessions: Number(r.metricValues[1].value),
      }))
      .filter((r) => r.city && r.city !== "(not set)"),
  };
}

async function fetchTrafficSources(token, startDate, endDate) {
  const data = await ga4Report(token, {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "sessionSourceMedium" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    limit: 20,
  });
  return (data.rows || []).map((r) => ({
    sourceMedium: r.dimensionValues[0].value,
    sessions: Number(r.metricValues[0].value),
  }));
}

async function fetchSitemapUrls() {
  const res = await fetch(`${SITE_URL}/sitemap.xml`);
  if (!res.ok) throw new Error(`Failed to fetch sitemap.xml: ${res.status}`);
  const xml = await res.text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  return urls;
}

async function discoverGscSiteUrl(token) {
  const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Search Console sites.list failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const entries = data.siteEntry || [];
  const match = entries.find((e) => e.siteUrl.includes("iranrunners.com"));
  if (!match) {
    const have = entries.map((e) => e.siteUrl).join(", ") || "(none)";
    throw new Error(
      `No Search Console property for iranrunners.com is visible to this service account. ` +
        `Sites it can see: ${have}`
    );
  }
  return match.siteUrl;
}

async function inspectUrl(token, gscSiteUrl, inspectionUrl) {
  const res = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ inspectionUrl, siteUrl: gscSiteUrl }),
  });
  if (!res.ok) {
    return { coverageState: `خطا در بررسی (${res.status})` };
  }
  const data = await res.json();
  const result = data.inspectionResult && data.inspectionResult.indexStatusResult;
  return {
    coverageState: result ? result.coverageState : "نامشخص",
    lastCrawlTime: result ? result.lastCrawlTime : null,
  };
}

async function fetchSearchAnalytics(token, gscSiteUrl, startDate, endDate) {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(gscSiteUrl)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions: ["page"], rowLimit: 1000 }),
    }
  );
  if (!res.ok) {
    throw new Error(`Search Analytics query failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const byUrl = {};
  for (const row of data.rows || []) {
    byUrl[row.keys[0]] = {
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    };
  }
  return byUrl;
}

async function runGa4Report(token, startDate, endDate) {
  async function runReport(body) {
    const res = await fetch(
      `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) throw new Error(`GA4 Data API request failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // Single no-dimension query -> one row for the whole date range. This is
  // the only mathematically correct way to get a period-total unique-user
  // count: activeUsers/totalUsers are already deduplicated by GA4's
  // reporting identity (the _ga client-ID cookie per browser/device, unless
  // Google Signals or a User-ID is configured to stitch devices together -
  // see SEO_REPORTING.md). Summing each day's activeUsers instead would
  // double-count anyone who returns on more than one day within the range.
  const totals = await runReport({
    dateRanges: [{ startDate, endDate }],
    metrics: [
      { name: "sessions" },
      { name: "activeUsers" },
      { name: "totalUsers" },
      { name: "screenPageViews" },
    ],
  });
  const totalsRow = (totals.rows || [])[0];

  const topPages = await runReport({
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "pagePath" }],
    metrics: [{ name: "screenPageViews" }],
    orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    limit: 10,
  });

  const channels = await runReport({
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "sessionDefaultChannelGroup" }],
    metrics: [{ name: "sessions" }],
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
  });

  const daily = await runReport({
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }],
    orderBys: [{ dimension: { dimensionName: "date" } }],
  });

  return {
    sessions: totalsRow ? totalsRow.metricValues[0].value : "0",
    activeUsers: totalsRow ? totalsRow.metricValues[1].value : "0",
    totalUsers: totalsRow ? totalsRow.metricValues[2].value : "0",
    pageViews: totalsRow ? totalsRow.metricValues[3].value : "0",
    topPages: (topPages.rows || []).map((r) => ({
      path: r.dimensionValues[0].value,
      views: r.metricValues[0].value,
    })),
    channels: (channels.rows || []).map((r) => ({
      channel: r.dimensionValues[0].value,
      sessions: r.metricValues[0].value,
    })),
    daily: (daily.rows || []).map((r) => ({
      date: r.dimensionValues[0].value, // YYYYMMDD
      sessions: Number(r.metricValues[0].value),
      activeUsers: Number(r.metricValues[1].value),
      pageViews: Number(r.metricValues[2].value),
    })),
  };
}

// Breakdown of "class_signup_click" events by class name. Requires a
// one-time manual setup step in GA4: Admin -> Custom definitions ->
// Create custom dimension, scope "Event", event parameter "class_name".
// Until that's done, the customEvent:class_name dimension doesn't exist
// yet and this throws - callers should catch and degrade gracefully.
async function fetchClassInterest(token, startDate, endDate) {
  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: "customEvent:class_name" }],
        metrics: [{ name: "eventCount" }],
        dimensionFilter: {
          filter: {
            fieldName: "eventName",
            stringFilter: { value: "class_signup_click" },
          },
        },
        orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`GA4 class-interest query failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.rows || [])
    .map((r) => ({ className: r.dimensionValues[0].value, clicks: Number(r.metricValues[0].value) }))
    .filter((r) => r.className);
}

function formatCoverage(state) {
  const map = {
    "Submitted and indexed": "✅ ایندکس‌شده",
    "Indexed, not submitted in sitemap": "✅ ایندکس‌شده (بدون ثبت در سایت‌مپ)",
    "Crawled - currently not indexed": "⏳ خزیده‌شده، هنوز ایندکس نشده",
    "Discovered - currently not indexed": "⏳ کشف‌شده، هنوز ایندکس نشده",
    "URL is unknown to Google": "❓ ناشناخته برای گوگل",
  };
  return map[state] || `❓ ${state}`;
}

function isIndexedState(state) {
  return state.startsWith("Submitted") || state.startsWith("Indexed");
}

// Plain-Persian explanation + a concrete suggested fix for every
// coverageState the URL Inspection API can return. Keyed on the state
// string Google itself returns (there's no separate reason code - this
// field already encodes the specific cause).
const INDEX_ISSUE_MAP = {
  "Discovered - currently not indexed": {
    simple: "این صفحه دیده شده ولی گوگل هنوز وقت نکرده بخزدش.",
    action: "از Search Console (URL Inspection → Request Indexing) درخواست خزش دستی بده، یا چند لینک داخلی بیشتر از صفحات پربازدید به این صفحه اضافه کن.",
    severity: "warning",
  },
  "Crawled - currently not indexed": {
    simple: "این صفحه خزیده شده ولی گوگل هنوز تصمیم نگرفته ایندکسش کنه — معمولاً یعنی محتوا رو به‌اندازه کافی باارزش یا منحصربه‌فرد تشخیص نداده.",
    action: "محتوای صفحه رو طولانی‌تر و تخصصی‌تر کن، یا اگه خیلی شبیه یه مقاله دیگه‌ست، دوتا رو با هم ادغام کن.",
    severity: "warning",
  },
  "Duplicate without user-selected canonical": {
    simple: "گوگل این صفحه رو شبیه یه صفحه دیگه از سایت تشخیص داده و نمی‌دونه کدوم نسخه اصلیه.",
    action: "یک تگ canonical مشخص به نسخه اصلی اضافه کن، یا اگه محتوا واقعاً تکراریه یکی‌شون رو حذف/ریدایرکت کن.",
    severity: "error",
  },
  "Duplicate, Google chose different canonical than user": {
    simple: "گوگل یه نسخه دیگه از این صفحه رو به‌عنوان نسخه اصلی انتخاب کرده، نه اونی که خودت canonical کردی.",
    action: "بررسی کن کدوم نسخه باید اصلی باشه؛ اگه انتخاب گوگل درسته، لینک‌های داخلی رو به همون نسخه هدایت کن.",
    severity: "error",
  },
  "Alternate page with proper canonical tag": {
    simple: "این صفحه به‌عنوان نسخه جایگزین یک صفحه دیگه علامت خورده و canonical درست تنظیم شده — طبیعیه و مشکلی نیست.",
    action: "",
    severity: "ok",
  },
  "Excluded by 'noindex' tag": {
    simple: "این صفحه تگ noindex داره که به گوگل می‌گه ایندکسش نکنه.",
    action: "اگه عمدی نبوده، تگ noindex رو از فایل مربوطه بردار.",
    severity: "error",
  },
  "Blocked by robots.txt": {
    simple: "فایل robots.txt سایت به گوگل اجازه خزیدن این صفحه رو نمی‌ده.",
    action: "robots.txt رو چک کن و مطمئن شو این آدرس بلاک نشده.",
    severity: "error",
  },
  "Page with redirect": {
    simple: "این آدرس داره به یه آدرس دیگه ریدایرکت می‌شه، پس خودش جداگانه ایندکس نمی‌شه.",
    action: "اگه این ریدایرکت عمدیه (مثلاً از یه آدرس قدیمی) مشکلی نیست؛ اگه نه، مسیر redirect_from رو بررسی کن.",
    severity: "info",
  },
  "Not found (404)": {
    simple: "گوگل موقع خزیدن این آدرس به خطای ۴۰۴ خورده.",
    action: "یا صفحه رو بساز/برگردون، یا اگه واقعاً حذف شده این آدرس رو از sitemap و لینک‌های داخلی حذف کن.",
    severity: "error",
  },
  "Soft 404": {
    simple: "صفحه بار می‌شه ولی گوگل محتواش رو شبیه یه صفحه خطا/خالی تشخیص داده.",
    action: "مطمئن شو صفحه محتوای واقعی و کامل داره، نه یه پیام خالی یا placeholder.",
    severity: "error",
  },
  "Server error (5xx)": {
    simple: "سرور هنگام خزیدن این صفحه خطا برگردونده.",
    action: "هاستینگ/GitHub Pages رو چک کن ببین اون لحظه مشکلی داشته یا نه؛ اگه تکرار شد، بیشتر بررسی لازمه.",
    severity: "error",
  },
  "Blocked due to access forbidden (403)": {
    simple: "گوگل موقع خزیدن این صفحه با خطای دسترسی ممنوع (403) روبه‌رو شده.",
    action: "مطمئن شو این صفحه برای بازدیدکننده‌های عمومی (و رباتها) قابل‌دسترسیه.",
    severity: "error",
  },
  "Blocked due to unauthorized request (401)": {
    simple: "این صفحه نیاز به ورود/احراز هویت داره، پس گوگل نمی‌تونه ببینتش.",
    action: "اگه این صفحه قراره عمومی باشه، محدودیت دسترسیش رو بردار؛ اگه نه (مثل صفحات ادمین) طبیعیه و نیازی به کاری نیست.",
    severity: "info",
  },
  "URL is unknown to Google": {
    simple: "گوگل هنوز اصلاً این آدرس رو ندیده.",
    action: "مطمئن شو توی sitemap.xml هست و حداقل از یک صفحه دیگه سایت بهش لینک داده شده.",
    severity: "warning",
  },
};

function explainIndexIssue(coverageState) {
  return (
    INDEX_ISSUE_MAP[coverageState] || {
      simple: `دلیل مشخصی برای این وضعیت («${coverageState}») توی این گزارش نگاشت نشده.`,
      action: "این آدرس رو مستقیم توی Search Console → Pages بررسی کن تا جزئیات دقیق رو ببینی.",
      severity: "warning",
    }
  );
}

function loadInProgressUrls() {
  try {
    const filePath = path.join(__dirname, "..", "_data", "index_task_status.yml");
    const parsed = yaml.load(fs.readFileSync(filePath, "utf8")) || {};
    const list = parsed.in_progress || [];
    const map = new Map();
    for (const item of list) {
      if (item && item.url) map.set(item.url.trim(), item.note || "");
    }
    return map;
  } catch (err) {
    return new Map();
  }
}

async function main() {
  const rawCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!rawCredentials) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");
  const credentials = JSON.parse(rawCredentials);

  const startDate = daysAgoISO(30);
  const endDate = daysAgoISO(3);
  const date = todayISO();

  const lines = [];
  lines.push(`# گزارش سئو و آنالیتیکس ایران رانرز — ${date}`);
  lines.push("");
  lines.push(`بازه داده Search Console: ${startDate} تا ${endDate} (گوگل معمولاً ۲-۳ روز اخیر رو هنوز پردازش نکرده).`);
  lines.push("");

  const report = { date, startDate, endDate, pages: [], ga4: null, gscError: null };
  const dashboard = {
    generatedAt: new Date().toISOString(),
    startDate,
    endDate,
    indexStatus: { indexed: 0, pending: 0, total: 0 },
    pages: [],
    indexTasks: [],
    daily: [],
    topPages: [],
    channels: [],
    activeUsers: null,
    totalUsers: null,
    geography: { countries: [], cities: [] },
    geographyError: null,
    trafficSources: [],
    trafficSourcesError: null,
    classInterest: [],
    classInterestError: null,
    gscError: null,
    ga4Error: null,
  };

  // --- Search Console section ---
  try {
    const gscToken = await getAccessToken(credentials, [
      "https://www.googleapis.com/auth/webmasters.readonly",
    ]);
    const gscSiteUrl = await discoverGscSiteUrl(gscToken);
    const sitemapUrls = await fetchSitemapUrls();
    const analytics = await fetchSearchAnalytics(gscToken, gscSiteUrl, startDate, endDate);

    lines.push(`## وضعیت ایندکس صفحات (${sitemapUrls.length} آدرس در sitemap.xml)`);
    lines.push("");
    lines.push("| آدرس | وضعیت ایندکس | کلیک | نمایش | CTR | میانگین رتبه |");
    lines.push("|---|---|---|---|---|---|");

    for (const url of sitemapUrls) {
      const status = await inspectUrl(gscToken, gscSiteUrl, url);
      const a = analytics[url] || { clicks: 0, impressions: 0, ctr: 0, position: null };
      const shortUrl = decodeURIComponent(url.replace(SITE_URL, ""));
      report.pages.push({ url, ...status, ...a });
      lines.push(
        `| ${shortUrl} | ${formatCoverage(status.coverageState)} | ${a.clicks} | ${a.impressions} | ${(a.ctr * 100).toFixed(1)}% | ${a.position ? a.position.toFixed(1) : "-"} |`
      );
      await sleep(500); // stay well under URL Inspection rate limits
    }
    lines.push("");

    const indexed = report.pages.filter((p) => isIndexedState(p.coverageState)).length;
    const pending = report.pages.length - indexed;
    lines.push(`**خلاصه:** ${indexed} صفحه ایندکس‌شده، ${pending} صفحه در انتظار/نامشخص.`);
    lines.push("");

    dashboard.indexStatus = { indexed, pending, total: report.pages.length };
    dashboard.pages = report.pages.map((p) => ({
      url: decodeURIComponent(p.url.replace(SITE_URL, "")),
      coverageState: p.coverageState,
      clicks: p.clicks,
      impressions: p.impressions,
      ctr: p.ctr,
      position: p.position,
    }));

    const inProgress = loadInProgressUrls();
    for (const p of dashboard.pages) {
      const indexedNow = isIndexedState(p.coverageState);
      const marked = inProgress.has(p.url);
      if (!indexedNow) {
        const issue = explainIndexIssue(p.coverageState);
        dashboard.indexTasks.push({
          url: p.url,
          coverageState: p.coverageState,
          status: marked ? "در حال رفع" : "نیاز به بررسی",
          note: marked ? inProgress.get(p.url) : "",
          issue,
        });
      } else if (marked) {
        dashboard.indexTasks.push({
          url: p.url,
          coverageState: p.coverageState,
          status: "حل‌شده",
          note: inProgress.get(p.url),
          issue: { simple: "این صفحه الان ایندکس شده — می‌تونی از لیست «در حال رفع» (در داشبورد Pages CMS) پاکش کنی.", action: "", severity: "ok" },
        });
      }
    }
  } catch (err) {
    report.gscError = String(err.message || err);
    dashboard.gscError = report.gscError;
    lines.push("## Search Console");
    lines.push("");
    lines.push(`⚠️ نتونستم به Search Console وصل بشم: ${report.gscError}`);
    lines.push("");
    lines.push(
      `اگه هنوز Service Account رو به Property اضافه نکردید، ایمیلش رو (فیلد client_email توی JSON) با نقش Full به Search Console → Settings → Users and permissions اضافه کنید.`
    );
    lines.push("");
  }

  // --- GA4 section ---
  if (GA4_PROPERTY_ID) {
    try {
      const gaToken = await getAccessToken(credentials, [
        "https://www.googleapis.com/auth/analytics.readonly",
      ]);
      const ga4 = await runGa4Report(gaToken, startDate, endDate);
      report.ga4 = ga4;

      lines.push(`## گوگل آنالیتیکس (${startDate} تا ${endDate})`);
      lines.push("");
      lines.push(`- جلسات (Sessions): ${ga4.sessions}`);
      lines.push(`- کاربران یکتا/فعال (Active Users — افراد منحصربه‌فرد، نه تعداد اتصال یا بازدید): ${ga4.activeUsers}`);
      lines.push(`- کل کاربران شامل غیرفعال (Total Users): ${ga4.totalUsers}`);
      lines.push(`- بازدید صفحات: ${ga4.pageViews}`);
      lines.push("");

      dashboard.daily = ga4.daily;
      dashboard.channels = ga4.channels;
      // Period-total unique-user counts, from a single no-dimension GA4
      // query (see the comment above runGa4Report's `totals` query) — the
      // correct way to report "unique visitors" for the whole date range.
      // Do NOT derive this by summing dashboard.daily[].activeUsers: GA4
      // dedupes per query, so a visitor active on two different days would
      // be counted twice that way.
      dashboard.activeUsers = Number(ga4.activeUsers);
      dashboard.totalUsers = Number(ga4.totalUsers);

      // Per-page views, deduplicated against known URL aliases ("/" vs
      // "/index.html", old pre-redirect paths vs their canonical Persian
      // URL) so a single real page isn't reported as several.
      try {
        const aliasMap = collectAliasMap();
        const rawPageViews = await fetchAllPageViews(gaToken, startDate, endDate);
        const viewsByCanonical = new Map();
        for (const row of rawPageViews) {
          const canon = canonicalizePath(row.pagePath, aliasMap);
          viewsByCanonical.set(canon, (viewsByCanonical.get(canon) || 0) + row.views);
        }

        dashboard.pages.forEach((p) => {
          p.views = viewsByCanonical.get(canonicalizePath(p.url, aliasMap)) || 0;
        });

        dashboard.topPages = Array.from(viewsByCanonical.entries())
          .map(([path, views]) => ({ path, views }))
          .sort((a, b) => b.views - a.views)
          .slice(0, 10);
      } catch (err) {
        // fall back to GA4's own (non-deduplicated) top-pages ordering
        // rather than losing the panel entirely
        dashboard.topPages = ga4.topPages;
      }

      lines.push("### پربازدیدترین صفحات (آدرس‌های تکراری/قدیمی با نسخه اصلی ادغام شدن)");
      lines.push("");
      lines.push("| صفحه | بازدید |");
      lines.push("|---|---|");
      for (const p of dashboard.topPages) lines.push(`| ${p.path} | ${p.views} |`);
      lines.push("");
      lines.push("### منبع ترافیک");
      lines.push("");
      lines.push("| کانال | جلسات |");
      lines.push("|---|---|");
      for (const c of ga4.channels) lines.push(`| ${c.channel} | ${c.sessions} |`);
      lines.push("");

      try {
        dashboard.classInterest = await fetchClassInterest(gaToken, startDate, endDate);
      } catch (err) {
        dashboard.classInterestError = String(err.message || err);
      }

      try {
        dashboard.geography = await fetchGeography(gaToken, startDate, endDate);
        lines.push("### موقعیت جغرافیایی بازدیدکنندگان (کشورها)");
        lines.push("");
        lines.push("| کشور | کاربران فعال | جلسات |");
        lines.push("|---|---|---|");
        for (const c of dashboard.geography.countries) lines.push(`| ${c.country} | ${c.activeUsers} | ${c.sessions} |`);
        lines.push("");
      } catch (err) {
        dashboard.geographyError = String(err.message || err);
      }

      try {
        dashboard.trafficSources = await fetchTrafficSources(gaToken, startDate, endDate);
        lines.push("### منبع/رسانه ورود دقیق");
        lines.push("");
        lines.push("| منبع / رسانه | جلسات |");
        lines.push("|---|---|");
        for (const s of dashboard.trafficSources) lines.push(`| ${s.sourceMedium} | ${s.sessions} |`);
        lines.push("");
      } catch (err) {
        dashboard.trafficSourcesError = String(err.message || err);
      }
    } catch (err) {
      dashboard.ga4Error = String(err.message || err);
      lines.push("## گوگل آنالیتیکس");
      lines.push("");
      lines.push(`⚠️ نتونستم به GA4 وصل بشم: ${err.message || err}`);
      lines.push("");
    }
  } else {
    lines.push("## گوگل آنالیتیکس");
    lines.push("");
    lines.push("GA4_PROPERTY_ID تنظیم نشده، این بخش رد شد.");
    lines.push("");
  }

  const reportsDir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const mdPath = path.join(reportsDir, `report-${date}.md`);
  const jsonPath = path.join(reportsDir, `report-${date}.json`);
  fs.writeFileSync(mdPath, lines.join("\n") + "\n");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  console.log(`Wrote ${mdPath}`);

  const dataDir = path.join(__dirname, "..", "assets", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const dashboardPath = path.join(dataDir, "dashboard-latest.json");
  fs.writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2) + "\n");
  console.log(`Wrote ${dashboardPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
