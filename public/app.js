// Stock Tracker — enhanced with value investing metrics
// Architecture: pure functions in METRICS module → state → render pipeline

const REFRESH_MS  = 30_000;
const FUND_TTL_MS = 3_600_000;   // re-fetch fundamentals every 1h
const FAV_KEY     = "stock-tracker.favorites.v1";
const ALERT_KEY   = "stock-tracker.alerts.v1";
const CFG_KEY     = "stock-tracker.config.v1";

const $ = s => document.querySelector(s);
const fmt  = n => n == null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtI = n => n == null ? "—" : Math.round(n).toLocaleString();

// ─── Default user config (editable in Settings panel) ────────────────────────
const DEFAULT_CFG = {
  discountRate:        0.10,   // WACC / required return
  revenueGrowth:       0.08,   // near-term annual revenue growth assumption
  terminalGrowth:      0.03,   // perpetuity growth rate
  projectionYears:     10,
  marginOfSafetyPct:   25,     // % below fair value to trigger "Strong Buy"
  alertThresholdScore: 70,     // undervaluation score to trigger alert
  alertDropPct:        10,     // % price drop to trigger alert
  rsiOversold:         40,
};

// ─── METRICS MODULE ───────────────────────────────────────────────────────────
// All functions are pure: (price, fundamentals, config) → number | null | string

const M = {

  /** RSI — already computed server-side; just pass through */
  rsi: f => f?.rsi14 ?? null,

  ma50:  f => f?.ma50  ?? null,
  ma200: f => f?.ma200 ?? null,

  /** % drawdown from 52-week high (negative = below high) */
  drawdownFrom52wHigh: f => f?.pctFrom52wHigh ?? null,

  /** % below 200-day MA */
  pctVsMa200: (price, f) => {
    if (price == null || !f?.ma200) return null;
    return +((price - f.ma200) / f.ma200 * 100).toFixed(2);
  },

  // ── DCF Intrinsic Value ─────────────────────────────────────────────────────
  // Uses EPS as a proxy for free cash flow when full FCF data unavailable.
  // Formula: sum(FCF_t / (1+r)^t) + terminal value / (1+r)^n
  // Since we lack EPS from Alpaca free tier, we use a normalized revenue proxy:
  //   assume FCF = price * 0.05 (a 5% FCF yield baseline) as starting point.
  // When real FCF yield is available it's used instead.
  dcfFairValue: (price, f, cfg) => {
    if (price == null) return null;
    const { discountRate: r, revenueGrowth: g, terminalGrowth: tg, projectionYears: n } = cfg;
    if (r <= tg) return null;  // guard: Gordon Growth Model requires r > tg

    // FCF per share: prefer real fcfYield from fundamentals, else 5% yield proxy
    const yieldBase  = f?.fcfYield ?? 0.05;
    let fcf          = price * yieldBase;

    let pv = 0;
    for (let t = 1; t <= n; t++) {
      fcf *= (1 + g);
      pv  += fcf / Math.pow(1 + r, t);
    }
    // Terminal value (Gordon Growth Model)
    const terminalFCF = fcf * (1 + tg);
    const tv          = terminalFCF / (r - tg);
    pv               += tv / Math.pow(1 + r, n);

    return pv > 0 ? +pv.toFixed(2) : null;
  },

  marginOfSafety: (price, fairValue) => {
    if (price == null || fairValue == null || fairValue <= 0) return null;
    return +((fairValue - price) / fairValue * 100).toFixed(1);
  },

  // ── Undervaluation Score 0-100 ──────────────────────────────────────────────
  // Components (each 0-100, then weighted):
  //   40% — margin of safety vs DCF fair value
  //   25% — price vs 52w high (drawdown = discount)
  //   20% — RSI (lower RSI → more undervalued signal)
  //   15% — P/E vs 5y avg P/E (when available)
  undervaluationScore: (price, f, cfg) => {
    const weights = { mos: 0.40, hi52: 0.25, rsi: 0.20, pe: 0.15 };

    // 1. Margin-of-safety component
    const fv  = M.dcfFairValue(price, f, cfg);
    const mos = M.marginOfSafety(price, fv);
    // mos of +25% → 100pts; 0% → 50pts; negative (overvalued) → 0pts
    const mosScore = mos == null ? 50
      : Math.max(0, Math.min(100, 50 + mos * 2));

    // 2. 52-week high component
    // drawdown of -30% → 100pts; 0% → 0pts; above high impossible here
    const dd = M.drawdownFrom52wHigh(f);
    const hi52Score = dd == null ? 50
      : Math.max(0, Math.min(100, -dd * (100 / 40)));  // 40% drop = max score

    // 3. RSI component
    const rsiVal    = M.rsi(f);
    const rsiScore  = rsiVal == null ? 50
      : Math.max(0, Math.min(100, (70 - rsiVal) * (100 / 70)));  // RSI 0→100, RSI 70→0

    // 4. PE component (0 when unavailable → weight redistributed)
    let peScore = null;
    if (f?.pe != null && f?.pe5yAvg != null && f.pe5yAvg > 0) {
      const ratio = f.pe / f.pe5yAvg;
      peScore = Math.max(0, Math.min(100, (1 - ratio) * 100 + 50));
    }

    // Redistribute weight if PE unavailable
    const hasPE = peScore != null;
    const w = hasWeight => hasWeight ? weights : {
      mos: weights.mos + weights.pe * 0.40 / 0.85,
      hi52: weights.hi52 + weights.pe * 0.25 / 0.85,
      rsi:  weights.rsi  + weights.pe * 0.20 / 0.85,
      pe: 0,
    };
    const wt = w(hasPE);

    const score = mosScore * wt.mos
                + hi52Score * wt.hi52
                + rsiScore  * wt.rsi
                + (hasPE ? peScore * wt.pe : 0);

    return Math.round(Math.max(0, Math.min(100, score)));
  },

  // ── Buy Zone Classification ─────────────────────────────────────────────────
  buyZone: (price, f, cfg) => {
    const fv   = M.dcfFairValue(price, f, cfg);
    const mos  = M.marginOfSafety(price, fv);
    const rsi  = M.rsi(f);
    const ma200 = M.ma200(f);

    const belowFairValue = mos != null && mos >= cfg.marginOfSafetyPct;
    const rsiOversold    = rsi != null && rsi < cfg.rsiOversold;
    const belowMa200     = ma200 != null && price < ma200;

    const bullCount = [belowFairValue, rsiOversold, belowMa200].filter(Boolean).length;

    if (bullCount >= 2 && belowFairValue) return "Strong Buy";
    if (bullCount >= 1 || (mos != null && mos > 0)) return "Watch";
    return "Overvalued";
  },
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  universe:      [],
  bySector:      {},
  quotes:        {},
  fundamentals:  {},
  fundFetchedAt: {},
  alerts:        JSON.parse(localStorage.getItem(ALERT_KEY) || "[]"),
  duration:      "1d",
  tab:           "sectors",
  search:        "",
  sortCol:       null,
  sortDir:       1,
  favorites:     new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")),
  cfg:           { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(CFG_KEY) || "{}") },
  timer:         null,
  fundTimer:     null,
};

function saveCfg()    { localStorage.setItem(CFG_KEY,   JSON.stringify(state.cfg)); }
function saveAlerts() { localStorage.setItem(ALERT_KEY, JSON.stringify(state.alerts)); }

// ─── UNIVERSE ─────────────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i+1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

async function loadUniverse() {
  const text = await fetch("./sp500.csv").then(r => r.text());
  const rows = text.replace(/\r/g, "").trim().split("\n").slice(1).map(line => {
    const f = parseCsvLine(line).map(s => s.trim());
    if (f.length < 4) return null;
    return { symbol: f[0], name: f[1], sector: f[2], industry: f[3] };
  }).filter(Boolean);
  state.universe = rows;
  state.bySector = rows.reduce((acc, r) => { (acc[r.sector] ||= []).push(r); return acc; }, {});
}

// ─── DATA FETCHING ────────────────────────────────────────────────────────────
function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchQuotes(symbols) {
  if (!symbols.length) return {};
  const out = {};
  const urls = chunks(symbols, 100).map(c =>
    `/api/quotes?symbols=${c.join(",")}&duration=${state.duration}`);
  const responses = await Promise.all(urls.map(u => fetch(u).then(async r => {
    if (!r.ok) throw new Error(`quotes ${r.status}: ${(await r.text()).slice(0,200)}`);
    return r.json();
  })));
  for (const j of responses) Object.assign(out, j.quotes || {});
  return out;
}

async function fetchFundamentals(symbols) {
  if (!symbols.length) return;
  // Only fetch symbols whose cache is stale
  const stale = symbols.filter(s => {
    const t = state.fundFetchedAt[s];
    return !t || Date.now() - t > FUND_TTL_MS;
  });
  if (!stale.length) return;

  const urls = chunks(stale, 100).map(c =>
    `/api/fundamentals?symbols=${c.join(",")}`);
  const responses = await Promise.all(urls.map(u => fetch(u).then(async r => {
    if (!r.ok) throw new Error(`fundamentals ${r.status}`);
    return r.json();
  })));
  for (const j of responses) {
    for (const [sym, data] of Object.entries(j.fundamentals || {})) {
      state.fundamentals[sym] = data;
      state.fundFetchedAt[sym] = Date.now();
    }
  }
}

function visibleSymbols() {
  if (state.tab === "favorites") return [...state.favorites];
  return state.universe.map(s => s.symbol);
}

async function refresh() {
  const syms = visibleSymbols();
  setStatus("Loading…");
  try {
    const [newQuotes] = await Promise.all([
      fetchQuotes(syms),
      fetchFundamentals(syms),
    ]);
    state.quotes = { ...state.quotes, ...newQuotes };
    checkAlerts();
    render();
    const sample = Object.values(state.quotes).find(q => q);
    const open   = sample?.marketOpen;
    const asOf   = sample?.asOf ? new Date(sample.asOf).toLocaleDateString() : "";
    const tag    = open
      ? `<span class="text-green-600 font-medium">● Live</span>`
      : `<span class="text-amber-600 font-medium">● Closed · ${asOf}</span>`;
    $("#status").innerHTML = `${tag} · ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
}

function setStatus(msg) { $("#status").textContent = msg; }

// ─── ALERTS ───────────────────────────────────────────────────────────────────
function checkAlerts() {
  const now = Date.now();
  for (const s of state.universe) {
    const sym   = s.symbol;
    const q     = state.quotes[sym];
    const f     = state.fundamentals[sym];
    if (!q) continue;

    const price = q.last;
    const score = M.undervaluationScore(price, f, state.cfg);
    const zone  = M.buyZone(price, f, state.cfg);

    const triggers = [];

    if (score >= state.cfg.alertThresholdScore)
      triggers.push(`Undervaluation score ${score}/100`);

    if (zone === "Strong Buy")
      triggers.push(`Entered Strong Buy Zone`);

    if (q.changePct != null && q.changePct <= -state.cfg.alertDropPct)
      triggers.push(`Dropped ${q.changePct.toFixed(1)}% (threshold -${state.cfg.alertDropPct}%)`);

    for (const msg of triggers) {
      // Deduplicate: one alert per sym+msg per day
      const key = `${sym}::${msg}::${new Date().toDateString()}`;
      if (!state.alerts.find(a => a.key === key)) {
        state.alerts.unshift({ key, sym, msg, price, ts: now });
        if (state.alerts.length > 200) state.alerts.pop();
      }
    }
  }
  saveAlerts();
  renderAlertBadge();
}

function renderAlertBadge() {
  const todayAlerts = state.alerts.filter(
    a => Date.now() - a.ts < 86_400_000
  );
  const badge = $("#alert-badge");
  if (!badge) return;
  if (todayAlerts.length) {
    badge.textContent = todayAlerts.length;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// ─── RENDER HELPERS ───────────────────────────────────────────────────────────
const chip = pct => {
  if (pct == null || isNaN(pct)) return `<span class="text-slate-400">—</span>`;
  const cls  = pct > 0 ? "bg-green-100 text-green-800"
             : pct < 0 ? "bg-red-100 text-red-800"
             : "bg-slate-100 text-slate-700";
  const sign = pct > 0 ? "+" : "";
  return `<span class="inline-block px-2 py-0.5 rounded text-xs font-semibold ${cls}">${sign}${pct.toFixed(2)}%</span>`;
};

const zoneChip = zone => {
  if (!zone) return "";
  const cls = zone === "Strong Buy" ? "bg-green-600 text-white"
            : zone === "Watch"      ? "bg-yellow-400 text-slate-900"
            :                         "bg-red-100 text-red-700";
  return `<span class="inline-block px-2 py-0.5 rounded text-xs font-semibold ${cls}">${zone}</span>`;
};

const scoreBar = score => {
  if (score == null) return "—";
  const color = score >= 70 ? "bg-green-500"
              : score >= 45 ? "bg-yellow-400"
              : "bg-red-400";
  return `<div class="flex items-center gap-1">
    <div class="w-16 h-2 bg-slate-200 rounded overflow-hidden">
      <div class="${color} h-full rounded" style="width:${score}%"></div>
    </div>
    <span class="text-xs tabular-nums font-semibold">${score}</span>
  </div>`;
};

const starBtn = sym => {
  const on = state.favorites.has(sym);
  return `<button data-fav="${sym}" class="text-lg leading-none ${on ? "text-yellow-500" : "text-slate-300 hover:text-yellow-400"}">★</button>`;
};

function metricFor(sym) {
  const q     = state.quotes[sym];
  const f     = state.fundamentals[sym];
  const price = q?.last ?? null;
  return {
    price,
    changePct: q?.changePct ?? null,
    rsi:       M.rsi(f),
    ma50:      M.ma50(f),
    ma200:     M.ma200(f),
    drawdown:  M.drawdownFrom52wHigh(f),
    fairValue: M.dcfFairValue(price, f, state.cfg),
    mos:       M.marginOfSafety(price, M.dcfFairValue(price, f, state.cfg)),
    score:     M.undervaluationScore(price, f, state.cfg),
    zone:      M.buyZone(price, f, state.cfg),
    high52w:   f?.high52w ?? null,
    low52w:    f?.low52w  ?? null,
  };
}

// ─── SUMMARY CARDS ────────────────────────────────────────────────────────────
function renderSummaryCards() {
  const scored = state.universe.map(s => {
    const m = metricFor(s.symbol);
    return { ...s, ...m };
  }).filter(s => s.score != null);

  scored.sort((a, b) => b.score - a.score);
  const top5 = scored.slice(0, 5);

  const strongBuys = scored.filter(s => s.zone === "Strong Buy").length;
  const watches    = scored.filter(s => s.zone === "Watch").length;
  const todayAlerts = state.alerts.filter(a => Date.now() - a.ts < 86_400_000).length;

  const topRows = top5.map(s => `
    <tr class="border-b last:border-0 hover:bg-green-50 cursor-pointer" data-symbol="${s.symbol}">
      <td class="py-1.5 px-2 font-mono font-bold text-sm">${s.symbol}</td>
      <td class="py-1.5 px-2 text-xs text-slate-500 truncate max-w-[120px]">${s.name}</td>
      <td class="py-1.5 px-2 text-right font-mono text-sm">$${fmt(s.price)}</td>
      <td class="py-1.5 px-2">${scoreBar(s.score)}</td>
      <td class="py-1.5 px-2">${zoneChip(s.zone)}</td>
    </tr>`).join("");

  return `
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
    <div class="bg-white rounded shadow-sm p-4">
      <p class="text-xs text-slate-500 uppercase tracking-wide mb-1">Strong Buy Zones</p>
      <p class="text-3xl font-bold text-green-600">${strongBuys}</p>
      <p class="text-xs text-slate-400 mt-1">${watches} in Watch Zone</p>
    </div>
    <div class="bg-white rounded shadow-sm p-4">
      <p class="text-xs text-slate-500 uppercase tracking-wide mb-1">Stocks Analyzed</p>
      <p class="text-3xl font-bold">${scored.length}</p>
      <p class="text-xs text-slate-400 mt-1">w/ fundamentals loaded</p>
    </div>
    <div class="bg-white rounded shadow-sm p-4 cursor-pointer hover:bg-slate-50" id="alerts-card">
      <p class="text-xs text-slate-500 uppercase tracking-wide mb-1">Today's Alerts</p>
      <p class="text-3xl font-bold text-amber-600">${todayAlerts}</p>
      <p class="text-xs text-slate-400 mt-1">click to view</p>
    </div>
  </div>
  <div class="bg-white rounded shadow-sm mb-4">
    <div class="p-3 border-b flex items-center gap-2">
      <span class="font-semibold text-sm">🏆 Top 5 Undervalued Opportunities</span>
      <span class="text-xs text-slate-400">(by undervaluation score)</span>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <tbody>${topRows || '<tr><td colspan="5" class="p-4 text-slate-400 text-sm">Loading fundamentals…</td></tr>'}</tbody>
      </table>
    </div>
  </div>`;
}

// ─── TABLE ROWS ───────────────────────────────────────────────────────────────
function rowHtml(s, showValue = false) {
  const m = metricFor(s.symbol);
  if (!showValue) {
    return `
    <tr class="border-b hover:bg-slate-50 cursor-pointer" data-symbol="${s.symbol}">
      <td class="py-2 px-2">${starBtn(s.symbol)}</td>
      <td class="py-2 px-2 font-mono font-semibold">${s.symbol}</td>
      <td class="py-2 px-2 text-sm text-slate-600 truncate max-w-xs">${s.name}</td>
      <td class="py-2 px-2 text-right font-mono">$${fmt(m.price)}</td>
      <td class="py-2 px-2 text-right">${chip(m.changePct)}</td>
      <td class="py-2 px-2 text-xs text-slate-500">${s.industry}</td>
    </tr>`;
  }

  // Value-enhanced row
  const rsiCls = m.rsi == null ? "" : m.rsi < 30 ? "text-green-700 font-bold"
               : m.rsi < 40 ? "text-green-600" : m.rsi > 70 ? "text-red-600" : "";
  const maVsMa200Cls = m.price != null && m.ma200 != null
    ? (m.price < m.ma200 ? "text-green-600" : "text-red-500") : "";

  return `
    <tr class="border-b hover:bg-slate-50 cursor-pointer" data-symbol="${s.symbol}">
      <td class="py-2 px-2">${starBtn(s.symbol)}</td>
      <td class="py-2 px-2 font-mono font-semibold">${s.symbol}</td>
      <td class="py-2 px-2 text-sm text-slate-600 truncate max-w-[140px]">${s.name}</td>
      <td class="py-2 px-2 text-right font-mono text-sm">$${fmt(m.price)}</td>
      <td class="py-2 px-2 text-right">${chip(m.changePct)}</td>
      <td class="py-2 px-2 text-center">${scoreBar(m.score)}</td>
      <td class="py-2 px-2 text-center">${zoneChip(m.zone)}</td>
      <td class="py-2 px-2 text-right font-mono text-sm ${rsiCls}">${m.rsi ?? "—"}</td>
      <td class="py-2 px-2 text-right font-mono text-xs ${maVsMa200Cls}">$${fmt(m.ma200)}</td>
      <td class="py-2 px-2 text-right font-mono text-sm">${m.drawdown != null ? m.drawdown.toFixed(1)+"%" : "—"}</td>
      <td class="py-2 px-2 text-right font-mono text-sm">${m.mos != null ? m.mos.toFixed(1)+"%" : "—"}</td>
      <td class="py-2 px-2 text-right font-mono text-sm">$${fmt(m.fairValue)}</td>
    </tr>`;
}

function tableHtml(stocks, showValue = false) {
  const filtered = filterBySearch(stocks);
  if (!filtered.length) return `<p class="text-slate-500 text-sm p-4">No stocks.</p>`;

  const baseHeaders = `
    <th class="py-2 px-2"></th>
    <th class="py-2 px-2">Ticker</th>
    <th class="py-2 px-2">Name</th>
    <th class="py-2 px-2 text-right">Price</th>
    <th class="py-2 px-2 text-right">Change</th>`;
  const valueHeaders = showValue ? `
    <th class="py-2 px-2 text-center">Score</th>
    <th class="py-2 px-2 text-center">Zone</th>
    <th class="py-2 px-2 text-right">RSI</th>
    <th class="py-2 px-2 text-right">MA200</th>
    <th class="py-2 px-2 text-right">Drawdown</th>
    <th class="py-2 px-2 text-right">MoS%</th>
    <th class="py-2 px-2 text-right">Fair Value</th>` : `<th class="py-2 px-2">Industry</th>`;

  return `
    <table class="w-full text-sm">
      <thead class="text-left text-xs uppercase text-slate-500 border-b">
        <tr>${baseHeaders}${valueHeaders}</tr>
      </thead>
      <tbody>${filtered.map(s => rowHtml(s, showValue)).join("")}</tbody>
    </table>`;
}

function filterBySearch(stocks) {
  const q = state.search.toLowerCase();
  if (!q) return stocks;
  return stocks.filter(s =>
    s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
}

function sectorAggregate(stocks) {
  const vals = stocks.map(s => state.quotes[s.symbol]?.changePct).filter(v => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ─── TAB RENDERERS ────────────────────────────────────────────────────────────
function renderSectors() {
  const summary = renderSummaryCards();
  const sectors = Object.keys(state.bySector).sort();
  const cards   = sectors.map(sec => {
    const stocks  = state.bySector[sec];
    const avg     = sectorAggregate(stocks);
    const winners = stocks.filter(s => (state.quotes[s.symbol]?.changePct ?? 0) > 0).length;
    return `
      <details class="bg-white rounded shadow-sm">
        <summary class="cursor-pointer p-3 flex items-center gap-3 list-none">
          <span class="font-semibold flex-1">${sec}</span>
          <span class="text-xs text-slate-500">${stocks.length} stocks · ${winners} up</span>
          ${chip(avg)}
        </summary>
        <div class="overflow-x-auto">${tableHtml(stocks)}</div>
      </details>`;
  }).join("");
  $("#content").innerHTML = `${summary}<div class="space-y-2">${cards}</div>`;
  bindSummaryEvents();
}

function renderFavorites() {
  const stocks = state.universe.filter(s => state.favorites.has(s.symbol));
  if (!stocks.length) {
    $("#content").innerHTML = `<p class="text-slate-500 p-8 text-center">No favorites yet. Click ★ next to any stock to add.</p>`;
    return;
  }
  const groups = stocks.reduce((acc, s) => { (acc[s.sector] ||= []).push(s); return acc; }, {});
  $("#content").innerHTML = Object.entries(groups).map(([sec, list]) => `
    <section class="bg-white rounded shadow-sm mb-3">
      <div class="p-3 flex items-center gap-3 border-b">
        <span class="font-semibold flex-1">${sec}</span>
        ${chip(sectorAggregate(list))}
      </div>
      <div class="overflow-x-auto">${tableHtml(list, true)}</div>
    </section>`).join("");
}

function renderAll() {
  $("#content").innerHTML = `<div class="bg-white rounded shadow-sm overflow-x-auto">${tableHtml(state.universe)}</div>`;
}

function renderValue() {
  // Sort by score desc by default
  const scored = [...state.universe].map(s => {
    const m = metricFor(s.symbol);
    return { ...s, ...m };
  });
  scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const filtered = filterBySearch(scored).slice(0, 200); // cap for perf
  if (!filtered.length) {
    $("#content").innerHTML = `<p class="text-slate-500 p-8 text-center">No data yet. Fundamentals load in the background.</p>`;
    return;
  }

  const rows = filtered.map(s => rowHtml(s, true)).join("");
  $("#content").innerHTML = `
    <div class="bg-white rounded shadow-sm overflow-x-auto">
      <div class="p-3 border-b text-xs text-slate-500">
        Top stocks by undervaluation score. Fundamentals refresh hourly. DCF uses configurable assumptions.
        <button id="open-settings" class="ml-2 underline text-blue-600">Edit assumptions →</button>
      </div>
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase text-slate-500 border-b">
          <tr>
            <th class="py-2 px-2"></th>
            <th class="py-2 px-2">Ticker</th>
            <th class="py-2 px-2">Name</th>
            <th class="py-2 px-2 text-right">Price</th>
            <th class="py-2 px-2 text-right">Change</th>
            <th class="py-2 px-2 text-center">Score</th>
            <th class="py-2 px-2 text-center">Zone</th>
            <th class="py-2 px-2 text-right">RSI</th>
            <th class="py-2 px-2 text-right">MA200</th>
            <th class="py-2 px-2 text-right">Drawdown</th>
            <th class="py-2 px-2 text-right">MoS%</th>
            <th class="py-2 px-2 text-right">Fair Value</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  document.getElementById("open-settings")?.addEventListener("click", openSettings);
}

function renderAlerts() {
  const items = state.alerts.slice(0, 100);
  if (!items.length) {
    $("#content").innerHTML = `<p class="text-slate-500 p-8 text-center">No alerts yet. Alerts appear when stocks hit your configured thresholds.</p>`;
    return;
  }
  const rows = items.map(a => `
    <tr class="border-b hover:bg-slate-50 cursor-pointer" data-symbol="${a.sym}">
      <td class="py-2 px-3 font-mono font-bold text-sm">${a.sym}</td>
      <td class="py-2 px-3 text-sm">${a.msg}</td>
      <td class="py-2 px-3 text-right font-mono text-sm">$${fmt(a.price)}</td>
      <td class="py-2 px-3 text-xs text-slate-400">${new Date(a.ts).toLocaleString()}</td>
    </tr>`).join("");
  $("#content").innerHTML = `
    <div class="bg-white rounded shadow-sm overflow-x-auto">
      <div class="p-3 border-b flex items-center gap-3">
        <span class="font-semibold">Alerts</span>
        <button id="clear-alerts" class="ml-auto text-xs text-red-500 hover:underline">Clear all</button>
      </div>
      <table class="w-full text-sm">
        <thead class="text-left text-xs uppercase text-slate-500 border-b">
          <tr>
            <th class="py-2 px-3">Symbol</th>
            <th class="py-2 px-3">Trigger</th>
            <th class="py-2 px-3 text-right">Price</th>
            <th class="py-2 px-3">Time</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  document.getElementById("clear-alerts")?.addEventListener("click", () => {
    state.alerts = [];
    saveAlerts();
    renderAlerts();
    renderAlertBadge();
  });
}

function render() {
  if      (state.tab === "favorites") renderFavorites();
  else if (state.tab === "all")       renderAll();
  else if (state.tab === "value")     renderValue();
  else if (state.tab === "alerts")    renderAlerts();
  else                                 renderSectors();
}

function bindSummaryEvents() {
  document.getElementById("alerts-card")?.addEventListener("click", () => {
    switchTab("alerts");
  });
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.classList.toggle("border-blue-600",  b.dataset.tab === tab);
    b.classList.toggle("border-transparent", b.dataset.tab !== tab);
  });
  render();
}

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────────
function openSettings() {
  const c = state.cfg;
  document.getElementById("settings-modal").innerHTML = `
    <div class="bg-white rounded-lg max-w-md w-full p-6">
      <div class="flex items-center justify-between mb-4">
        <h2 class="text-lg font-bold">DCF & Alert Settings</h2>
        <button id="settings-close" class="text-2xl px-2">&times;</button>
      </div>
      <div class="space-y-3 text-sm">
        ${cfgField("discountRate",        "Discount Rate (WACC)",          c.discountRate,        "0.01", "0.30", "0.01", "e.g. 0.10 = 10%")}
        ${cfgField("revenueGrowth",       "Revenue Growth Rate",           c.revenueGrowth,       "0.01", "0.40", "0.01", "e.g. 0.08 = 8%")}
        ${cfgField("terminalGrowth",      "Terminal Growth Rate",          c.terminalGrowth,      "0.00", "0.05", "0.01", "e.g. 0.03 = 3%")}
        ${cfgField("projectionYears",     "Projection Years",              c.projectionYears,     "3",    "20",   "1",    "")}
        ${cfgField("marginOfSafetyPct",   "Margin of Safety % (Strong Buy)", c.marginOfSafetyPct, "5",    "50",   "5",    "e.g. 25 = price ≥25% below fair value")}
        ${cfgField("alertThresholdScore", "Alert: Underval. Score ≥",      c.alertThresholdScore, "50",   "100",  "5",    "")}
        ${cfgField("alertDropPct",        "Alert: Price Drop % ≥",         c.alertDropPct,        "3",    "50",   "1",    "")}
        ${cfgField("rsiOversold",         "RSI Oversold Threshold",        c.rsiOversold,         "20",   "50",   "1",    "")}
      </div>
      <div class="mt-4 flex gap-2">
        <button id="settings-save" class="flex-1 bg-slate-800 text-white rounded py-2 text-sm">Save</button>
        <button id="settings-reset" class="px-4 border rounded py-2 text-sm text-slate-600">Reset</button>
      </div>
    </div>`;
  document.getElementById("settings-modal").classList.remove("hidden");
  document.getElementById("settings-modal").classList.add("flex");

  document.getElementById("settings-close").addEventListener("click", closeSettings);
  document.getElementById("settings-save").addEventListener("click", () => {
    const fields = ["discountRate","revenueGrowth","terminalGrowth","projectionYears",
                    "marginOfSafetyPct","alertThresholdScore","alertDropPct","rsiOversold"];
    for (const f of fields) {
      const el = document.getElementById(`cfg-${f}`);
      if (el) state.cfg[f] = +el.value;
    }
    saveCfg();
    closeSettings();
    render();
  });
  document.getElementById("settings-reset").addEventListener("click", () => {
    state.cfg = { ...DEFAULT_CFG };
    saveCfg();
    closeSettings();
    render();
  });
}

function cfgField(key, label, value, min, max, step, hint) {
  return `
    <label class="block">
      <span class="text-slate-700">${label}</span>
      ${hint ? `<span class="text-slate-400 text-xs ml-1">${hint}</span>` : ""}
      <input id="cfg-${key}" type="number" min="${min}" max="${max}" step="${step}"
             value="${value}"
             class="mt-1 block w-full border rounded px-2 py-1 text-sm bg-white" />
    </label>`;
}

function closeSettings() {
  document.getElementById("settings-modal").classList.add("hidden");
  document.getElementById("settings-modal").classList.remove("flex");
}

// ─── DETAIL MODAL ─────────────────────────────────────────────────────────────
let chart = null;
async function openDetail(symbol) {
  const stock = state.universe.find(s => s.symbol === symbol);
  if (!stock) return;
  const q = state.quotes[symbol];
  const m = metricFor(symbol);

  $("#m-symbol").textContent = symbol;
  $("#m-name").textContent   = `${stock.name} · ${stock.sector} / ${stock.industry}`;
  $("#m-price").textContent  = q ? `$${fmt(q.last)}` : "—";
  $("#m-change").innerHTML   = chip(q?.changePct);

  // Metrics grid
  document.getElementById("m-metrics").innerHTML = `
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 my-3 text-sm">
      ${metricCard("Score",      scoreBar(m.score))}
      ${metricCard("Zone",       zoneChip(m.zone))}
      ${metricCard("RSI-14",     m.rsi != null ? m.rsi : "—")}
      ${metricCard("MA 50",      "$"+fmt(m.ma50))}
      ${metricCard("MA 200",     "$"+fmt(m.ma200))}
      ${metricCard("52w High",   "$"+fmt(m.high52w))}
      ${metricCard("Drawdown",   m.drawdown != null ? m.drawdown.toFixed(1)+"%" : "—")}
      ${metricCard("Fair Value", "$"+fmt(m.fairValue))}
      ${metricCard("Margin of Safety", m.mos != null ? m.mos.toFixed(1)+"%" : "—")}
    </div>`;

  $("#modal").classList.remove("hidden");

  const r = await fetch(`/api/bars?symbol=${symbol}&duration=${state.duration}`);
  const j = await r.json();
  const bars = j.bars || [];
  if (chart) chart.destroy();
  const ctx = document.getElementById("m-chart").getContext("2d");
  const up  = bars.length > 1 && bars.at(-1).c >= bars[0].c;
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels:   bars.map(b => b.t),
      datasets: [{
        data:            bars.map(b => b.c),
        borderColor:     up ? "#16a34a" : "#dc2626",
        backgroundColor: up ? "rgba(22,163,74,0.1)" : "rgba(220,38,38,0.1)",
        fill: true, tension: 0.2, pointRadius: 0, borderWidth: 2,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, callback: (_, i) => bars[i] ? new Date(bars[i].t).toLocaleDateString() : "" } },
        y: { ticks: { callback: v => `$${v}` } },
      },
    },
  });
}

function metricCard(label, value) {
  return `
    <div class="bg-slate-50 rounded p-2">
      <p class="text-xs text-slate-500 mb-1">${label}</p>
      <div class="font-semibold">${value}</div>
    </div>`;
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────
function bindEvents() {
  $("#duration").addEventListener("change", e => { state.duration = e.target.value; refresh(); });
  $("#refresh").addEventListener("click", refresh);
  $("#search").addEventListener("input", e => { state.search = e.target.value; render(); });
  $("#settings-btn").addEventListener("click", openSettings);

  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.addEventListener("click", e => {
    const fav = e.target.closest("[data-fav]");
    if (fav) {
      e.stopPropagation();
      const sym = fav.dataset.fav;
      state.favorites.has(sym) ? state.favorites.delete(sym) : state.favorites.add(sym);
      localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites]));
      render(); return;
    }
    const row = e.target.closest("[data-symbol]");
    if (row && !row.closest("#modal") && !row.closest("#settings-modal")) {
      openDetail(row.dataset.symbol);
    }
  });

  $("#m-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#modal").addEventListener("click", e => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); });
  document.getElementById("settings-modal").addEventListener("click", e => {
    if (e.target.id === "settings-modal") closeSettings();
  });
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
(async () => {
  bindEvents();
  await loadUniverse();
  render();
  await refresh();
  state.timer     = setInterval(refresh, REFRESH_MS);
  state.fundTimer = setInterval(() => fetchFundamentals(visibleSymbols()), FUND_TTL_MS);
})();
