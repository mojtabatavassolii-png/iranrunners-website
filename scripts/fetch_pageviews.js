// Pulls all-time pageview counts for /blog/* posts from the GA4 Data API
// and writes them to _data/pageviews.json, keyed by post slug.
//
// Required env vars:
//   GOOGLE_SERVICE_ACCOUNT_JSON - full contents of the GA4 service account key
//   GA4_PROPERTY_ID             - numeric GA4 property id

const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");

async function main() {
  const propertyId = process.env.GA4_PROPERTY_ID;
  const rawCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!propertyId) throw new Error("GA4_PROPERTY_ID is not set");
  if (!rawCredentials) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");

  const credentials = JSON.parse(rawCredentials);
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        dateRanges: [{ startDate: "2020-01-01", endDate: "today" }],
        dimensions: [{ name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }],
        dimensionFilter: {
          filter: {
            fieldName: "pagePath",
            stringFilter: { matchType: "BEGINS_WITH", value: "/blog/" },
          },
        },
        limit: 10000,
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`GA4 Data API request failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const pageviews = {};

  for (const row of data.rows || []) {
    const pagePath = row.dimensionValues[0].value;
    const views = parseInt(row.metricValues[0].value, 10);
    const match = pagePath.match(/^\/blog\/(.+)\.html/);
    if (!match) continue;
    let slug;
    try {
      slug = decodeURIComponent(match[1]);
    } catch (e) {
      slug = match[1];
    }
    pageviews[slug] = (pageviews[slug] || 0) + views;
  }

  const outPath = path.join(__dirname, "..", "_data", "pageviews.json");
  fs.writeFileSync(outPath, JSON.stringify(pageviews, null, 2) + "\n");
  console.log(`Wrote ${Object.keys(pageviews).length} post(s) to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
