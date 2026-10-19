// Temporary diagnostic: dumps the real GA4 Data API metadata for this
// property so we can confirm exact dimension/metric names for entry/exit
// page reporting before building against them. Not part of the permanent
// toolset - delete after use.
const { GoogleAuth } = require("google-auth-library");

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const propertyId = process.env.GA4_PROPERTY_ID;
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();

  const res = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}/metadata`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    console.error("Metadata request failed:", res.status, await res.text());
    process.exit(1);
  }
  const data = await res.json();

  const keywords = /exit|landing|entrance|previous|path|session_start|page_location|screen/i;
  console.log("=== DIMENSIONS matching page/exit/landing/entrance/path ===");
  for (const d of data.dimensions || []) {
    if (keywords.test(d.apiName) || keywords.test(d.uiName || "")) {
      console.log(JSON.stringify({ apiName: d.apiName, uiName: d.uiName, description: d.description }));
    }
  }
  console.log("");
  console.log("=== METRICS matching exit/entrance/bounce ===");
  for (const m of data.metrics || []) {
    if (/exit|entrance|bounce/i.test(m.apiName) || /exit|entrance|bounce/i.test(m.uiName || "")) {
      console.log(JSON.stringify({ apiName: m.apiName, uiName: m.uiName, description: m.description }));
    }
  }
  console.log("");
  console.log("=== ALL dimension apiNames (for full reference) ===");
  console.log((data.dimensions || []).map((d) => d.apiName).join(", "));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
