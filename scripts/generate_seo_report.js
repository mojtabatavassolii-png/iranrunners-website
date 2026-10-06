// Generates a dated SEO/analytics report for iranrunners.com combining:
//   - Google Search Console: sitemap URL list, per-URL indexing status
//     (URL Inspection API), and Search Analytics (clicks/impressions/CTR/
//     position) for the last ~30 days.
//   - GA4 Data API (optional, skipped if GA4_PROPERTY_ID is unset):
//     session/user totals, top pages, traffic source breakdown.
//
// Output: reports/report-YYYY-MM-DD.md (plus the same data as JSON next
// to it, for anything that wants to read it programmatically).
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

  const totals = await runReport({
    dateRanges: [{ startDate, endDate }],
    metrics: [{ name: "sessions" }, { name: "activeUsers" }, { name: "screenPageViews" }],
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

  return {
    sessions: totalsRow ? totalsRow.metricValues[0].value : "0",
    activeUsers: totalsRow ? totalsRow.metricValues[1].value : "0",
    pageViews: totalsRow ? totalsRow.metricValues[2].value : "0",
    topPages: (topPages.rows || []).map((r) => ({
      path: r.dimensionValues[0].value,
      views: r.metricValues[0].value,
    })),
    channels: (channels.rows || []).map((r) => ({
      channel: r.dimensionValues[0].value,
      sessions: r.metricValues[0].value,
    })),
  };
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
      const shortUrl = url.replace(SITE_URL, "");
      report.pages.push({ url, ...status, ...a });
      lines.push(
        `| ${shortUrl} | ${formatCoverage(status.coverageState)} | ${a.clicks} | ${a.impressions} | ${(a.ctr * 100).toFixed(1)}% | ${a.position ? a.position.toFixed(1) : "-"} |`
      );
      await sleep(500); // stay well under URL Inspection rate limits
    }
    lines.push("");

    const indexed = report.pages.filter((p) => p.coverageState.startsWith("Submitted") || p.coverageState.startsWith("Indexed")).length;
    const pending = report.pages.length - indexed;
    lines.push(`**خلاصه:** ${indexed} صفحه ایندکس‌شده، ${pending} صفحه در انتظار/نامشخص.`);
    lines.push("");
  } catch (err) {
    report.gscError = String(err.message || err);
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
      lines.push(`- کاربران فعال: ${ga4.activeUsers}`);
      lines.push(`- بازدید صفحات: ${ga4.pageViews}`);
      lines.push("");
      lines.push("### پربازدیدترین صفحات");
      lines.push("");
      lines.push("| صفحه | بازدید |");
      lines.push("|---|---|");
      for (const p of ga4.topPages) lines.push(`| ${p.path} | ${p.views} |`);
      lines.push("");
      lines.push("### منبع ترافیک");
      lines.push("");
      lines.push("| کانال | جلسات |");
      lines.push("|---|---|");
      for (const c of ga4.channels) lines.push(`| ${c.channel} | ${c.sessions} |`);
      lines.push("");
    } catch (err) {
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
