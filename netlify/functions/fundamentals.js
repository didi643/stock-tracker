// GET /api/fundamentals?symbols=AAPL,MSFT,...&fmp=1
//
// Technical (always — from Alpaca daily bars):
//   ma50, ma200, rsi14, high52w, low52w, pctFrom52wHigh, adv30
//
// Fundamental (FMP, only when ?fmp=1 is passed AND FMP_API_KEY is set):
//   pe, pe5yAvg, fcfYield, eps
//
// FMP free tier = 250 calls/day.
// Rules to stay within quota:
//   1. Only fetch FMP when caller explicitly passes ?fmp=1
//      (frontend only sends this for favorites / detail modal, not bulk loads)
//   2. ONE call per symbol — /stable/profile has pe + eps, that's enough
//   3. Concurrency capped at 3 in-flight at a time

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

// ─── FMP — single call per symbol ─────────────────────────────────────────────

async function fmpProfile(symbol) {
  const key = process.env.FMP_API_KEY;
  if (!key) return null;

  // ONE call: /stable/profile?symbol=AAPL
  // Returns: pe, eps, price, companyName, beta, mktCap, ...
  const qs = new URLSearchParams({ symbol, apikey: key }).toString();
  let r;
  try {
    r = await fetch(`${FMP_BASE}/profile?${qs}`);
  } catch (e) {
    console.error(`FMP fetch error ${symbol}:`, e.message);
    return null;
  }

  // 429 = quota hit — log clearly, return null gracefully
  if (r.status === 429) {
    console.warn(`FMP quota exceeded (429) for ${symbol}`);
    return null;
  }
  if (!r.ok) return null;

  const j = await r.json();
  if (j?.["Error Message"] || j?.error || j?.message) return null;

  const p = Array.isArray(j) ? j[0] : j;
  if (!p) return null;

  // pe from profile, eps from profile
  // FCF yield not available from profile alone — skip, use EPS for DCF
  const pe  = p.pe  != null && p.pe  > 0 ? +Number(p.pe).toFixed(2)  : null;
  const eps = p.eps != null              ? +Number(p.eps).toFixed(2) : null;

  return { pe, pe5yAvg: null, fcfYield: null, eps, fmpLoaded: true };
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
    // Always fetch Alpaca bars; only fetch FMP when explicitly requested
    const [barMap, fmpResults] = await Promise.all([
      fetchBars252(syms, feed),
      wantFmp
        ? pool(syms.map(sym => () => fmpProfile(sym)), 3)
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
        ma50:           sma(closes, 50),
        ma200:          sma(closes, 200),
        rsi14:          rsi14(closes),
        high52w:        +high52w.toFixed(2),
        low52w:         +low52w.toFixed(2),
        pctFrom52wHigh: last && high52w
          ? +((last - high52w) / high52w * 100).toFixed(2) : null,
        adv30,
        pe:          fmp?.pe          ?? null,
        pe5yAvg:     fmp?.pe5yAvg     ?? null,
        fcfYield:    fmp?.fcfYield    ?? null,
        eps:         fmp?.eps         ?? null,
        fmpLoaded:   fmp?.fmpLoaded   ?? false,
        bars:        bars.map(b => ({ t: b.t, c: b.c, h: b.h, l: b.l, v: b.v })),
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
