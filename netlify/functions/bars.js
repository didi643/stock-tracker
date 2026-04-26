// GET /api/bars?symbol=AAPL&duration=1m
// Returns: { symbol, bars: [{t,o,h,l,c,v}, ...] } for charting.

const ALPACA_DATA = "https://data.alpaca.markets/v2";

const DURATIONS = {
  "1d":  { tf: "5Min",  days: 1   },
  "2d":  { tf: "15Min", days: 3   },
  "1w":  { tf: "30Min", days: 8   },
  "1m":  { tf: "1Day",  days: 32  },
  "3m":  { tf: "1Day",  days: 95  },
  "ytd": { tf: "1Day",  days: 365 },
  "1y":  { tf: "1Day",  days: 365 },
};

export default async (req) => {
  const url    = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "").toUpperCase().replace("-", ".");
  const dur    = url.searchParams.get("duration") || "1m";
  const cfg    = DURATIONS[dur] || DURATIONS["1m"];
  const feed   = process.env.ALPACA_FEED || "iex";

  if (!symbol) {
    return new Response(JSON.stringify({ error: "symbol required" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  const start = new Date(Date.now() - cfg.days * 86400_000)
    .toISOString();
  const params = new URLSearchParams({
    timeframe: cfg.tf, start, limit: "1000",
    adjustment: "split", feed,
  });

  const r = await fetch(
    `${ALPACA_DATA}/stocks/${symbol}/bars?${params}`,
    { headers: {
        "APCA-API-KEY-ID":     process.env.APCA_API_KEY_ID,
        "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY,
    }}
  );

  if (!r.ok) {
    return new Response(JSON.stringify({ error: await r.text() }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
  const data = await r.json();
  return new Response(
    JSON.stringify({ symbol, duration: dur, bars: data.bars || [] }),
    { status: 200, headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=60",
    }},
  );
};

export const config = { path: "/api/bars" };
