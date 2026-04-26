// GET /api/fundamentals?symbols=AAPL,MSFT,...
// Returns per-symbol: { pe, pe5yAvg, high52w, low52w, fcfYield,
//                       ma50, ma200, rsi14, bars200 }
//
// Data sources (all Alpaca):
//   - /v2/stocks/snapshots  → latest quote + daily bar (includes 52w high/low via bars window)
//   - /v2/stocks/bars       → 252 daily bars for MA50, MA200, RSI14, 52w range
//
// NOTE: Alpaca free/IEX tier does NOT provide fundamental PE or FCF data.
// We therefore:
//   - Derive 52w high/low from 252-day price bars (exact, always available)
//   - Compute MA50, MA200, RSI14 from those same bars
//   - Return pe / pe5yAvg / fcfYield as null (frontend DCF uses configurable assumptions)
// If you upgrade to Alpaca's "Broker" plan or add a separate fundamentals provider
// (e.g. Financial Modeling Prep), swap in that data here without touching the frontend.

const ALPACA_DATA = "https://data.alpaca.markets/v2";

function authHeaders() {
  return {
    "APCA-API-KEY-ID":     process.env.APCA_API_KEY_ID,
    "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY,
  };
}

async function alpacaGet(path, params) {
  const qs = new URLSearchParams(params).toString();
  const r  = await fetch(`${ALPACA_DATA}${path}?${qs}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`Alpaca ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

const toAlpaca  = s => s.replace("-", ".");
const fromAlpaca = s => s.replace(".", "-");

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ── Technical indicators ──────────────────────────────────────────────────────

/** Simple Moving Average over last `n` closes */
function sma(closes, n) {
  if (closes.length < n) return null;
  const window = closes.slice(-n);
  return window.reduce((a, b) => a + b, 0) / n;
}

/** RSI-14 using Wilder's smoothed average */
function rsi14(closes) {
  if (closes.length < 15) return null;
  const slice = closes.slice(-15);
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const d = slice[i] - slice[i - 1];
    if (d > 0) gains  += d;
    else       losses -= d;
  }
  const avgGain = gains  / 14;
  const avgLoss = losses / 14;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

/** Fetch 252 daily bars per symbol, batched 100 at a time */
async function fetchBars252(symbols, feed) {
  const start = new Date(Date.now() - 380 * 86400_000).toISOString().slice(0, 10);
  const results = await Promise.all(
    chunks(symbols.map(toAlpaca), 100).map(batch =>
      alpacaGet("/stocks/bars", {
        symbols:    batch.join(","),
        timeframe:  "1Day",
        start,
        limit:      252 * batch.length,
        adjustment: "split",
        feed,
      })
    )
  );
  const out = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.bars || {})) {
      out[fromAlpaca(k)] = v;
    }
  }
  return out;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async (req) => {
  const url  = new URL(req.url);
  const syms = (url.searchParams.get("symbols") || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const feed = process.env.ALPACA_FEED || "iex";

  if (!syms.length) {
    return new Response(JSON.stringify({ error: "symbols required" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  try {
    const barMap = await fetchBars252(syms, feed);

    const fundamentals = {};
    for (const sym of syms) {
      const bars = barMap[sym] || [];
      if (bars.length < 2) { fundamentals[sym] = null; continue; }

      const closes  = bars.map(b => b.c);
      const highs   = bars.map(b => b.h);
      const lows    = bars.map(b => b.l);
      const volumes = bars.map(b => b.v);

      const last    = closes[closes.length - 1];
      const high52w = Math.max(...highs);
      const low52w  = Math.min(...lows);

      // Average daily volume (last 30 sessions) — useful for liquidity context
      const adv30 = closes.length >= 30
        ? volumes.slice(-30).reduce((a, b) => a + b, 0) / 30
        : null;

      fundamentals[sym] = {
        // Price-derived technicals
        ma50:    sma(closes, 50),
        ma200:   sma(closes, 200),
        rsi14:   rsi14(closes),
        high52w: +high52w.toFixed(2),
        low52w:  +low52w.toFixed(2),
        pctFrom52wHigh: last && high52w ? +((last - high52w) / high52w * 100).toFixed(2) : null,
        adv30:   adv30 ? Math.round(adv30) : null,

        // Fundamental fields (null unless a richer data provider is wired in)
        pe:       null,   // trailing P/E
        pe5yAvg:  null,   // 5-year average P/E
        fcfYield: null,   // free cash flow yield

        // Raw bars for client-side use (last 252 daily closes)
        bars: bars.map(b => ({ t: b.t, c: b.c, h: b.h, l: b.l, v: b.v })),
      };
    }

    return new Response(JSON.stringify({ fundamentals }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=3600",   // fundamentals stale OK for 1h
      },
    });
  } catch (e) {
    console.error("fundamentals error:", e.message);
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
};

export const config = { path: "/api/fundamentals" };
