// Stock Tracker — enhanced with value investing metrics
// Architecture: pure functions in METRICS module → state → render pipeline

const REFRESH_MS  = 30_000;
const FUND_TTL_MS = 3_600_000;   // re-fetch fundamentals every 1h
const NEWS_TTL_MS = 900_000;     // re-fetch news every 15 min
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
  // Priority for FCF starting point (best → fallback):
  //   1. Real FCF yield from FMP  → fcfYield * price  (most accurate)
  //   2. Real EPS from FMP        → use EPS directly as FCF proxy
  //   3. 5% yield proxy           → price * 0.05      (rough estimate, labelled)
  // Formula: PV = Σ FCF_t/(1+r)^t  +  terminal_value/(1+r)^n
  dcfFairValue: (price, f, cfg) => {
    if (price == null) return null;
    const { discountRate: r, revenueGrowth: g, terminalGrowth: tg, projectionYears: n } = cfg;
    if (r <= tg) return null;  // guard: Gordon Growth Model requires r > tg

    // FCF per share: best available input
    let fcf;
    if (f?.fcfYield != null && f.fcfYield > 0) {
      fcf = price * f.fcfYield;          // real FCF yield × price
    } else if (f?.eps != null && f.eps > 0) {
      fcf = f.eps;                        // EPS as FCF proxy
    } else {
      fcf = price * 0.05;                 // 5% yield fallback
    }

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
  //   35% — margin of safety vs DCF fair value
  //   22% — price vs 52w high (drawdown = discount)
  //   18% — RSI (lower RSI → more undervalued signal)
  //   15% — P/E vs 5y avg P/E (when available)
  //   10% — news sentiment (positive news = higher score)
  undervaluationScore: (price, f, cfg, sentimentScore) => {
    const weights = { mos: 0.35, hi52: 0.22, rsi: 0.18, pe: 0.15, sent: 0.10 };

    // 1. Margin-of-safety component
    const fv  = M.dcfFairValue(price, f, cfg);
    const mos = M.marginOfSafety(price, fv);
    const mosScore = mos == null ? 50
      : Math.max(0, Math.min(100, 50 + mos * 2));

    // 2. 52-week high component
    const dd = M.drawdownFrom52wHigh(f);
    const hi52Score = dd == null ? 50
      : Math.max(0, Math.min(100, -dd * (100 / 40)));

    // 3. RSI component
    const rsiVal   = M.rsi(f);
    const rsiScore = rsiVal == null ? 50
      : Math.max(0, Math.min(100, (70 - rsiVal) * (100 / 70)));

    // 4. PE component (null → weight redistributed)
    let peScore = null;
    if (f?.pe != null && f?.pe5yAvg != null && f.pe5yAvg > 0) {
      const ratio = f.pe / f.pe5yAvg;
      peScore = Math.max(0, Math.min(100, (1 - ratio) * 100 + 50));
    }

    // 5. Sentiment component: score -1→+1 mapped to 0→100
    // Positive sentiment means market attention is constructive → mild boost.
    // Negative sentiment → penalise (could signal deteriorating fundamentals).
    let sentScore = null;
    if (sentimentScore != null) {
      sentScore = Math.max(0, Math.min(100, (sentimentScore + 1) * 50));
    }

    // Redistribute weights for unavailable components
    const hasPE   = peScore  != null;
    const hasSent = sentScore != null;
    const missing = (!hasPE ? weights.pe : 0) + (!hasSent ? weights.sent : 0);
    const active  = 1 - missing;
    const scale   = active > 0 ? 1 / active : 1;

    const score = (mosScore  * weights.mos
                 + hi52Score * weights.hi52
                 + rsiScore  * weights.rsi
                 + (hasPE   ? peScore   * weights.pe   : 0)
                 + (hasSent ? sentScore * weights.sent : 0)) * scale;

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
  news:          {},   // symbol -> { articles, sentimentScore }
  newsFetchedAt: {},
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

async function fetchFundamentals(symbols, { wantFmp = false } = {}) {
  if (!symbols.length) return;
  const stale = symbols.filter(s => {
    const t = state.fundFetchedAt[s];
    if (!t || Date.now() - t > FUND_TTL_MS) return true;
    // Re-fetch if FMP was missing last time AND caller now wants FMP data
    if (wantFmp && state.fundamentals[s] && !state.fundamentals[s].fmpLoaded) return true;
    return false;
  });
  if (!stale.length) return;

  // Only attach ?fmp=1 when explicitly requested (favorites / detail modal)
  // This keeps bulk loads (all 500 S&P stocks) free of FMP calls
  const fmpFlag = wantFmp ? "&fmp=1" : "";
  const urls = chunks(stale, 100).map(c =>
    `/api/fundamentals?symbols=${c.join(",")}${fmpFlag}`);
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

async function fetchNews(symbols) {
  if (!symbols.length) return;
  const stale = symbols.filter(s => {
    const t = state.newsFetchedAt[s];
    return !t || Date.now() - t > NEWS_TTL_MS;
  });
  if (!stale.length) return;
  // Batch 10 at a time (Alpaca news limit per call)
  const urls = chunks(stale, 10).map(c =>
    `/api/news?symbols=${c.join(",")}&limit=10`);
  const responses = await Promise.allSettled(
    urls.map(u => fetch(u).then(r => r.ok ? r.json() : null))
  );
  for (const res of responses) {
    if (res.status !== "fulfilled" || !res.value) continue;
    for (const [sym, data] of Object.entries(res.value.news || {})) {
      state.news[sym] = data;
      state.newsFetchedAt[sym] = Date.now();
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
    // wantFmp only for favorites — bulk S&P load skips FMP to protect quota
    const isFavoritesView = state.tab === "favorites";
    const [newQuotes] = await Promise.all([
      fetchQuotes(syms),
      fetchFundamentals(syms, { wantFmp: isFavoritesView }),
      fetchNews(syms),
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

// ─── TOOLTIPS ─────────────────────────────────────────────────────────────────
// Each tooltip explains the metric in plain English for beginners.
const TIPS = {
  price:     "The current trading price of one share of this stock.",
  change:    "How much the price has moved (%) over the selected time period. Green = up, red = down.",
  score:     "Our overall 'how undervalued is this stock?' score from 0–100. Higher = more potentially undervalued. It combines fair value, price drop from its high, RSI, and news sentiment.",
  zone:      "Strong Buy = multiple signals say the stock looks cheap. Watch = one or two signals. Overvalued = price looks high relative to our model.",
  rsi:       "RSI (Relative Strength Index) measures momentum on a 0–100 scale. Below 40 = possibly oversold (a buying opportunity). Above 70 = possibly overbought. Around 50 = neutral.",
  ma200:     "The average closing price over the last 200 trading days (~10 months). If today's price is below this line, the stock is in a long-term downtrend — which can signal a discount.",
  ma50:      "The average closing price over the last 50 trading days (~2.5 months). Compared with MA200 to spot medium-term trends.",
  drawdown:  "How far the price has fallen from its 52-week (1 year) high. A -20% drawdown means the stock is 20% cheaper than its recent peak.",
  fairValue: "Our estimated 'true worth' per share using a DCF (Discounted Cash Flow) model. If the fair value is higher than the current price, the stock may be undervalued. This is a model estimate — not a guarantee.",
  mos:       "Margin of Safety = how much cheaper the stock is vs our fair value estimate. A 25% margin means the stock trades 25% below fair value — a buffer in case our estimate is off.",
  pe:        "Price-to-Earnings ratio. Tells you how much investors pay for each $1 of profit. A PE of 15 means the stock costs 15× its annual earnings. Lower PE can mean better value.",
  pe5yAvg:   "The average PE ratio over the last 5 years. Comparing today's PE to this average shows whether the stock is cheap or expensive relative to its own history.",
  fcfYield:  "Free Cash Flow Yield = how much free cash the company generates per dollar of share price. Higher is generally better (more cash returned to shareholders).",
  eps:       "Earnings Per Share — the company's profit divided by the number of shares. Growing EPS over time is a sign of a healthy business.",
  sentiment: "Based on the tone of recent news articles. Positive news can support price momentum; negative news may signal upcoming headwinds.",
  high52w:   "The highest price the stock reached in the last 52 weeks (1 year). Useful to see how far it has fallen from its recent peak.",
  low52w:    "The lowest price in the last 52 weeks. The current price relative to this shows where we are in the stock's recent range.",
};

function tip(key) {
  const text = TIPS[key] || "";
  if (!text) return "";
  return `<span class="tooltip-wrap">
    <span class="tooltip-icon">?</span>
    <span class="tooltip-box">${text}</span>
  </span>`;
}

function thTip(label, key, align = "") {
  return `<th class="py-2 px-3 ${align}">
    <span class="tooltip-wrap" style="justify-content:${align === 'text-right' ? 'flex-end' : 'flex-start'}">
      ${label}
      ${key ? `<span class="tooltip-icon">?</span><span class="tooltip-box">${TIPS[key]||''}</span>` : ""}
    </span>
  </th>`;
}

// ─── RENDER HELPERS ───────────────────────────────────────────────────────────
const chip = pct => {
  if (pct == null || isNaN(pct)) return `<span style="color:var(--taupe)">—</span>`;
  const bg   = pct > 0 ? "rgba(122,155,132,0.18)" : pct < 0 ? "rgba(194,121,65,0.15)" : "rgba(168,136,133,0.12)";
  const col  = pct > 0 ? "var(--sage)"            : pct < 0 ? "var(--terracotta)"     : "var(--taupe)";
  const sign = pct > 0 ? "+" : "";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:600;background:${bg};color:${col}">${sign}${pct.toFixed(2)}%</span>`;
};

const sentimentChip = score => {
  if (score == null) return `<span style="color:var(--taupe);font-size:0.75rem">—</span>`;
  if (score >  0.15) return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:600;background:rgba(122,155,132,0.18);color:var(--sage)">▲ Positive</span>`;
  if (score < -0.15) return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:600;background:rgba(194,121,65,0.15);color:var(--terracotta)">▼ Negative</span>`;
  return `<span style="display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:600;background:rgba(168,136,133,0.12);color:var(--taupe)">● Neutral</span>`;
};

const zoneChip = zone => {
  if (!zone) return "";
  const [bg, col] = zone === "Strong Buy"
    ? ["var(--sage)",       "white"]
    : zone === "Watch"
    ? ["var(--gold-light)", "var(--navy)"]
    : ["rgba(194,121,65,0.12)", "var(--terracotta)"];
  return `<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:0.75rem;font-weight:600;background:${bg};color:${col}">${zone}</span>`;
};

const scoreBar = score => {
  if (score == null) return `<span style="color:var(--taupe)">—</span>`;
  const col = score >= 70 ? "var(--sage)"
            : score >= 45 ? "var(--gold)"
            :               "var(--terracotta)";
  return `<div style="display:flex;align-items:center;gap:6px">
    <div style="width:56px;height:6px;background:var(--gold-light);border-radius:3px;overflow:hidden">
      <div class="score-fill" style="width:${score}%;height:100%;background:${col};border-radius:3px"></div>
    </div>
    <span style="font-size:0.75rem;font-weight:700;font-variant-numeric:tabular-nums;color:${col}">${score}</span>
  </div>`;
};

const starBtn = sym => {
  const on = state.favorites.has(sym);
  return `<button data-fav="${sym}" style="font-size:1.1rem;line-height:1;color:${on ? "var(--gold)" : "var(--border)"};transition:color 0.15s" onmouseenter="if(!${on})this.style.color='var(--gold)'" onmouseleave="if(!${on})this.style.color='var(--border)'">★</button>`;
};

function metricFor(sym) {
  const q     = state.quotes[sym];
  const f     = state.fundamentals[sym];
  const n     = state.news[sym];
  const price = q?.last ?? null;
  const fv    = M.dcfFairValue(price, f, state.cfg);
  return {
    price,
    changePct:      q?.changePct ?? null,
    rsi:            M.rsi(f),
    ma50:           M.ma50(f),
    ma200:          M.ma200(f),
    drawdown:       M.drawdownFrom52wHigh(f),
    fairValue:      fv,
    mos:            M.marginOfSafety(price, fv),
    score:          M.undervaluationScore(price, f, state.cfg, n?.sentimentScore ?? null),
    zone:           M.buyZone(price, f, state.cfg),
    high52w:        f?.high52w ?? null,
    low52w:         f?.low52w  ?? null,
    sentimentScore: n?.sentimentScore ?? null,
    articles:       n?.articles ?? [],
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
    <tr class="cursor-pointer" style="border-bottom:1px solid var(--border)" data-symbol="${s.symbol}"
        onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''">
      <td class="py-2 px-3" style="font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
      <td class="py-2 px-3 truncate max-w-[140px]" style="font-size:0.8rem;color:var(--taupe)">${s.name}</td>
      <td class="py-2 px-3 text-right" style="font-family:monospace;font-size:0.875rem">$${fmt(s.price)}</td>
      <td class="py-2 px-3">${scoreBar(s.score)}</td>
      <td class="py-2 px-3">${zoneChip(s.zone)}</td>
    </tr>`).join("");

  return `
  <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
    <div class="med-card med-card-sage p-4">
      <p class="text-xs uppercase tracking-widest mb-1" style="color:var(--taupe)">Strong Buy Zones ${tip("zone")}</p>
      <p class="text-3xl font-bold" style="font-family:Georgia,serif;color:var(--sage)">${strongBuys}</p>
      <p class="text-xs mt-1" style="color:var(--taupe)">${watches} in Watch Zone</p>
    </div>
    <div class="med-card med-card-gold p-4">
      <p class="text-xs uppercase tracking-widest mb-1" style="color:var(--taupe)">Stocks Scored ${tip("score")}</p>
      <p class="text-3xl font-bold" style="font-family:Georgia,serif;color:var(--navy)">${scored.length}</p>
      <p class="text-xs mt-1" style="color:var(--taupe)">with fundamentals loaded</p>
    </div>
    <div class="med-card med-card-terra p-4 cursor-pointer" id="alerts-card" style="transition:box-shadow 0.15s" onmouseenter="this.style.boxShadow='0 4px 12px rgba(45,62,79,0.1)'" onmouseleave="this.style.boxShadow=''">
      <p class="text-xs uppercase tracking-widest mb-1" style="color:var(--taupe)">Today's Alerts</p>
      <p class="text-3xl font-bold" style="font-family:Georgia,serif;color:var(--terracotta)">${todayAlerts}</p>
      <p class="text-xs mt-1" style="color:var(--taupe)">tap to view →</p>
    </div>
  </div>
  <div class="med-card med-card-gold mb-5">
    <div class="px-4 py-3 flex items-center gap-2" style="border-bottom:1px solid var(--border)">
      <span class="font-semibold" style="font-family:Georgia,serif;color:var(--navy)">🏆 Top 5 Undervalued Opportunities</span>
      <span class="text-xs ml-1" style="color:var(--taupe)">(ranked by undervaluation score)</span>
    </div>
    <div class="overflow-x-auto">
      <table class="w-full">
        <tbody>${topRows || `<tr><td colspan="5" class="p-4 text-sm" style="color:var(--taupe)">Loading scores… prices load first, then fundamentals.</td></tr>`}</tbody>
      </table>
    </div>
  </div>`;
}

// ─── TABLE ROWS ───────────────────────────────────────────────────────────────
function rowHtml(s, showValue = false) {
  const m = metricFor(s.symbol);
  if (!showValue) {
    return `
    <tr class="med-table-row" data-symbol="${s.symbol}"
        onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''"
        style="border-bottom:1px solid #f0ebe0;cursor:pointer">
      <td style="padding:9px 12px">${starBtn(s.symbol)}</td>
      <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
      <td style="padding:9px 12px;font-size:0.82rem;color:var(--taupe);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem">$${fmt(m.price)}</td>
      <td style="padding:9px 12px;text-align:right">${chip(m.changePct)}</td>
      <td style="padding:9px 12px;font-size:0.8rem;color:var(--taupe)">${s.industry}</td>
    </tr>`;
  }

  const rsiColor = m.rsi == null ? "var(--navy)"
    : m.rsi < 30 ? "var(--sage)" : m.rsi < 40 ? "var(--sage)"
    : m.rsi > 70 ? "var(--terracotta)" : "var(--navy)";
  const ma200Color = m.price != null && m.ma200 != null
    ? (m.price < m.ma200 ? "var(--sage)" : "var(--terracotta)") : "var(--navy)";

  return `
    <tr data-symbol="${s.symbol}"
        onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''"
        style="border-bottom:1px solid #f0ebe0;cursor:pointer">
      <td style="padding:9px 12px">${starBtn(s.symbol)}</td>
      <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
      <td style="padding:9px 12px;font-size:0.82rem;color:var(--taupe);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem">$${fmt(m.price)}</td>
      <td style="padding:9px 12px;text-align:right">${chip(m.changePct)}</td>
      <td style="padding:9px 12px">${scoreBar(m.score)}</td>
      <td style="padding:9px 12px">${zoneChip(m.zone)}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem;font-weight:600;color:${rsiColor}">${m.rsi ?? "—"}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.8rem;color:${ma200Color}">$${fmt(m.ma200)}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem">${m.drawdown != null ? m.drawdown.toFixed(1)+"%" : "—"}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem">${m.mos != null ? m.mos.toFixed(1)+"%" : "—"}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem">$${fmt(m.fairValue)}</td>
      <td style="padding:9px 12px">${sentimentChip(m.sentimentScore)}</td>
    </tr>`;
}

function tableHtml(stocks, showValue = false) {
  const filtered = filterBySearch(stocks);
  if (!filtered.length) return `<p style="padding:16px;font-size:0.875rem;color:var(--taupe)">No stocks match your search.</p>`;

  const th = (label, key, align = "") =>
    `<th style="padding:10px 12px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border);white-space:nowrap;${align ? 'text-align:right' : ''}">
      <span class="tooltip-wrap" style="${align ? 'justify-content:flex-end' : ''}">
        ${label}${key ? `<span class="tooltip-icon">?</span><span class="tooltip-box">${TIPS[key]||''}</span>` : ""}
      </span>
    </th>`;

  const baseHead = `${th("")}${th("Ticker")}${th("Name")}${th("Price","price","right")}${th("Change","change","right")}`;
  const valueHead = showValue
    ? `${th("Score","score")}${th("Zone","zone")}${th("RSI","rsi","right")}${th("MA 200","ma200","right")}${th("Drawdown","drawdown","right")}${th("Margin of Safety","mos","right")}${th("Fair Value","fairValue","right")}${th("Sentiment","sentiment")}`
    : th("Industry");

  return `
    <table style="width:100%;border-collapse:collapse">
      <thead><tr>${baseHead}${valueHead}</tr></thead>
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
      <details class="med-card mb-2">
        <summary class="cursor-pointer px-4 py-3 flex items-center gap-3" style="border-radius:10px">
          <span class="font-semibold flex-1" style="font-family:Georgia,serif;color:var(--navy)">${sec}</span>
          <span class="text-xs" style="color:var(--taupe)">${stocks.length} stocks · ${winners} up</span>
          ${chip(avg)}
          <span style="color:var(--taupe);font-size:0.8rem">▾</span>
        </summary>
        <div class="overflow-x-auto" style="border-top:1px solid var(--border)">${tableHtml(stocks)}</div>
      </details>`;
  }).join("");
  $("#content").innerHTML = `${summary}<div class="space-y-2">${cards}</div>`;
  bindSummaryEvents();
}

function renderFavorites() {
  const stocks = state.universe.filter(s => state.favorites.has(s.symbol));
  if (!stocks.length) {
    $("#content").innerHTML = `<div class="med-card p-10 text-center" style="color:var(--taupe)">
      <p class="text-lg mb-2">No watchlist stocks yet.</p>
      <p class="text-sm">Click ★ next to any stock to add it here.</p>
    </div>`;
    return;
  }
  const groups = stocks.reduce((acc, s) => { (acc[s.sector] ||= []).push(s); return acc; }, {});
  $("#content").innerHTML = Object.entries(groups).map(([sec, list]) => `
    <section class="med-card mb-3">
      <div class="px-4 py-3 flex items-center gap-3" style="border-bottom:1px solid var(--border)">
        <span class="font-semibold" style="font-family:Georgia,serif;color:var(--navy)">${sec}</span>
        <span class="ml-auto">${chip(sectorAggregate(list))}</span>
      </div>
      <div class="overflow-x-auto">${tableHtml(list, true)}</div>
    </section>`).join("");
}

function renderAll() {
  $("#content").innerHTML = `<div class="med-card overflow-x-auto">${tableHtml(state.universe)}</div>`;
}

function renderValue() {
  const scored = [...state.universe].map(s => ({ ...s, ...metricFor(s.symbol) }));
  scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const filtered = filterBySearch(scored).slice(0, 200);
  if (!filtered.length) {
    $("#content").innerHTML = `<div class="med-card p-8 text-center" style="color:var(--taupe)">No data yet. Fundamentals load in the background — wait a moment then refresh.</div>`;
    return;
  }
  const rows = filtered.map(s => rowHtml(s, true)).join("");
  $("#content").innerHTML = `
    <div class="med-card med-card-gold overflow-x-auto">
      <div class="px-4 py-3 flex items-center gap-3" style="border-bottom:1px solid var(--border)">
        <span class="text-sm" style="color:var(--taupe)">Ranked by undervaluation score. Hover column headers for explanations. Fundamentals refresh hourly.</span>
        <button id="open-settings" class="btn-secondary ml-auto" style="white-space:nowrap">⚙ Edit Assumptions</button>
      </div>
      ${tableHtml(filtered, true)}
    </div>`;
  document.getElementById("open-settings")?.addEventListener("click", openSettings);
}

function renderAlerts() {
  const items = state.alerts.slice(0, 100);
  if (!items.length) {
    $("#content").innerHTML = `<div class="med-card p-10 text-center" style="color:var(--taupe)">
      <p class="text-lg mb-2">No alerts yet.</p>
      <p class="text-sm">Alerts fire automatically when a stock's undervaluation score, buy zone, or price drop hits your configured thresholds. Edit thresholds in ⚙ Settings.</p>
    </div>`;
    return;
  }
  const rows = items.map(a => `
    <tr data-symbol="${a.sym}" style="border-bottom:1px solid #f0ebe0;cursor:pointer"
        onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''">
      <td style="padding:10px 14px;font-family:monospace;font-weight:700;color:var(--navy)">${a.sym}</td>
      <td style="padding:10px 14px;font-size:0.875rem;color:var(--terracotta)">${a.msg}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:0.875rem">$${fmt(a.price)}</td>
      <td style="padding:10px 14px;font-size:0.75rem;color:var(--taupe)">${new Date(a.ts).toLocaleString()}</td>
    </tr>`).join("");
  $("#content").innerHTML = `
    <div class="med-card med-card-terra overflow-x-auto">
      <div class="px-4 py-3 flex items-center gap-3" style="border-bottom:1px solid var(--border)">
        <span class="font-semibold" style="font-family:Georgia,serif;color:var(--navy)">🔔 Alerts</span>
        <span class="text-xs ml-1" style="color:var(--taupe)">Click a row to view the stock</span>
        <button id="clear-alerts" class="ml-auto btn-secondary text-xs" style="color:var(--terracotta);border-color:var(--terracotta)">Clear all</button>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)">Symbol</th>
          <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)">What Triggered It</th>
          <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border);text-align:right">Price</th>
          <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)">When</th>
        </tr></thead>
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

// ─── SENTIMENT PAGE ───────────────────────────────────────────────────────────
function renderSentiment() {
  // Gather all symbols that have news data loaded
  const all = state.universe.map(s => {
    const n = state.news[s.symbol];
    const q = state.quotes[s.symbol];
    return { ...s, price: q?.last ?? null, changePct: q?.changePct ?? null,
             sentimentScore: n?.sentimentScore ?? null, articles: n?.articles ?? [] };
  }).filter(s => s.sentimentScore != null);

  if (!all.length) {
    $("#content").innerHTML = `
      <div class="med-card p-10 text-center" style="color:var(--taupe)">
        <p class="text-lg mb-2">No sentiment data loaded yet.</p>
        <p class="text-sm">Sentiment loads automatically alongside prices. Wait a moment and hit ↻ Refresh.</p>
      </div>`;
    return;
  }

  // Sort strongest first within each bucket
  const positive = all.filter(s => s.sentimentScore >  0.15).sort((a,b) => b.sentimentScore - a.sentimentScore);
  const negative = all.filter(s => s.sentimentScore < -0.15).sort((a,b) => a.sentimentScore - b.sentimentScore);
  const neutral  = all.filter(s => s.sentimentScore >= -0.15 && s.sentimentScore <= 0.15)
                      .sort((a,b) => Math.abs(b.sentimentScore) - Math.abs(a.sentimentScore));

  // Summary bar
  const total = all.length;
  const pPct  = Math.round(positive.length / total * 100);
  const nPct  = Math.round(negative.length / total * 100);
  const neuPct = 100 - pPct - nPct;

  const summaryBar = `
    <div class="med-card med-card-gold p-5 mb-5">
      <div class="flex items-center justify-between mb-3">
        <span class="font-semibold" style="font-family:Georgia,serif;color:var(--navy)">Market Sentiment Overview</span>
        <span class="text-xs" style="color:var(--taupe)">${total} stocks with news · refreshes every 15 min</span>
      </div>
      <div style="display:flex;border-radius:6px;overflow:hidden;height:14px;margin-bottom:12px">
        <div style="background:var(--sage);width:${pPct}%;transition:width 0.4s" title="${positive.length} positive"></div>
        <div style="background:var(--border);width:${neuPct}%;transition:width 0.4s" title="${neutral.length} neutral"></div>
        <div style="background:var(--terracotta);width:${nPct}%;transition:width 0.4s" title="${negative.length} negative"></div>
      </div>
      <div style="display:flex;gap:20px;font-size:0.78rem">
        <span style="display:flex;align-items:center;gap:5px;color:var(--sage)"><span style="width:10px;height:10px;border-radius:50%;background:var(--sage);display:inline-block"></span> Positive ${positive.length} (${pPct}%)</span>
        <span style="display:flex;align-items:center;gap:5px;color:var(--taupe)"><span style="width:10px;height:10px;border-radius:50%;background:var(--border);display:inline-block"></span> Neutral ${neutral.length} (${neuPct}%)</span>
        <span style="display:flex;align-items:center;gap:5px;color:var(--terracotta)"><span style="width:10px;height:10px;border-radius:50%;background:var(--terracotta);display:inline-block"></span> Negative ${negative.length} (${nPct}%)</span>
      </div>
    </div>`;

  const sentThead = `<thead><tr>
    <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)">Ticker</th>
    <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)">Name</th>
    <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border);text-align:right">Price</th>
    <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border);text-align:right">Change</th>
    <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)">Score</th>
    <th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)">Latest Headline</th>
  </tr></thead>`;

  const sentimentRow = s => {
    const bar = sentimentBar(s.sentimentScore);
    const latestHeadline = s.articles[0];
    return `
      <tr data-symbol="${s.symbol}" style="border-bottom:1px solid #f0ebe0;cursor:pointer"
          onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''">
        <td style="padding:10px 14px;font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
        <td style="padding:10px 14px;font-size:0.8rem;color:var(--taupe);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</td>
        <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:0.875rem">$${fmt(s.price)}</td>
        <td style="padding:10px 14px;text-align:right">${chip(s.changePct)}</td>
        <td style="padding:10px 14px">${bar}</td>
        <td style="padding:10px 14px;font-size:0.8rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${latestHeadline
            ? `<span style="color:var(--navy)">${latestHeadline.headline}</span> <span style="color:var(--taupe)">· ${timeAgo(latestHeadline.publishedAt)}</span>`
            : `<span style="color:var(--taupe)">—</span>`}
        </td>
      </tr>`;
  };

  const sentBlock = (list, label, dotColor, cardClass) => list.length ? `
    <div class="med-card ${cardClass} mb-4">
      <div class="px-4 py-3 flex items-center gap-2" style="border-bottom:1px solid var(--border)">
        <span style="width:10px;height:10px;border-radius:50%;background:${dotColor};display:inline-block"></span>
        <span class="font-semibold" style="font-family:Georgia,serif;color:var(--navy)">${label}</span>
        <span class="text-xs ml-1" style="color:var(--taupe)">${list.length} stocks</span>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">${sentThead}<tbody>${list.map(sentimentRow).join("")}</tbody></table>
      </div>
    </div>` : "";

  const neutralBlock = neutral.length ? `
    <details class="med-card mb-4">
      <summary class="cursor-pointer px-4 py-3 flex items-center gap-2" style="border-radius:10px">
        <span style="width:10px;height:10px;border-radius:50%;background:var(--border);display:inline-block"></span>
        <span class="font-semibold" style="font-family:Georgia,serif;color:var(--navy)">Neutral</span>
        <span class="text-xs ml-1" style="color:var(--taupe)">${neutral.length} stocks · no strong signal either way</span>
        <span style="margin-left:auto;color:var(--taupe);font-size:0.8rem">▾ expand</span>
      </summary>
      <div style="overflow-x:auto;border-top:1px solid var(--border)">
        <table style="width:100%;border-collapse:collapse">${sentThead}<tbody>${neutral.map(sentimentRow).join("")}</tbody></table>
      </div>
    </details>` : "";

  $("#content").innerHTML = summaryBar
    + sentBlock(positive, "▲ Positive Sentiment", "var(--sage)", "med-card-sage")
    + sentBlock(negative, "▼ Negative Sentiment", "var(--terracotta)", "med-card-terra")
    + neutralBlock;
}

// Sentiment score bar: -1 → +1 rendered as a two-sided bar
function sentimentBar(score) {
  if (score == null) return `<span style="color:var(--taupe)">—</span>`;
  const pct   = Math.abs(score) * 100;
  const isPos = score >= 0;
  const color = score >  0.15 ? "var(--sage)"
              : score < -0.15 ? "var(--terracotta)"
              : "var(--taupe)";
  const label = score >  0.15 ? `+${score.toFixed(2)}`
              : score.toFixed(2);
  // Left half = negative, right half = positive, bar grows from center
  return `
    <div style="display:flex;align-items:center;gap:6px">
      <div style="width:80px;height:6px;background:var(--gold-light);border-radius:3px;overflow:hidden;display:flex">
        <div style="flex:1;display:flex;justify-content:flex-end">
          ${!isPos ? `<div style="width:${pct}%;height:100%;background:${color};border-radius:3px 0 0 3px"></div>` : ""}
        </div>
        <div style="flex:1">
          ${isPos ? `<div style="width:${pct}%;height:100%;background:${color};border-radius:0 3px 3px 0"></div>` : ""}
        </div>
      </div>
      <span style="font-size:0.75rem;font-weight:700;font-variant-numeric:tabular-nums;color:${color}">${label}</span>
    </div>`;
}

function render() {
  if      (state.tab === "favorites")  renderFavorites();
  else if (state.tab === "all")        renderAll();
  else if (state.tab === "value")      renderValue();
  else if (state.tab === "alerts")     renderAlerts();
  else if (state.tab === "sentiment")  renderSentiment();
  else                                  renderSectors();
}

function bindSummaryEvents() {
  document.getElementById("alerts-card")?.addEventListener("click", () => {
    switchTab("alerts");
  });
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  render();
}

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────────
function openSettings() {
  const c = state.cfg;
  document.getElementById("settings-modal").innerHTML = `
    <div class="med-card" style="max-width:480px;width:100%;padding:28px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
        <h2 style="font-family:Georgia,serif;color:var(--navy);font-size:1.2rem">⚙ Assumptions & Alerts</h2>
        <button id="settings-close" style="font-size:1.5rem;color:var(--taupe);line-height:1;padding:0 6px">&times;</button>
      </div>
      <p style="font-size:0.8rem;color:var(--taupe);margin-bottom:16px;line-height:1.5">These values drive the Fair Value and undervaluation score calculations. Safe defaults are pre-filled — only change if you have a reason to.</p>
      <div style="display:flex;flex-direction:column;gap:12px;font-size:0.875rem">
        ${cfgField("discountRate",        "Discount Rate (WACC)",            c.discountRate,        "0.01","0.30","0.01", "Your required annual return. 10% is a common starting point.")}
        ${cfgField("revenueGrowth",       "Expected Revenue Growth Rate",    c.revenueGrowth,       "0.01","0.40","0.01", "How fast you expect the company to grow each year. 8% = moderate growth.")}
        ${cfgField("terminalGrowth",      "Long-Term Growth Rate",           c.terminalGrowth,      "0.00","0.05","0.01", "Growth rate after the projection period ends. Usually 2–3% (similar to GDP).")}
        ${cfgField("projectionYears",     "Years to Project",                c.projectionYears,     "3","20","1",          "How many years of future cash flows to model. 10 is standard.")}
        ${cfgField("marginOfSafetyPct",   "Margin of Safety % for Strong Buy", c.marginOfSafetyPct, "5","50","5",         "How much cheaper than fair value before labelling 'Strong Buy'. 25% = a 25% discount.")}
        ${cfgField("alertThresholdScore", "Alert when Score reaches ≥",      c.alertThresholdScore, "50","100","5",        "Get an alert when undervaluation score hits this number (0–100).")}
        ${cfgField("alertDropPct",        "Alert when Price drops ≥ %",      c.alertDropPct,        "3","50","1",           "Get an alert when a stock drops this much in the current period.")}
        ${cfgField("rsiOversold",         "RSI Oversold Level",              c.rsiOversold,         "20","50","1",          "RSI below this value is flagged as a potential buying opportunity.")}
      </div>
      <div style="margin-top:20px;display:flex;gap:10px">
        <button id="settings-save" class="btn-primary" style="flex:1;text-align:center;padding:9px">Save Changes</button>
        <button id="settings-reset" class="btn-secondary" style="padding:9px 16px">Reset Defaults</button>
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
      <span style="color:var(--navy);font-size:0.85rem;font-weight:500">${label}</span>
      ${hint ? `<span style="color:var(--taupe);font-size:0.75rem;margin-left:4px">${hint}</span>` : ""}
      <input id="cfg-${key}" type="number" min="${min}" max="${max}" step="${step}"
             value="${value}"
             style="margin-top:4px;display:block;width:100%" />
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

  // Data quality badge
  const f = state.fundamentals[symbol];
  const dcfSource = f?.fcfYield != null ? "FCF Yield (FMP)"
                  : f?.eps      != null ? "EPS (FMP)"
                  : "5% yield proxy";
  const hasFmpData = f?.fmpLoaded === true;
  const dataBadge = hasFmpData
    ? `<span style="font-size:0.75rem;padding:2px 8px;border-radius:4px;background:rgba(122,155,132,0.15);color:var(--sage);border:1px solid rgba(122,155,132,0.3)">✓ FMP fundamentals loaded · DCF uses ${dcfSource}</span>`
    : `<span style="font-size:0.75rem;padding:2px 8px;border-radius:4px;background:rgba(212,165,116,0.15);color:var(--terracotta);border:1px solid rgba(212,165,116,0.3)">⚠ FMP not connected — DCF uses ${dcfSource}</span>`;

  // Metrics grid
  document.getElementById("m-metrics").innerHTML = `
    <div style="margin-bottom:10px">${dataBadge}</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:12px 0;font-size:0.875rem">
      ${metricCard("Score",            scoreBar(m.score))}
      ${metricCard("Zone",             zoneChip(m.zone))}
      ${metricCard("RSI-14",           m.rsi != null ? m.rsi : "—")}
      ${metricCard("MA 50",            "$"+fmt(m.ma50))}
      ${metricCard("MA 200",           "$"+fmt(m.ma200))}
      ${metricCard("52w High",         "$"+fmt(m.high52w))}
      ${metricCard("Drawdown",         m.drawdown != null ? m.drawdown.toFixed(1)+"%" : "—")}
      ${metricCard("P/E (TTM)",        f?.pe      != null ? f.pe      : "—")}
      ${metricCard("P/E 5yr Avg",      f?.pe5yAvg != null ? f.pe5yAvg : "—")}
      ${metricCard("FCF Yield",        f?.fcfYield!= null ? (f.fcfYield*100).toFixed(1)+"%" : "—")}
      ${metricCard("EPS (TTM)",        f?.eps     != null ? "$"+fmt(f.eps) : "—")}
      ${metricCard("Sentiment",         sentimentChip(m.sentimentScore))}
      ${metricCard("Fair Value",         "$"+fmt(m.fairValue)+" <span class='text-slate-400 text-xs font-normal'>("+dcfSource+")</span>")}
      ${metricCard("Margin of Safety",   m.mos != null ? m.mos.toFixed(1)+"%" : "—")}
    </div>`;

  $("#modal").classList.remove("hidden");

  // Fetch chart bars, fresh news, and FMP fundamentals (1 call) in parallel
  const [barsResp, newsResp] = await Promise.all([
    fetch(`/api/bars?symbol=${symbol}&duration=${state.duration}`).then(r => r.json()),
    fetch(`/api/news?symbols=${symbol}&limit=10`).then(r => r.ok ? r.json() : null),
    fetchFundamentals([symbol], { wantFmp: true }),
  ]);

  // Chart
  const bars = barsResp.bars || [];
  if (chart) chart.destroy();
  const ctx = document.getElementById("m-chart").getContext("2d");
  const up  = bars.length > 1 && bars.at(-1).c >= bars[0].c;
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels:   bars.map(b => b.t),
      datasets: [{
        data:            bars.map(b => b.c),
        borderColor:     up ? "#7A9B84" : "#C27941",
        backgroundColor: up ? "rgba(122,155,132,0.12)" : "rgba(194,121,65,0.1)",
        fill: true, tension: 0.2, pointRadius: 0, borderWidth: 2,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { maxTicksLimit: 6, color: "#A89885", font: { size: 11 }, callback: (_, i) => bars[i] ? new Date(bars[i].t).toLocaleDateString() : "" }, grid: { color: "#f0ebe0" } },
        y: { ticks: { color: "#A89885", font: { size: 11 }, callback: v => `$${v}` }, grid: { color: "#f0ebe0" } },
      },
    },
  });

  // News feed
  const articles = newsResp?.news?.[symbol]?.articles ?? [];
  const newsFeed = document.getElementById("m-news");
  if (newsFeed) {
    if (!articles.length) {
      newsFeed.innerHTML = `<p style="color:var(--taupe);font-size:0.85rem;padding:12px 0">No recent news found.</p>`;
    } else {
      newsFeed.innerHTML = articles.map(a => {
        const [sentBg, sentCol] = a.sentiment === "positive"
          ? ["rgba(122,155,132,0.18)", "var(--sage)"]
          : a.sentiment === "negative"
          ? ["rgba(194,121,65,0.15)", "var(--terracotta)"]
          : ["rgba(168,152,133,0.15)", "var(--taupe)"];
        const ago = timeAgo(a.publishedAt);
        return `
          <a href="${a.url}" target="_blank" rel="noopener noreferrer"
             style="display:block;border-bottom:1px solid var(--border);padding:12px 0;text-decoration:none"
             onmouseover="this.style.background='#faf8f3'" onmouseout="this.style.background=''">
            <div style="display:flex;align-items:flex-start;gap:8px">
              <span style="flex-shrink:0;margin-top:2px;padding:2px 6px;border-radius:4px;font-size:0.65rem;font-weight:700;background:${sentBg};color:${sentCol};text-transform:uppercase">${a.sentiment}</span>
              <div style="flex:1;min-width:0">
                <p style="font-size:0.875rem;font-weight:500;color:var(--navy);line-height:1.4;margin:0 0 3px">${a.headline}</p>
                ${a.summary ? `<p style="font-size:0.75rem;color:var(--taupe);margin:0 0 4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${a.summary}</p>` : ""}
                <p style="font-size:0.72rem;color:var(--taupe);margin:0">${a.source} · ${ago}</p>
              </div>
            </div>
          </a>`;
      }).join("");
    }
  }
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function metricCard(label, value) {
  return `
    <div style="background:#faf8f4;border-radius:8px;border:1px solid var(--border);padding:10px 12px">
      <p style="font-size:0.7rem;color:var(--taupe);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em">${label}</p>
      <div style="font-weight:600;color:var(--navy);font-size:0.9rem">${value}</div>
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
