// GET /api/fmp-debug?symbol=AAPL
// Hits every known FMP endpoint variant and returns raw responses.
// DELETE THIS FILE after debugging.

const BASES = [
  "https://financialmodelingprep.com/stable",
  "https://financialmodelingprep.com/api/v4",
  "https://financialmodelingprep.com/api/v3",
];

export default async (req) => {
  const url    = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "AAPL").toUpperCase();
  const key    = process.env.FMP_API_KEY;

  if (!key) {
    return new Response(JSON.stringify({ error: "FMP_API_KEY env var not set" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }

  const results = {};

  for (const base of BASES) {
    // Try both path-param style (/profile/AAPL) and query-param style (/profile?symbol=AAPL)
    const endpoints = [
      `${base}/profile/${symbol}?apikey=${key}`,
      `${base}/profile?symbol=${symbol}&apikey=${key}`,
      `${base}/key-metrics-ttm/${symbol}?apikey=${key}`,
      `${base}/key-metrics-ttm?symbol=${symbol}&apikey=${key}`,
    ];
    for (const ep of endpoints) {
      const shortKey = ep.replace(key, "***").replace(base, base.split("/").pop());
      try {
        const r = await fetch(ep);
        const text = await r.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        results[shortKey] = { status: r.status, body: parsed };
      } catch (e) {
        results[shortKey] = { error: e.message };
      }
    }
  }

  return new Response(JSON.stringify(results, null, 2), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export const config = { path: "/api/fmp-debug" };
