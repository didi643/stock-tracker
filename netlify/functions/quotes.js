// GET /api/quotes?symbols=AAPL,MSFT,...&duration=1d
// Returns: { quotes: { AAPL: {last, prev, changePct, ts}, ... } }
//
// Strategy: one batched call to Alpaca latest-trades + one batched bars call
// for the lookback window. Computes change vs start-of-window close.

const ALPACA_DATA = "https://data.alpaca.markets/v2";

// duration code -> daily bars to look back (sessions ago for the anchor)
// Anchor = close N sessions before the most recent session.
// Always fetch a generous window so weekends/holidays don't matter.
const DURATIONS = {
  "1d":  { sessionsBack: 1,   windowDays: 7   },
  "2d":  { sessionsBack: 2,   windowDays: 10  },
  "1w":  { sessionsBack: 5,   windowDays: 14  },
  "1m":  { sessionsBack: 21,  windowDays: 45  },
  "3m":  { sessionsBack: 63,  windowDays: 110 },
  "ytd": { sessionsBack: null, windowDays: 400 },  // anchor = last bar of prior year
  "1y":  { sessionsBack: 252, windowDays: 400 },
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

// Alpaca limit is 100 symbols per call for these endpoints.
const BATCH = 100;

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Fetch latest trades, batched + parallel
async function latestTrades(symbols, feed) {
  const results = await Promise.all(chunks(symbols, BATCH).map(batch =>
    alpacaGet("/stocks/trades/latest", { symbols: batch.join(","), feed })
  ));
  return Object.assign({}, ...results.map(r => r.trades || {}));
}

// Fetch daily bars, batched + parallel
async function bars(symbols, windowDays, feed) {
  const start = new Date(Date.now() - windowDays * 86400_000)
    .toISOString().slice(0, 10);
  const results = await Promise.all(chunks(symbols, BATCH).map(batch =>
    alpacaGet("/stocks/bars", {
      symbols:    batch.join(","),
      timeframe:  "1Day",
      start,
      limit:      windowDays * batch.length,
      adjustment: "split",
      feed,
    })
  ));
  return Object.assign({}, ...results.map(r => r.bars || {}));
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
      bars(syms, cfg.windowDays, feed),
    ]);

    // YTD anchor = last close of previous calendar year
    const yearStart = new Date(new Date().getUTCFullYear(), 0, 1).toISOString().slice(0, 10);

    const quotes = {};
    for (const s of syms) {
      const bs = barMap[s] || [];
      if (bs.length === 0) { quotes[s] = null; continue; }

      // Most recent close = last bar's close. This is the source of truth when
      // the market is closed; when open, latestTrade.p is fresher.
      const lastBar  = bs[bs.length - 1];
      const trade    = trades[s];
      // Use latest trade price only if it's at least as new as the last bar.
      // Otherwise fall back to the last bar's close (handles weekends/holidays,
      // and stale trades from halted symbols).
      const useTrade = trade && new Date(trade.t) >= new Date(lastBar.t);
      const last     = useTrade ? trade.p : lastBar.c;
      const ts       = useTrade ? trade.t : lastBar.t;

      // Pick the anchor bar
      let anchorBar;
      if (dur === "ytd") {
        anchorBar = [...bs].reverse().find(b => b.t.slice(0, 10) < yearStart);
      } else {
        const idx = Math.max(0, bs.length - 1 - cfg.sessionsBack);
        anchorBar = bs[idx];
      }
      if (!anchorBar) { quotes[s] = null; continue; }

      const anchor    = anchorBar.c;
      const changePct = anchor ? ((last - anchor) / anchor) * 100 : 0;

      quotes[s] = {
        last:       +last.toFixed(2),
        prev:       +anchor.toFixed(2),
        changePct:  +changePct.toFixed(2),
        ts,
        marketOpen: useTrade,                 // true if `last` is a fresh trade
        asOf:       lastBar.t,                // latest session end
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
    // Diagnostic: report whether env vars are present (without leaking values).
    const diag = {
      hasKeyId:  !!process.env.APCA_API_KEY_ID,
      hasSecret: !!process.env.APCA_API_SECRET_KEY,
      keyIdLen:  (process.env.APCA_API_KEY_ID || "").length,
      feed:      process.env.ALPACA_FEED || "iex",
    };
    console.error("quotes error:", e.message, diag);
    return new Response(JSON.stringify({ error: String(e.message || e), diag }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
};

export const config = { path: "/api/quotes" };
