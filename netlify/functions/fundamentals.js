// GET /api/fundamentals?symbols=AAPL,MSFT,...&fmp=1
//
// Technical (always — from Alpaca daily bars):
//   ma50, ma200, rsi14, high52w, low52w, pctFrom52wHigh, adv30
//
// Fundamental (FMP, only when ?fmp=1 AND FMP_API_KEY set):
//   pe, eps, bookValue, pbRatio, evEbitda, dividendYield,
//   revenueGrowthYoy, earningsGrowthYoy, debtToEquity, roe, currentRatio,
//   grossMargin, operatingMargin, mktCap, beta
//
// FMP free tier = 250 calls/day.
// Strategy: 2 calls per symbol (profile + ratios) — keep concurrency ≤ 3.
//   /stable/profile  → pe, eps, mktCap, beta, dividendYield, bookValue, pbRatio
//   /stable/ratios   → evEbitda, grossMargin, operatingMargin, roe, debtToEquity, currentRatio

const ALPACA_DATA = "https://data.alpaca.markets/v2";
const FMP_BASE    = "https://financialmodelingprep.com/stable";

// ─── Alpaca ───────────────────────────────────────────────────────────────────

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

// ─── FMP helpers ──────────────────────────────────────────────────────────────

function safeNum(v, decimals = 2) {
  const n = Number(v);
  return isFinite(n) && n !== 0 ? +n.toFixed(decimals) : null;
}

async function fmpGet(endpoint, symbol, key) {
  const qs = new URLSearchParams({ symbol, apikey: key }).toString();
  try {
    const r = await fetch(`${FMP_BASE}/${endpoint}?${qs}`);
    if (r.status === 429) { console.warn(`FMP quota 429 ${symbol} ${endpoint}`); return null; }
    if (!r.ok) return null;
    const j = await r.json();
    if (j?.["Error Message"] || j?.error) return null;
    return Array.isArray(j) ? j[0] : j;
  } catch (e) {
    console.error(`FMP ${endpoint} ${symbol}:`, e.message);
    return null;
  }
}

// Fetch profile + ratios (TTM) in parallel for one symbol — 2 FMP calls total
async function fmpFull(symbol) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;

  const [profile, ratios] = await Promise.all([
    fmpGet("profile",       symbol, key),
    fmpGet("ratios-ttm",    symbol, key),
  ]);

  if (!profile && !ratios) return null;

  const p = profile  || {};
  const r = ratios   || {};

  // Revenue / earnings growth from profile (YoY %)
  // FMP profile has revenueGrowth and earningsGrowth (as decimals)
  const revenueGrowthYoy  = safeNum(p.revenueGrowthYoy  ?? p.revenueGrowth,  4);
  const earningsGrowthYoy = safeNum(p.earningsGrowthYoy ?? p.earningsGrowth, 4);

  return {
    // Core valuation
    pe:              safeNum(p.pe   > 0 ? p.pe : null),
    pe5yAvg:         null,                              // not on free tier
    eps:             safeNum(p.eps),
    bookValue:       safeNum(p.bookValuePerShare ?? p.bookValue),
    pbRatio:         safeNum(r.priceToBookRatioTTM ?? p.priceToBookRatio),
    evEbitda:        safeNum(r.enterpriseValueMultipleTTM ?? r.evToEbitda),
    dividendYield:   safeNum(p.lastDiv > 0 && p.price > 0 ? p.lastDiv / p.price : (p.dividendYield ?? null), 4),
    mktCap:          safeNum(p.mktCap, 0),
    beta:            safeNum(p.beta, 3),

    // Quality / safety
    roe:             safeNum(r.returnOnEquityTTM ?? r.roe),
    debtToEquity:    safeNum(r.debtEquityRatioTTM ?? r.debtToEquity),
    currentRatio:    safeNum(r.currentRatioTTM ?? r.currentRatio),
    grossMargin:     safeNum(r.grossProfitMarginTTM ?? r.grossMargin),
    operatingMargin: safeNum(r.operatingProfitMarginTTM ?? r.operatingMargin),
    fcfYield:        safeNum(r.freeCashFlowYieldTTM ?? null, 4),

    // Growth
    revenueGrowthYoy,
    earningsGrowthYoy,

    fmpLoaded: true,
  };
}

// Concurrency pool
async function pool(tasks, limit = 3) {
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

// ─── Technical indicators ─────────────────────────────────────────────────────

function sma(closes, n) {
  if (closes.length < n) return null;
  return +(closes.slice(-n).reduce((a, b) => a + b, 0) / n).toFixed(2);
}

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

// ─── Alpaca bars ──────────────────────────────────────────────────────────────

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

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async (req) => {
  const url     = new URL(req.url);
  const syms    = (url.searchParams.get("symbols") || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const feed    = process.env.ALPACA_FEED || "iex";
  const wantFmp = url.searchParams.get("fmp") === "1" && !!process.env.FMP_API_KEY;

  if (!syms.length) {
    return new Response(JSON.stringify({ error: "symbols required" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  try {
    const [barMap, fmpResults] = await Promise.all([
      fetchBars252(syms, feed),
      wantFmp
        ? pool(syms.map(sym => () => fmpFull(sym)), 3)
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
      const adv30   = closes.length >= 30
        ? Math.round(volumes.slice(-30).reduce((a, b) => a + b, 0) / 30)
        : null;

      fundamentals[sym] = {
        // Technical
        ma50:           sma(closes, 50),
        ma200:          sma(closes, 200),
        rsi14:          rsi14(closes),
        high52w:        +high52w.toFixed(2),
        low52w:         +low52w.toFixed(2),
        pctFrom52wHigh: last && high52w
          ? +((last - high52w) / high52w * 100).toFixed(2) : null,
        adv30,
        // FMP fundamentals (null when not loaded)
        pe:                  fmp?.pe                  ?? null,
        pe5yAvg:             fmp?.pe5yAvg             ?? null,
        fcfYield:            fmp?.fcfYield            ?? null,
        eps:                 fmp?.eps                 ?? null,
        bookValue:           fmp?.bookValue           ?? null,
        pbRatio:             fmp?.pbRatio             ?? null,
        evEbitda:            fmp?.evEbitda            ?? null,
        dividendYield:       fmp?.dividendYield       ?? null,
        mktCap:              fmp?.mktCap              ?? null,
        beta:                fmp?.beta                ?? null,
        roe:                 fmp?.roe                 ?? null,
        debtToEquity:        fmp?.debtToEquity        ?? null,
        currentRatio:        fmp?.currentRatio        ?? null,
        grossMargin:         fmp?.grossMargin         ?? null,
        operatingMargin:     fmp?.operatingMargin     ?? null,
        revenueGrowthYoy:    fmp?.revenueGrowthYoy    ?? null,
        earningsGrowthYoy:   fmp?.earningsGrowthYoy   ?? null,
        fmpLoaded:           fmp?.fmpLoaded           ?? false,
        bars:                bars.map(b => ({ t: b.t, c: b.c, h: b.h, l: b.l, v: b.v })),
      };
    });

    return new Response(JSON.stringify({ fundamentals }), {
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
