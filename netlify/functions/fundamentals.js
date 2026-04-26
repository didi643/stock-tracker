// GET /api/fundamentals?symbols=AAPL,MSFT,...
// Returns per-symbol technical + fundamental data.
//
// Technical (always available — computed from Alpaca daily bars):
//   ma50, ma200, rsi14, high52w, low52w, pctFrom52wHigh, adv30
//
// Fundamental (requires FMP_API_KEY env var):
//   pe         — trailing twelve-month P/E
//   pe5yAvg    — 5-year average P/E from annual ratios
//   fcfYield   — free cash flow yield (FCF per share / price)
//   eps        — diluted EPS TTM
//
// FMP free tier: 250 calls/day, 1 symbol per call.
// We fetch 3 endpoints per symbol (profile, key-metrics-ttm, ratios) using
// a concurrency-limited pool so we don't blow the rate limit in one shot.

const ALPACA_DATA = "https://data.alpaca.markets/v2";
const FMP_BASE    = "https://financialmodelingprep.com/stable";

// ─── Alpaca helpers ────────────────────────────────────────────────────────────

function alpacaHeaders() {
  return {
    "APCA-API-KEY-ID":     process.env.APCA_API_KEY_ID,
    "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY,
  };
}

async function alpacaGet(path, params) {
  const qs = new URLSearchParams(params).toString();
  const r  = await fetch(`${ALPACA_DATA}${path}?${qs}`, { headers: alpacaHeaders() });
  if (!r.ok) throw new Error(`Alpaca ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

const toAlpaca   = s => s.replace("-", ".");
const fromAlpaca = s => s.replace(".", "-");

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// ─── FMP helpers ───────────────────────────────────────────────────────────────

async function fmpGet(path, params = {}) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;
  const qs = new URLSearchParams({ ...params, apikey: key }).toString();
  const r  = await fetch(`${FMP_BASE}${path}?${qs}`);
  if (!r.ok) return null;
  const j = await r.json();
  // FMP returns {"Error Message": "..."} on bad key/quota
  // FMP returns error shapes in both v3 and stable
  if (j?.["Error Message"] || j?.error || j?.message) return null;
  return j;
}

// Run `tasks` (array of () => Promise) with at most `limit` in flight at once
async function pool(tasks, limit = 5) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try { results[i] = await tasks[i](); }
      catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// Fetch fundamental data for a single symbol using FMP stable API (post-Aug 2025).
// Stable endpoints: /stable/profile, /stable/key-metrics-ttm, /stable/ratios
// All use ?symbol=XXX query param (not path segment like v3 did).
// Free tier fields available: pe, eps, price (profile); peRatioTTM, epsTTM,
//   freeCashFlowPerShareTTM (key-metrics-ttm); priceEarningsRatio (ratios annual).
async function fetchFmpFundamentals(symbol) {
  const [profile, metrics, ratios] = await Promise.all([
    fmpGet(`/profile`,         { symbol }),
    fmpGet(`/key-metrics-ttm`, { symbol }),
    fmpGet(`/ratios`,          { symbol, limit: 5 }),
  ]);

  // Stable API returns array directly (same structure as v3)
  const p = Array.isArray(profile) ? profile[0] : null;
  const m = Array.isArray(metrics) ? metrics[0] : null;
  const r = Array.isArray(ratios)  ? ratios      : null;

  // If everything is null, key is invalid or symbol not covered
  if (!p && !m && !r) return null;

  // Trailing P/E — peRatioTTM from key-metrics, fallback to pe from profile
  const pe = m?.peRatioTTM ?? p?.pe ?? null;

  // 5-year average P/E from last 5 annual ratio reports
  let pe5yAvg = null;
  if (r?.length) {
    const peVals = r.map(x => x.priceEarningsRatio)
      .filter(v => v != null && v > 0 && v < 1000);
    if (peVals.length)
      pe5yAvg = +(peVals.reduce((a, b) => a + b, 0) / peVals.length).toFixed(1);
  }

  // EPS TTM
  const eps = m?.epsTTM ?? p?.eps ?? null;

  // FCF yield = freeCashFlowPerShareTTM / current price
  const fcfPerShare  = m?.freeCashFlowPerShareTTM ?? null;
  const currentPrice = p?.price ?? null;
  let fcfYield = null;
  if (fcfPerShare != null && currentPrice != null && currentPrice > 0) {
    fcfYield = +(fcfPerShare / currentPrice).toFixed(4);
  }

  return {
    pe:          pe          != null ? +pe.toFixed(2)          : null,
    pe5yAvg,
    fcfYield:    fcfYield    != null ? fcfYield                 : null,
    fcfPerShare: fcfPerShare != null ? +fcfPerShare.toFixed(2)  : null,
    eps:         eps         != null ? +eps.toFixed(2)          : null,
    fmpLoaded:   true,
  };
}

// ─── Technical indicators ──────────────────────────────────────────────────────

function sma(closes, n) {
  if (closes.length < n) return null;
  return +(closes.slice(-n).reduce((a, b) => a + b, 0) / n).toFixed(2);
}

// RSI-14 using Wilder's simple 14-period seed (good enough for daily bars)
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
  return +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2);
}

// ─── Alpaca bars ───────────────────────────────────────────────────────────────

async function fetchBars252(symbols, feed) {
  const start = new Date(Date.now() - 380 * 86400_000).toISOString().slice(0, 10);
  const results = await Promise.all(
    chunks(symbols.map(toAlpaca), 100).map(batch =>
      alpacaGet("/stocks/bars", {
        symbols:    batch.join(","),
        timeframe:  "1Day",
        start,
        limit:      10000,
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

// ─── Handler ───────────────────────────────────────────────────────────────────

export default async (req) => {
  const url  = new URL(req.url);
  const syms = (url.searchParams.get("symbols") || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const feed = process.env.ALPACA_FEED || "iex";
  const hasFmp = !!process.env.FMP_API_KEY;

  if (!syms.length) {
    return new Response(JSON.stringify({ error: "symbols required" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  try {
    // Fetch Alpaca bars + FMP fundamentals in parallel
    // FMP calls are concurrency-limited to 5 in-flight to respect rate limits
    const [barMap, fmpResults] = await Promise.all([
      fetchBars252(syms, feed),
      hasFmp
        ? pool(syms.map(sym => () => fetchFmpFundamentals(sym)), 5)
        : Promise.resolve(syms.map(() => null)),
    ]);

    const fundamentals = {};
    syms.forEach((sym, i) => {
      const bars = barMap[sym] || [];
      const fmp  = fmpResults[i];

      if (bars.length < 2) { fundamentals[sym] = null; return; }

      const closes  = bars.map(b => b.c);
      const highs   = bars.map(b => b.h);
      const lows    = bars.map(b => b.l);
      const volumes = bars.map(b => b.v);
      const last    = closes[closes.length - 1];
      const high52w = Math.max(...highs);
      const low52w  = Math.min(...lows);

      const adv30 = closes.length >= 30
        ? Math.round(volumes.slice(-30).reduce((a, b) => a + b, 0) / 30)
        : null;

      fundamentals[sym] = {
        // ── Technical (always present) ──
        ma50:           sma(closes, 50),
        ma200:          sma(closes, 200),
        rsi14:          rsi14(closes),
        high52w:        +high52w.toFixed(2),
        low52w:         +low52w.toFixed(2),
        pctFrom52wHigh: last && high52w
          ? +((last - high52w) / high52w * 100).toFixed(2) : null,
        adv30,

        // ── Fundamental (FMP, null if key absent or call failed) ──
        pe:          fmp?.pe          ?? null,
        pe5yAvg:     fmp?.pe5yAvg     ?? null,
        fcfYield:    fmp?.fcfYield    ?? null,
        fcfPerShare: fmp?.fcfPerShare ?? null,
        eps:         fmp?.eps         ?? null,
        fmpLoaded:   fmp?.fmpLoaded   ?? false,

        // ── Raw bars for client charting ──
        bars: bars.map(b => ({ t: b.t, c: b.c, h: b.h, l: b.l, v: b.v })),
      };
    });

    return new Response(JSON.stringify({ fundamentals, hasFmp }), {
      status: 200,
      headers: {
        "content-type":  "application/json",
        "cache-control": "public, max-age=3600",
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
