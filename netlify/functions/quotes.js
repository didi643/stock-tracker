// GET /api/quotes?symbols=AAPL,MSFT,...&duration=1d
// Returns: { quotes: { AAPL: {last, prev, changePct, ts}, ... } }
//
// Strategy: one batched call to Alpaca latest-trades + one batched bars call
// for the lookback window. Computes change vs start-of-window close.

const ALPACA_DATA = "https://data.alpaca.markets/v2";

// duration code -> bars timeframe + lookback
const DURATIONS = {
  "1d":  { tf: "1Day",  bars: 2  },   // today vs prev close
  "2d":  { tf: "1Day",  bars: 3  },
  "1w":  { tf: "1Day",  bars: 7  },
  "1m":  { tf: "1Day",  bars: 23 },
  "3m":  { tf: "1Day",  bars: 65 },
  "ytd": { tf: "1Day",  bars: 260 },
  "1y":  { tf: "1Day",  bars: 260 },
};

function authHeaders() {
  return {
    "APCA-API-KEY-ID":     process.env.APCA_API_KEY_ID,
    "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY,
  };
}

async function alpacaGet(path, params) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${ALPACA_DATA}${path}?${qs}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`Alpaca ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

// Fetch latest trades for a batch (≤200 symbols per call per Alpaca limits)
async function latestTrades(symbols, feed) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 200) {
    const batch = symbols.slice(i, i + 200);
    const data = await alpacaGet("/stocks/trades/latest", {
      symbols: batch.join(","),
      feed,
    });
    Object.assign(out, data.trades || {});
  }
  return out;
}

// Fetch bars for the lookback window (one batched call per 200 symbols)
async function bars(symbols, timeframe, limit, feed) {
  const out = {};
  // start = today - (limit * 1.6) calendar days to cover weekends/holidays
  const start = new Date(Date.now() - limit * 1.6 * 86400_000)
    .toISOString().slice(0, 10);
  for (let i = 0; i < symbols.length; i += 200) {
    const batch = symbols.slice(i, i + 200);
    const data = await alpacaGet("/stocks/bars", {
      symbols: batch.join(","),
      timeframe,
      start,
      limit: limit * batch.length,
      adjustment: "split",
      feed,
    });
    Object.assign(out, data.bars || {});
  }
  return out;
}

export default async (req) => {
  const url   = new URL(req.url);
  const syms  = (url.searchParams.get("symbols") || "")
                  .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const dur   = url.searchParams.get("duration") || "1d";
  const cfg   = DURATIONS[dur] || DURATIONS["1d"];
  const feed  = process.env.ALPACA_FEED || "iex";

  if (!syms.length) {
    return new Response(JSON.stringify({ error: "symbols required" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }
  if (syms.length > 500) {
    return new Response(JSON.stringify({ error: "max 500 symbols" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  try {
    const [trades, barMap] = await Promise.all([
      latestTrades(syms, feed),
      bars(syms, cfg.tf, cfg.bars, feed),
    ]);

    const quotes = {};
    for (const s of syms) {
      const t  = trades[s];
      const bs = barMap[s] || [];
      if (!t || bs.length === 0) { quotes[s] = null; continue; }

      const last = t.p;
      // anchor = close of the bar `cfg.bars - 1` ago, i.e. first bar in window
      // for 1d: bars=[yesterday, today] -> anchor=yesterday close
      const anchor = bs[0].c;
      const changePct = anchor ? ((last - anchor) / anchor) * 100 : 0;

      quotes[s] = {
        last:      +last.toFixed(2),
        prev:      +anchor.toFixed(2),
        changePct: +changePct.toFixed(2),
        ts:        t.t,
      };
    }

    return new Response(JSON.stringify({ duration: dur, feed, quotes }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=20",  // matches ~30s polling
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
};

export const config = { path: "/api/quotes" };
