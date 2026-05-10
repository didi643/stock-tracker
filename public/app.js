// Stock Tracker — Long-Term Value Edition
// Architecture: pure METRICS module → state → render pipeline

const REFRESH_MS  = 30_000;
const FUND_TTL_MS = 3_600_000;
const NEWS_TTL_MS = 900_000;
const ALERT_KEY   = "stock-tracker.alerts.v2";
const CFG_KEY     = "stock-tracker.config.v2";

const $ = s => document.querySelector(s);
const fmt  = n => n == null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtI = n => n == null ? "—" : Math.round(n).toLocaleString();
const fmtPct = n => n == null ? "—" : (n * 100).toFixed(1) + "%";

// ─── Default config ───────────────────────────────────────────────────────────
const DEFAULT_CFG = {
  discountRate:        0.10,
  revenueGrowth:       0.08,
  terminalGrowth:      0.03,
  projectionYears:     10,
  marginOfSafetyPct:   25,
  alertThresholdScore: 70,
  alertDropPct:        10,
  rsiOversold:         40,
};

// ─── METRICS MODULE ───────────────────────────────────────────────────────────

const M = {

  rsi:   f => f?.rsi14 ?? null,
  ma50:  f => f?.ma50  ?? null,
  ma200: f => f?.ma200 ?? null,
  drawdownFrom52wHigh: f => f?.pctFrom52wHigh ?? null,

  pctVsMa200: (price, f) => {
    if (price == null || !f?.ma200) return null;
    return +((price - f.ma200) / f.ma200 * 100).toFixed(2);
  },

  // ── DCF Fair Value ──────────────────────────────────────────────────────────
  dcfFairValue: (price, f, cfg) => {
    if (price == null) return null;
    const { discountRate: r, revenueGrowth: g, terminalGrowth: tg, projectionYears: n } = cfg;
    if (r <= tg) return null;
    let fcf;
    if (f?.fcfYield != null && f.fcfYield > 0) {
      fcf = price * f.fcfYield;
    } else if (f?.eps != null && f.eps > 0) {
      fcf = f.eps;
    } else {
      fcf = price * 0.05;
    }
    let pv = 0;
    for (let t = 1; t <= n; t++) {
      fcf *= (1 + g);
      pv  += fcf / Math.pow(1 + r, t);
    }
    const terminalFCF = fcf * (1 + tg);
    const tv          = terminalFCF / (r - tg);
    pv               += tv / Math.pow(1 + r, n);
    return pv > 0 ? +pv.toFixed(2) : null;
  },

  marginOfSafety: (price, fairValue) => {
    if (price == null || fairValue == null || fairValue <= 0) return null;
    return +((fairValue - price) / fairValue * 100).toFixed(1);
  },

  // ── Graham Number ────────────────────────────────────────────────────────────
  // Sqrt(22.5 × EPS × BookValue) — Benjamin Graham conservative intrinsic value
  grahamNumber: (f) => {
    if (!f?.eps || f.eps <= 0 || !f?.bookValue || f.bookValue <= 0) return null;
    return +Math.sqrt(22.5 * f.eps * f.bookValue).toFixed(2);
  },

  // ── Ideal Entry Price ────────────────────────────────────────────────────────
  // Median of available: (DCF × 0.75), (Graham × 0.85), (MA200 × 0.95)
  entryPrice: (price, f, cfg) => {
    const candidates = [];
    const dcf = M.dcfFairValue(price, f, cfg);
    if (dcf && dcf > 0) candidates.push(dcf * 0.75);
    const graham = M.grahamNumber(f);
    if (graham && graham > 0) candidates.push(graham * 0.85);
    const ma200 = f?.ma200;
    if (ma200 && ma200 > 0) candidates.push(ma200 * 0.95);
    if (!candidates.length) return null;
    candidates.sort((a, b) => a - b);
    const mid = Math.floor(candidates.length / 2);
    return candidates.length % 2 === 0
      ? +((candidates[mid - 1] + candidates[mid]) / 2).toFixed(2)
      : +candidates[mid].toFixed(2);
  },

  // ── LT Quality Score (0–100) ─────────────────────────────────────────────────
  // 25% ROE · 20% Operating Margin · 20% Earnings Growth · 20% D/E · 15% Current Ratio
  qualityScore: (f) => {
    if (!f) return null;
    const scores = [];
    if (f.roe            != null) scores.push({ s: Math.max(0, Math.min(100, f.roe * 100 * 3.5)),                    w: 0.25 });
    if (f.operatingMargin!= null) scores.push({ s: Math.max(0, Math.min(100, f.operatingMargin * 100 * 3)),          w: 0.20 });
    if (f.earningsGrowthYoy != null) scores.push({ s: Math.max(0, Math.min(100, f.earningsGrowthYoy * 100 * 4)),    w: 0.20 });
    if (f.debtToEquity   != null) scores.push({ s: Math.max(0, Math.min(100, (1 - f.debtToEquity / 2) * 100)),      w: 0.20 });
    if (f.currentRatio   != null) scores.push({ s: Math.max(0, Math.min(100, (f.currentRatio / 2) * 100)),          w: 0.15 });
    if (!scores.length) return null;
    const totalW = scores.reduce((a, x) => a + x.w, 0);
    return Math.round(Math.max(0, Math.min(100, scores.reduce((a, x) => a + x.s * x.w, 0) / totalW)));
  },

  // ── Undervaluation Score 0-100 ───────────────────────────────────────────────
  // 30% MoS · 20% 52w drawdown · 15% RSI · 15% P/B · 10% P/E · 10% sentiment
  undervaluationScore: (price, f, cfg, sentimentScore) => {
    const fv  = M.dcfFairValue(price, f, cfg);
    const mos = M.marginOfSafety(price, fv);
    const mosScore  = mos == null ? 50 : Math.max(0, Math.min(100, 50 + mos * 2));
    const dd        = M.drawdownFrom52wHigh(f);
    const hi52Score = dd == null ? 50 : Math.max(0, Math.min(100, -dd * (100 / 40)));
    const rsiVal    = M.rsi(f);
    const rsiScore  = rsiVal == null ? 50 : Math.max(0, Math.min(100, (70 - rsiVal) * (100 / 70)));
    let pbScore   = null;
    if (f?.pbRatio != null && f.pbRatio > 0)
      pbScore = Math.max(0, Math.min(100, (3 - f.pbRatio) / 3 * 100 + 20));
    let peScore   = null;
    if (f?.pe != null && f.pe > 0)
      peScore = Math.max(0, Math.min(100, (30 - f.pe) / 30 * 100 + 10));
    let sentScore = null;
    if (sentimentScore != null)
      sentScore = Math.max(0, Math.min(100, (sentimentScore + 1) * 50));
    const weights = { mos: 0.30, hi52: 0.20, rsi: 0.15, pb: 0.15, pe: 0.10, sent: 0.10 };
    const avail = [
      { s: mosScore,  w: weights.mos  },
      { s: hi52Score, w: weights.hi52 },
      { s: rsiScore,  w: weights.rsi  },
      ...(pbScore   != null ? [{ s: pbScore,   w: weights.pb   }] : []),
      ...(peScore   != null ? [{ s: peScore,   w: weights.pe   }] : []),
      ...(sentScore != null ? [{ s: sentScore, w: weights.sent }] : []),
    ];
    const totalW = avail.reduce((a, x) => a + x.w, 0);
    return Math.round(Math.max(0, Math.min(100, avail.reduce((a, x) => a + x.s * x.w, 0) / totalW)));
  },

  // ── LT Composite Score (0–100) — 60% undervaluation + 40% quality ───────────
  ltScore: (price, f, cfg, sentimentScore) => {
    const uv = M.undervaluationScore(price, f, cfg, sentimentScore);
    const ql = M.qualityScore(f);
    if (uv == null && ql == null) return null;
    if (ql == null) return uv;
    if (uv == null) return ql;
    return Math.round(uv * 0.60 + ql * 0.40);
  },

  // ── Entry Zone ───────────────────────────────────────────────────────────────
  entryZone: (price, f, cfg, sentimentScore) => {
    if (!price) return "Wait";
    const fv      = M.dcfFairValue(price, f, cfg);
    const mos     = M.marginOfSafety(price, fv);
    const entry   = M.entryPrice(price, f, cfg);
    const lt      = M.ltScore(price, f, cfg, sentimentScore);
    const rsi     = M.rsi(f);
    const ma200   = M.ma200(f);
    const atEntry    = entry != null && price <= entry;
    const belowFV85  = fv    != null && price <= fv * 0.85;
    const goodMoS    = mos   != null && mos >= cfg.marginOfSafetyPct;
    const rsiSignal  = rsi   != null && rsi  < cfg.rsiOversold;
    const belowMa200 = ma200 != null && price < ma200;
    const highLT     = lt    != null && lt >= 65;
    const midLT      = lt    != null && lt >= 50;
    if (atEntry && (highLT || goodMoS)) return "Prime Entry";
    if ((belowFV85 || goodMoS) && midLT) return "Good Entry";
    const signals = [goodMoS, rsiSignal, belowMa200].filter(Boolean).length;
    if (signals >= 1 || (mos != null && mos > 0)) return "Watch";
    return "Wait";
  },

  // ── Buy Zone (legacy) ────────────────────────────────────────────────────────
  buyZone: (price, f, cfg) => {
    const fv   = M.dcfFairValue(price, f, cfg);
    const mos  = M.marginOfSafety(price, fv);
    const rsi  = M.rsi(f);
    const ma200 = M.ma200(f);
    const belowFairValue = mos  != null && mos  >= cfg.marginOfSafetyPct;
    const rsiOversold    = rsi  != null && rsi  < cfg.rsiOversold;
    const belowMa200     = ma200 != null && price < ma200;
    const bullCount = [belowFairValue, rsiOversold, belowMa200].filter(Boolean).length;
    if (bullCount >= 2 && belowFairValue) return "Strong Buy";
    if (bullCount >= 1 || (mos != null && mos > 0)) return "Watch";
    return "Overvalued";
  },
};

// ─── WATCHLIST ────────────────────────────────────────────────────────────────
const WATCHLIST = [
  // ── ETFs ──────────────────────────────────────────────────────────────
  { symbol: "SPY",     name: "SPDR S&P 500 ETF",             sector: "ETF",           industry: "Broad Market" },
  { symbol: "VOO",     name: "Vanguard S&P 500 ETF",          sector: "ETF",           industry: "Broad Market" },
  { symbol: "QQQM",    name: "Invesco NASDAQ 100 ETF",         sector: "ETF",           industry: "Tech-heavy" },
  { symbol: "VHT",     name: "Vanguard Health Care ETF",       sector: "ETF",           industry: "Healthcare" },
  { symbol: "GLD",     name: "SPDR Gold Shares",               sector: "ETF",           industry: "Commodities" },
  // ── Technology ────────────────────────────────────────────────────────
  { symbol: "AAPL",    name: "Apple Inc.",                     sector: "Technology",    industry: "Consumer Electronics" },
  { symbol: "MSFT",    name: "Microsoft Corp.",                sector: "Technology",    industry: "Software" },
  { symbol: "GOOGL",   name: "Alphabet Inc.",                  sector: "Technology",    industry: "Internet" },
  { symbol: "META",    name: "Meta Platforms Inc.",            sector: "Technology",    industry: "Social Media" },
  { symbol: "NVDA",    name: "NVIDIA Corp.",                   sector: "Technology",    industry: "Semiconductors" },
  { symbol: "AMD",     name: "Advanced Micro Devices",         sector: "Technology",    industry: "Semiconductors" },
  { symbol: "INTC",    name: "Intel Corp.",                    sector: "Technology",    industry: "Semiconductors" },
  { symbol: "MU",      name: "Micron Technology",              sector: "Technology",    industry: "Memory Chips" },
  { symbol: "ORCL",    name: "Oracle Corp.",                   sector: "Technology",    industry: "Enterprise Software" },
  { symbol: "ARM",     name: "Arm Holdings",                   sector: "Technology",    industry: "Chip Architecture" },
  { symbol: "SNOW",    name: "Snowflake Inc.",                  sector: "Technology",    industry: "Cloud Data" },
  { symbol: "U",       name: "Unity Software",                 sector: "Technology",    industry: "Game Engine" },
  // ── Healthcare ────────────────────────────────────────────────────────
  { symbol: "ISRG",    name: "Intuitive Surgical",             sector: "Healthcare",    industry: "Surgical Robots" },
  { symbol: "GEHC",    name: "GE HealthCare Technologies",     sector: "Healthcare",    industry: "Medical Devices" },
  { symbol: "UNH",     name: "UnitedHealth Group",             sector: "Healthcare",    industry: "Health Insurance" },
  // ── Financials ────────────────────────────────────────────────────────
  { symbol: "V",       name: "Visa Inc.",                      sector: "Financials",    industry: "Payment Networks" },
  { symbol: "AXP",     name: "American Express",               sector: "Financials",    industry: "Credit Cards" },
  { symbol: "BRK-B",   name: "Berkshire Hathaway B",           sector: "Financials",    industry: "Diversified" },
  { symbol: "BAC",     name: "Bank of America",                sector: "Financials",    industry: "Banking" },
  { symbol: "MCO",     name: "Moody's Corp.",                  sector: "Financials",    industry: "Credit Ratings" },
  // ── Consumer ──────────────────────────────────────────────────────────
  { symbol: "BABA",    name: "Alibaba Group",                  sector: "Consumer",      industry: "E-Commerce" },
  { symbol: "MCD",     name: "McDonald's Corp.",               sector: "Consumer",      industry: "Fast Food" },
  { symbol: "KO",      name: "Coca-Cola Co.",                  sector: "Consumer",      industry: "Beverages" },
  { symbol: "PEP",     name: "PepsiCo Inc.",                   sector: "Consumer",      industry: "Beverages & Snacks" },
  { symbol: "TOST",    name: "Toast Inc.",                     sector: "Consumer",      industry: "Restaurant Tech" },
  { symbol: "LEN",     name: "Lennar Corp.",                   sector: "Consumer",      industry: "Homebuilding" },
  // ── Energy / Industrials ──────────────────────────────────────────────
  { symbol: "CEG",     name: "Constellation Energy",           sector: "Energy",        industry: "Nuclear Power" },
  { symbol: "MP",      name: "MP Materials Corp.",             sector: "Materials",     industry: "Rare Earth Mining" },
  // ── Media / Entertainment ────────────────────────────────────────────
  { symbol: "NFLX",    name: "Netflix Inc.",                   sector: "Media",         industry: "Streaming" },
  // ── AI / Quantum ──────────────────────────────────────────────────────
  { symbol: "TEM",     name: "Tempus AI Inc.",                 sector: "AI/Tech",       industry: "AI Healthcare" },
  { symbol: "IONQ",    name: "IonQ Inc.",                      sector: "AI/Tech",       industry: "Quantum Computing" },
  { symbol: "QUBT",    name: "Quantum Computing Inc.",         sector: "AI/Tech",       industry: "Quantum Computing" },
  { symbol: "POET",    name: "POET Technologies",              sector: "AI/Tech",       industry: "Optical Computing" },
  { symbol: "SOUN",    name: "SoundHound AI Inc.",             sector: "AI/Tech",       industry: "Voice AI" },
  { symbol: "PLTR",    name: "Palantir Technologies",          sector: "AI/Tech",       industry: "Data Analytics / AI" },
  // ── E-Commerce ────────────────────────────────────────────────────────
  { symbol: "AMZN",    name: "Amazon.com Inc.",                sector: "Technology",    industry: "E-Commerce / Cloud" },
  // ── EV / Disruptive ───────────────────────────────────────────────────
  { symbol: "TSLA",    name: "Tesla Inc.",                     sector: "Automotive",    industry: "Electric Vehicles" },
  // ── Fintech ───────────────────────────────────────────────────────────
  { symbol: "SOFI",    name: "SoFi Technologies",              sector: "Financials",    industry: "Digital Banking" },
  // ── Biotech / Genomics ────────────────────────────────────────────────
  { symbol: "CRSP",    name: "CRISPR Therapeutics",            sector: "Healthcare",    industry: "Gene Editing" },
  // ── Crypto ETF ────────────────────────────────────────────────────────
  { symbol: "IBIT",    name: "iShares Bitcoin Trust ETF",      sector: "ETF",           industry: "Crypto / Bitcoin" },
  // ── International (no Alpaca price data) ─────────────────────────────
  { symbol: "C6L.SI",  name: "Singapore Airlines",             sector: "International", industry: "Airlines (SGX)",     international: true },
  { symbol: "O39.SI",  name: "OCBC Bank",                      sector: "International", industry: "Banking (SGX)",      international: true },
  { symbol: "PHG",     name: "Koninklijke Philips (ADR)",       sector: "Healthcare",    industry: "Medical Devices" },
  { symbol: "VUKEL.XC",name: "Vanguard UK ETF (EUR)",           sector: "International", industry: "ETF (Xetra)",        international: true },
  { symbol: "UKDVL.XC",name: "iShares UK Dividend ETF (EUR)",   sector: "International", industry: "ETF (Xetra)",        international: true },
  { symbol: "TATE.L",  name: "Tate & Lyle (LSE)",               sector: "International", industry: "Food Ingredients",   international: true },
  { symbol: "NG.L",    name: "National Grid (LSE)",              sector: "International", industry: "Utilities",          international: true },
  { symbol: "5176.KL", name: "Pavilion REIT (Bursa)",            sector: "International", industry: "REIT",               international: true },
  { symbol: "1155.KL", name: "Maybank (Bursa)",                  sector: "International", industry: "Banking (Malaysia)",  international: true },
];

const US_SYMBOLS  = WATCHLIST.filter(s => !s.international).map(s => s.symbol);
const ALL_SYMBOLS = WATCHLIST.map(s => s.symbol);

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  universe:      WATCHLIST,
  quotes:        {},
  fundamentals:  {},
  fundFetchedAt: {},
  news:          {},
  newsFetchedAt: {},
  alerts:        JSON.parse(localStorage.getItem(ALERT_KEY) || "[]"),
  duration:      "1d",
  tab:           "watchlist",
  search:        "",
  ltSortBy:      "ltScore",
  cfg:           { ...DEFAULT_CFG, ...JSON.parse(localStorage.getItem(CFG_KEY) || "{}") },
  timer:         null,
  fundTimer:     null,
};

function saveCfg()    { localStorage.setItem(CFG_KEY,   JSON.stringify(state.cfg)); }
function saveAlerts() { localStorage.setItem(ALERT_KEY, JSON.stringify(state.alerts)); }

// ─── DATA FETCHING ────────────────────────────────────────────────────────────
function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchQuotes(symbols) {
  const usSyms = symbols.filter(s => !state.universe.find(u => u.symbol === s)?.international);
  if (!usSyms.length) return {};
  const out = {};
  await Promise.all(chunks(usSyms, 100).map(async c => {
    const r = await fetch(`/api/quotes?symbols=${c.join(",")}&duration=${state.duration}`);
    if (!r.ok) throw new Error(`quotes ${r.status}`);
    const j = await r.json();
    Object.assign(out, j.quotes || {});
  }));
  return out;
}

async function fetchFundamentals(symbols, { wantFmp = true } = {}) {
  const usSyms = symbols.filter(s => !state.universe.find(u => u.symbol === s)?.international);
  if (!usSyms.length) return;
  const stale = usSyms.filter(s => {
    const t = state.fundFetchedAt[s];
    if (!t || Date.now() - t > FUND_TTL_MS) return true;
    if (wantFmp && state.fundamentals[s] && !state.fundamentals[s].fmpLoaded) return true;
    return false;
  });
  if (!stale.length) return;
  const fmpFlag = wantFmp ? "&fmp=1" : "";
  await Promise.all(chunks(stale, 100).map(async c => {
    const r = await fetch(`/api/fundamentals?symbols=${c.join(",")}${fmpFlag}`);
    if (!r.ok) throw new Error(`fundamentals ${r.status}`);
    const j = await r.json();
    for (const [sym, data] of Object.entries(j.fundamentals || {})) {
      state.fundamentals[sym] = data;
      state.fundFetchedAt[sym] = Date.now();
    }
  }));
}

async function fetchNews(symbols) {
  if (!symbols.length) return;
  const stale = symbols.filter(s => {
    const t = state.newsFetchedAt[s];
    return !t || Date.now() - t > NEWS_TTL_MS;
  });
  if (!stale.length) return;
  const results = await Promise.allSettled(
    chunks(stale, 10).map(c =>
      fetch(`/api/news?symbols=${c.join(",")}&limit=10`).then(r => r.ok ? r.json() : null)
    )
  );
  for (const res of results) {
    if (res.status !== "fulfilled" || !res.value) continue;
    for (const [sym, data] of Object.entries(res.value.news || {})) {
      state.news[sym] = data;
      state.newsFetchedAt[sym] = Date.now();
    }
  }
}

async function refresh() {
  setStatus("Loading…");
  try {
    const syms = ALL_SYMBOLS;
    const [newQuotes] = await Promise.all([
      fetchQuotes(syms),
      fetchFundamentals(syms, { wantFmp: true }),
      fetchNews(syms),
    ]);
    state.quotes = { ...state.quotes, ...newQuotes };
    checkAlerts();
    render();
    const sample = Object.values(state.quotes).find(q => q);
    const open   = sample?.marketOpen;
    const asOf   = sample?.asOf ? new Date(sample.asOf).toLocaleDateString() : "";
    const tag    = open
      ? `<span style="color:#7A9B84;font-weight:600">● Live</span>`
      : `<span style="color:#C27941;font-weight:600">● Closed · ${asOf}</span>`;
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
    if (s.international) continue;
    const sym   = s.symbol;
    const q     = state.quotes[sym];
    const f     = state.fundamentals[sym];
    if (!q) continue;
    const price    = q.last;
    const sentScore = state.news[sym]?.sentimentScore ?? null;
    const score    = M.undervaluationScore(price, f, state.cfg, sentScore);
    const zone     = M.entryZone(price, f, state.cfg, sentScore);
    const entry    = M.entryPrice(price, f, state.cfg);
    const ltSc     = M.ltScore(price, f, state.cfg, sentScore);
    const triggers = [];

    if (zone === "Prime Entry")
      triggers.push(`🎯 Prime Entry — all LT signals aligned`);
    else if (zone === "Good Entry")
      triggers.push(`✅ Good Entry — price near ideal buy level`);

    if (score >= state.cfg.alertThresholdScore)
      triggers.push(`Undervaluation score ${score}/100 ≥ threshold`);

    if (entry != null && price <= entry * 1.02)
      triggers.push(`At/near entry price $${fmt(entry)}`);

    if (q.changePct != null && q.changePct <= -state.cfg.alertDropPct)
      triggers.push(`Dropped ${q.changePct.toFixed(1)}% (threshold −${state.cfg.alertDropPct}%)`);

    for (const msg of triggers) {
      const key = `${sym}::${msg}::${new Date().toDateString()}`;
      if (!state.alerts.find(a => a.key === key)) {
        state.alerts.unshift({ key, sym, msg, price, entry, ltScore: ltSc, ts: now });
        if (state.alerts.length > 200) state.alerts.pop();
      }
    }
  }
  saveAlerts();
  renderAlertBadge();
}

function renderAlertBadge() {
  const todayAlerts = state.alerts.filter(a => Date.now() - a.ts < 86_400_000);
  const badge = $("#alert-badge");
  if (!badge) return;
  if (todayAlerts.length) {
    badge.textContent = todayAlerts.length;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

// ─── TOOLTIPS ────────────────────────────────────────────────────────────────
const TIPS = {
  price:           "The current trading price of one share.",
  change:          "% price movement over the selected time period.",
  score:           "Undervaluation score 0–100. Combines fair value (DCF), RSI, P/B, P/E, and news sentiment. Higher = more potentially undervalued.",
  ltScore:         "Long-Term Score 0–100. Blends undervaluation (60%) + business quality (40%). Designed for 10yr+ investors seeking quality at a good price.",
  quality:         "Business Quality Score 0–100. ROE, operating margin, earnings growth, debt safety, and liquidity.",
  zone:            "Entry Zone: Prime Entry = price at/below entry price AND strong quality. Good Entry = undervalued with solid quality. Watch = one or two positive signals. Wait = no compelling signal yet.",
  entryPrice:      "Ideal entry price for long-term investors — the median of: DCF Fair Value ×0.75, Graham Number ×0.85, and 200-day MA ×0.95. This is where a disciplined long-term investor would typically start a position.",
  grahamNumber:    "Graham Number = √(22.5 × EPS × Book Value). Benjamin Graham's classic formula for a stock's maximum fair price.",
  fairValue:       "DCF intrinsic value — estimated true worth per share using a Discounted Cash Flow model.",
  mos:             "Margin of Safety = % discount to DCF fair value. 25%+ is typically considered a meaningful safety buffer.",
  rsi:             "RSI (0–100). Below 40 = possibly oversold. Above 70 = overbought. Around 50 = neutral momentum.",
  ma200:           "200-day moving average. Trading below it = stock is in a long-term downtrend — often a discount signal.",
  drawdown:        "% below 52-week high. −30% means the stock is 30% cheaper than its peak in the past year.",
  pe:              "Price/Earnings ratio. Under 15 is often value territory. Over 30 can suggest the stock is priced for perfection.",
  pb:              "Price/Book ratio. Under 1.5 = stock may trade near or below asset value.",
  evEbitda:        "Enterprise Value / EBITDA. Measures cheapness relative to operating earnings. Under 10 is often attractive.",
  dividendYield:   "Annual dividend as % of share price. Income while you hold long-term.",
  roe:             "Return on Equity — profit earned per dollar of shareholder equity. 15%+ is strong. Buffett's favourite metric.",
  debtToEquity:    "Debt relative to equity. Under 1 is generally safe. Over 2 warrants scrutiny.",
  grossMargin:     "Revenue minus cost of goods / revenue. Higher = stronger pricing power.",
  eps:             "Earnings Per Share. Growing EPS is a key signal for long-term compounders.",
  sentiment:       "Tone of recent news. Positive = constructive; negative = potential headwind.",
  high52w:         "Highest price in the last 52 weeks.",
  low52w:          "Lowest price in the last 52 weeks.",
};

function tip(key) {
  const text = TIPS[key] || "";
  if (!text) return "";
  return `<span class="tooltip-wrap">
    <span class="tooltip-icon">?</span>
    <span class="tooltip-box">${text}</span>
  </span>`;
}

// ─── RENDER HELPERS ───────────────────────────────────────────────────────────
const chip = pct => {
  if (pct == null || isNaN(pct)) return `<span style="color:var(--taupe)">—</span>`;
  const bg  = pct > 0 ? "rgba(122,155,132,0.18)" : pct < 0 ? "rgba(194,121,65,0.15)" : "rgba(168,136,133,0.12)";
  const col = pct > 0 ? "var(--sage)"            : pct < 0 ? "var(--terracotta)"     : "var(--taupe)";
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
  const map = {
    "Prime Entry": ["#2D6A4F", "white"],
    "Good Entry":  ["var(--sage)", "white"],
    "Watch":       ["var(--gold-light)", "var(--navy)"],
    "Wait":        ["rgba(194,121,65,0.12)", "var(--terracotta)"],
    "Strong Buy":  ["var(--sage)", "white"],
    "Overvalued":  ["rgba(194,121,65,0.12)", "var(--terracotta)"],
  };
  const [bg, col] = map[zone] || ["var(--border)", "var(--navy)"];
  return `<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:0.75rem;font-weight:600;background:${bg};color:${col}">${zone}</span>`;
};

const scoreBar = (score, color) => {
  if (score == null) return `<span style="color:var(--taupe)">—</span>`;
  const col = color || (score >= 70 ? "var(--sage)" : score >= 45 ? "var(--gold)" : "var(--terracotta)");
  return `<div style="display:flex;align-items:center;gap:6px">
    <div style="width:56px;height:6px;background:var(--gold-light);border-radius:3px;overflow:hidden">
      <div style="width:${score}%;height:100%;background:${col};border-radius:3px;transition:width 0.4s"></div>
    </div>
    <span style="font-size:0.75rem;font-weight:700;font-variant-numeric:tabular-nums;color:${col}">${score}</span>
  </div>`;
};

const starBtn = () => `<span style="font-size:1rem;color:var(--gold)" title="On your watchlist">★</span>`;

function metricFor(sym) {
  const q     = state.quotes[sym];
  const f     = state.fundamentals[sym];
  const n     = state.news[sym];
  const price = q?.last ?? null;
  const sentimentScore = n?.sentimentScore ?? null;
  const fv    = M.dcfFairValue(price, f, state.cfg);
  return {
    price,
    changePct:          q?.changePct ?? null,
    rsi:                M.rsi(f),
    ma50:               M.ma50(f),
    ma200:              M.ma200(f),
    drawdown:           M.drawdownFrom52wHigh(f),
    fairValue:          fv,
    mos:                M.marginOfSafety(price, fv),
    grahamNumber:       M.grahamNumber(f),
    entryPrice:         M.entryPrice(price, f, state.cfg),
    score:              M.undervaluationScore(price, f, state.cfg, sentimentScore),
    qualityScore:       M.qualityScore(f),
    ltScore:            M.ltScore(price, f, state.cfg, sentimentScore),
    zone:               M.entryZone(price, f, state.cfg, sentimentScore),
    buyZone:            M.buyZone(price, f, state.cfg),
    high52w:            f?.high52w       ?? null,
    low52w:             f?.low52w        ?? null,
    sentimentScore,
    articles:           n?.articles      ?? [],
    pe:                 f?.pe            ?? null,
    pbRatio:            f?.pbRatio       ?? null,
    evEbitda:           f?.evEbitda      ?? null,
    dividendYield:      f?.dividendYield ?? null,
    roe:                f?.roe           ?? null,
    debtToEquity:       f?.debtToEquity  ?? null,
    grossMargin:        f?.grossMargin   ?? null,
    operatingMargin:    f?.operatingMargin ?? null,
    eps:                f?.eps           ?? null,
    revenueGrowthYoy:   f?.revenueGrowthYoy   ?? null,
    earningsGrowthYoy:  f?.earningsGrowthYoy  ?? null,
  };
}

// ─── SUMMARY CARDS ────────────────────────────────────────────────────────────
function renderSummaryCards() {
  const scored = state.universe.filter(s => !s.international).map(s => ({
    ...s, ...metricFor(s.symbol),
  })).filter(s => s.ltScore != null && s.price != null);
  scored.sort((a, b) => b.ltScore - a.ltScore);
  const top5         = scored.slice(0, 5);
  const primeEntries = scored.filter(s => s.zone === "Prime Entry").length;
  const goodEntries  = scored.filter(s => s.zone === "Good Entry").length;
  const todayAlerts  = state.alerts.filter(a => Date.now() - a.ts < 86_400_000).length;
  const intlCount    = state.universe.filter(s => s.international).length;

  const topRows = top5.map(s => `
    <tr class="cursor-pointer" data-symbol="${s.symbol}"
        onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''">
      <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
      <td style="padding:9px 12px;font-size:0.8rem;color:var(--taupe);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem">$${fmt(s.price)}</td>
      <td style="padding:9px 12px">${scoreBar(s.ltScore)}</td>
      <td style="padding:9px 12px">${zoneChip(s.zone)}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.8rem;color:var(--sage)">${s.entryPrice ? "$"+fmt(s.entryPrice) : "—"}</td>
    </tr>`).join("");
  const emptyRow = `<tr><td colspan="6" style="padding:14px;font-size:0.875rem;color:var(--taupe)">Prices loading… fundamentals follow shortly.</td></tr>`;

  return `
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:14px;margin-bottom:20px">
    <div class="med-card med-card-sage" style="padding:16px">
      <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--taupe);margin-bottom:6px">Prime Entry ${tip("zone")}</p>
      <p style="font-size:2rem;font-family:Georgia,serif;font-weight:700;color:#2D6A4F;margin-bottom:2px">${primeEntries}</p>
      <p style="font-size:0.75rem;color:var(--taupe)">${goodEntries} Good Entry · 10yr+ signals</p>
    </div>
    <div class="med-card med-card-gold" style="padding:16px">
      <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--taupe);margin-bottom:6px">Watchlist</p>
      <p style="font-size:2rem;font-family:Georgia,serif;font-weight:700;color:var(--navy);margin-bottom:2px">${state.universe.length}</p>
      <p style="font-size:0.75rem;color:var(--taupe)">${scored.length} scored · ${intlCount} international</p>
    </div>
    <div class="med-card med-card-terra" style="padding:16px;cursor:pointer" id="alerts-card">
      <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--taupe);margin-bottom:6px">Today's Alerts</p>
      <p style="font-size:2rem;font-family:Georgia,serif;font-weight:700;color:var(--terracotta);margin-bottom:2px">${todayAlerts}</p>
      <p style="font-size:0.75rem;color:var(--taupe)">tap to view →</p>
    </div>
  </div>
  <div class="med-card med-card-gold" style="margin-bottom:20px">
    <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span style="font-family:Georgia,serif;font-weight:600;color:var(--navy)">🏆 Top LT Opportunities</span>
      <span style="font-size:0.75rem;color:var(--taupe)">ranked by Long-Term Score — quality + value combined</span>
    </div>
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="padding:9px 12px;background:#faf8f4;font-size:0.7rem;color:var(--taupe);border-bottom:1px solid var(--border);letter-spacing:0.06em;text-transform:uppercase">Ticker</th>
          <th style="padding:9px 12px;background:#faf8f4;font-size:0.7rem;color:var(--taupe);border-bottom:1px solid var(--border);letter-spacing:0.06em;text-transform:uppercase">Name</th>
          <th style="padding:9px 12px;background:#faf8f4;font-size:0.7rem;color:var(--taupe);border-bottom:1px solid var(--border);letter-spacing:0.06em;text-transform:uppercase;text-align:right">Price</th>
          <th style="padding:9px 12px;background:#faf8f4;font-size:0.7rem;color:var(--taupe);border-bottom:1px solid var(--border);letter-spacing:0.06em;text-transform:uppercase">LT Score ${tip("ltScore")}</th>
          <th style="padding:9px 12px;background:#faf8f4;font-size:0.7rem;color:var(--taupe);border-bottom:1px solid var(--border);letter-spacing:0.06em;text-transform:uppercase">Zone</th>
          <th style="padding:9px 12px;background:#faf8f4;font-size:0.7rem;color:var(--taupe);border-bottom:1px solid var(--border);letter-spacing:0.06em;text-transform:uppercase;text-align:right">Entry Price ${tip("entryPrice")}</th>
        </tr></thead>
        <tbody>${topRows || emptyRow}</tbody>
      </table>
    </div>
  </div>`;
}

// ─── TABLE ROWS ───────────────────────────────────────────────────────────────
function rowHtml(s, showValue = false) {
  const m = metricFor(s.symbol);
  if (!showValue) {
    return `
    <tr data-symbol="${s.symbol}"
        onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''"
        style="border-bottom:1px solid #f0ebe0;cursor:pointer">
      <td style="padding:9px 12px">${starBtn()}</td>
      <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
      <td style="padding:9px 12px;font-size:0.82rem;color:var(--taupe);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem">$${fmt(m.price)}</td>
      <td style="padding:9px 12px;text-align:right">${chip(m.changePct)}</td>
      <td style="padding:9px 12px;font-size:0.8rem;color:var(--taupe)">${s.industry}</td>
    </tr>`;
  }
  const rsiColor   = m.rsi == null ? "var(--navy)"
    : m.rsi < 40 ? "var(--sage)" : m.rsi > 70 ? "var(--terracotta)" : "var(--navy)";
  const ma200Color = m.price != null && m.ma200 != null
    ? (m.price < m.ma200 ? "var(--sage)" : "var(--terracotta)") : "var(--navy)";
  return `
    <tr data-symbol="${s.symbol}"
        onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''"
        style="border-bottom:1px solid #f0ebe0;cursor:pointer">
      <td style="padding:9px 12px">${starBtn()}</td>
      <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
      <td style="padding:9px 12px;font-size:0.82rem;color:var(--taupe);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem">$${fmt(m.price)}</td>
      <td style="padding:9px 12px;text-align:right">${chip(m.changePct)}</td>
      <td style="padding:9px 12px">${scoreBar(m.ltScore)}</td>
      <td style="padding:9px 12px">${zoneChip(m.zone)}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.875rem;font-weight:600;color:var(--sage)">${m.entryPrice ? "$"+fmt(m.entryPrice) : "—"}</td>
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
  const baseHead  = `${th("")}${th("Ticker")}${th("Name")}${th("Price","price","right")}${th("Change","change","right")}`;
  const valueHead = showValue
    ? `${th("LT Score","ltScore")}${th("Zone","zone")}${th("Entry Price","entryPrice","right")}${th("RSI","rsi","right")}${th("MA 200","ma200","right")}${th("Drawdown","drawdown","right")}${th("Margin of Safety","mos","right")}${th("Fair Value","fairValue","right")}${th("Sentiment","sentiment")}`
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
  return stocks.filter(s => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q));
}

function sectorAggregate(stocks) {
  const vals = stocks.map(s => state.quotes[s.symbol]?.changePct).filter(v => v != null);
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ─── TAB: WATCHLIST ───────────────────────────────────────────────────────────
function renderWatchlist() {
  const summary = renderSummaryCards();
  const groups  = state.universe.reduce((acc, s) => { (acc[s.sector] ||= []).push(s); return acc; }, {});
  const sectors = Object.keys(groups).sort((a, b) => {
    if (a === "International") return 1;
    if (b === "International") return -1;
    return a.localeCompare(b);
  });
  const cards = sectors.map(sec => {
    const stocks  = groups[sec];
    const isIntl  = sec === "International";
    const avg     = sectorAggregate(stocks);
    const winners = stocks.filter(s => (state.quotes[s.symbol]?.changePct ?? 0) > 0).length;
    return `
      <details class="med-card mb-2" ${isIntl ? "" : "open"}>
        <summary class="cursor-pointer px-4 py-3 flex items-center gap-3" style="border-radius:10px">
          <span style="font-family:Georgia,serif;font-weight:600;color:var(--navy);flex:1">${sec}</span>
          <span style="font-size:0.75rem;color:var(--taupe)">${stocks.length} stock${stocks.length > 1 ? "s" : ""}${isIntl ? " · no live price" : ` · ${winners} up`}</span>
          ${isIntl ? "" : chip(avg)}
          <span style="color:var(--taupe);font-size:0.8rem">▾</span>
        </summary>
        <div style="overflow-x:auto;border-top:1px solid var(--border)">
          ${isIntl ? intlTable(stocks) : tableHtml(stocks, true)}
        </div>
      </details>`;
  }).join("");
  $("#content").innerHTML = `${summary}<div>${cards}</div>`;
  bindSummaryEvents();
}

function intlTable(stocks) {
  const th = label => `<th style="padding:10px 12px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)">${label}</th>`;
  const rows = stocks.map(s => `
    <tr style="border-bottom:1px solid #f0ebe0">
      <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
      <td style="padding:9px 12px;font-size:0.82rem;color:var(--taupe)">${s.name}</td>
      <td style="padding:9px 12px;font-size:0.8rem;color:var(--taupe)">${s.industry}</td>
      <td style="padding:9px 12px;font-size:0.75rem;color:var(--terracotta)">⚠ Check your broker for live price</td>
    </tr>`).join("");
  return `<table style="width:100%;border-collapse:collapse">
    <thead><tr>${th("Symbol")}${th("Name")}${th("Exchange / Type")}${th("Note")}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ─── TAB: VALUE RANK ──────────────────────────────────────────────────────────
function renderValue() {
  const scored = [...state.universe].filter(s => !s.international).map(s => ({ ...s, ...metricFor(s.symbol) }));
  scored.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const filtered = filterBySearch(scored);
  if (!filtered.length) {
    $("#content").innerHTML = `<div class="med-card" style="padding:32px;text-align:center;color:var(--taupe)">No data yet — prices and fundamentals are loading. Hit ↻ Refresh.</div>`;
    return;
  }
  $("#content").innerHTML = `
    <div class="med-card med-card-gold" style="overflow-x:auto">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:0.8rem;color:var(--taupe)">Ranked by undervaluation score. Fundamentals refresh hourly.</span>
        <button id="open-settings" class="btn-secondary" style="margin-left:auto;white-space:nowrap">⚙ Edit Assumptions</button>
      </div>
      ${tableHtml(filtered, true)}
    </div>`;
  document.getElementById("open-settings")?.addEventListener("click", openSettings);
}

// ─── TAB: LT OPPORTUNITIES ────────────────────────────────────────────────────
function renderLTOpportunities() {
  const all = [...state.universe].filter(s => !s.international).map(s => ({
    ...s, ...metricFor(s.symbol),
  })).filter(s => s.price != null);

  all.sort((a, b) => ((b[state.ltSortBy] ?? -999) - (a[state.ltSortBy] ?? -999)));
  const filtered = filterBySearch(all);
  const prime    = filtered.filter(s => s.zone === "Prime Entry");
  const good     = filtered.filter(s => s.zone === "Good Entry");
  const watch    = filtered.filter(s => s.zone === "Watch");

  const sortBtn = (key, label) => {
    const active = state.ltSortBy === key;
    return `<button class="lt-sort-btn" data-sort="${key}"
      style="padding:4px 12px;border-radius:20px;font-size:0.78rem;font-weight:500;cursor:pointer;
             border:1.5px solid ${active ? 'var(--navy)' : 'var(--border)'};
             background:${active ? 'var(--navy)' : 'white'};
             color:${active ? 'var(--cream)' : 'var(--taupe)'}">${label}</button>`;
  };

  if (!filtered.length) {
    $("#content").innerHTML = `<div class="med-card" style="padding:32px;text-align:center;color:var(--taupe)">Loading data…</div>`;
    return;
  }

  const zoneBanner = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px">
      <div class="med-card" style="padding:14px 16px;border-left:4px solid #2D6A4F">
        <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--taupe);margin-bottom:4px">Prime Entry</p>
        <p style="font-size:1.8rem;font-family:Georgia,serif;font-weight:700;color:#2D6A4F">${prime.length}</p>
        <p style="font-size:0.72rem;color:var(--taupe);margin-top:2px">All LT signals aligned</p>
      </div>
      <div class="med-card" style="padding:14px 16px;border-left:4px solid var(--sage)">
        <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--taupe);margin-bottom:4px">Good Entry</p>
        <p style="font-size:1.8rem;font-family:Georgia,serif;font-weight:700;color:var(--sage)">${good.length}</p>
        <p style="font-size:0.72rem;color:var(--taupe);margin-top:2px">Quality + value signals</p>
      </div>
      <div class="med-card" style="padding:14px 16px;border-left:4px solid var(--gold)">
        <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--taupe);margin-bottom:4px">Watch</p>
        <p style="font-size:1.8rem;font-family:Georgia,serif;font-weight:700;color:var(--gold)">${watch.length}</p>
        <p style="font-size:0.72rem;color:var(--taupe);margin-top:2px">Approaching entry</p>
      </div>
      <div class="med-card" style="padding:14px 16px;border-left:4px solid var(--taupe)">
        <p style="font-size:0.7rem;text-transform:uppercase;letter-spacing:0.07em;color:var(--taupe);margin-bottom:4px">10yr Horizon</p>
        <p style="font-size:1rem;font-family:Georgia,serif;font-weight:600;color:var(--navy);margin-top:8px">Buy quality at fair price</p>
      </div>
    </div>`;

  // Actionable cards
  const actionable = [...prime, ...good];
  let cardsHtml = "";
  if (actionable.length) {
    const cards = actionable.slice(0, 12).map(s => {
      const pctToEntry = s.entryPrice && s.price ? ((s.entryPrice - s.price) / s.price * 100) : null;
      const atEntry    = pctToEntry != null && pctToEntry >= -2;
      const isPrime    = s.zone === "Prime Entry";
      const borderCol  = isPrime ? "#2D6A4F" : "var(--sage)";
      const zoneLabel  = isPrime
        ? `<span style="font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:20px;background:#2D6A4F;color:white">🎯 Prime Entry</span>`
        : `<span style="font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:20px;background:var(--sage);color:white">✅ Good Entry</span>`;
      return `
        <div class="med-card" style="padding:16px;border-left:4px solid ${borderCol};cursor:pointer;transition:box-shadow 0.15s"
             data-symbol="${s.symbol}"
             onmouseenter="this.style.boxShadow='0 4px 14px rgba(45,62,79,0.1)'" onmouseleave="this.style.boxShadow=''">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
            <div>
              <span style="font-family:monospace;font-weight:700;color:var(--navy);font-size:1rem">${s.symbol}</span>
              <span style="font-size:0.78rem;color:var(--taupe);margin-left:6px">${s.sector}</span>
            </div>
            ${zoneLabel}
          </div>
          <p style="font-size:0.8rem;color:var(--taupe);margin-bottom:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${s.name}</p>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
            <div style="background:#faf8f4;border-radius:6px;padding:8px 10px">
              <p style="font-size:0.65rem;color:var(--taupe);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px">Current Price</p>
              <p style="font-family:monospace;font-weight:700;color:var(--navy);font-size:0.95rem">$${fmt(s.price)}</p>
            </div>
            <div style="background:${atEntry ? 'rgba(45,106,79,0.1)' : '#faf8f4'};border-radius:6px;padding:8px 10px">
              <p style="font-size:0.65rem;color:var(--taupe);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:2px">Entry Price ${tip("entryPrice")}</p>
              <p style="font-family:monospace;font-weight:700;color:${atEntry ? '#2D6A4F' : 'var(--navy)'};font-size:0.95rem">
                ${s.entryPrice ? "$"+fmt(s.entryPrice) : "—"}
                ${pctToEntry != null ? `<span style="font-size:0.7rem;font-weight:500;margin-left:3px;color:${pctToEntry < 0 ? 'var(--sage)' : 'var(--terracotta)'}">${pctToEntry >= 0 ? '▼' : '▲'}${Math.abs(pctToEntry).toFixed(1)}%</span>` : ""}
              </p>
            </div>
            <div style="background:#faf8f4;border-radius:6px;padding:8px 10px">
              <p style="font-size:0.65rem;color:var(--taupe);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px">LT Score ${tip("ltScore")}</p>
              ${scoreBar(s.ltScore)}
            </div>
            <div style="background:#faf8f4;border-radius:6px;padding:8px 10px">
              <p style="font-size:0.65rem;color:var(--taupe);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:3px">Quality ${tip("quality")}</p>
              ${scoreBar(s.qualityScore, s.qualityScore != null && s.qualityScore >= 70 ? "#2D6A4F" : s.qualityScore >= 45 ? "var(--gold)" : "var(--taupe)")}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:0.75rem;color:var(--taupe)">
            ${s.pe            != null ? `<span>P/E <b style="color:var(--navy)">${s.pe}</b></span>` : ""}
            ${s.pbRatio       != null ? `<span>P/B <b style="color:var(--navy)">${s.pbRatio?.toFixed(1)}</b></span>` : ""}
            ${s.roe           != null ? `<span>ROE <b style="color:var(--navy)">${fmtPct(s.roe)}</b></span>` : ""}
            ${s.dividendYield != null && s.dividendYield > 0 ? `<span>Yield <b style="color:var(--sage)">${fmtPct(s.dividendYield)}</b></span>` : ""}
            ${s.drawdown      != null ? `<span>Drawdown <b style="color:var(--terracotta)">${s.drawdown.toFixed(1)}%</b></span>` : ""}
          </div>
        </div>`;
    }).join("");
    cardsHtml = `
      <div style="margin-bottom:20px">
        <p style="font-family:Georgia,serif;font-weight:600;color:var(--navy);margin-bottom:12px">Actionable Now — Prime & Good Entry</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">${cards}</div>
      </div>`;
  }

  // Full table
  const thLT = (label, tipKey, sortKey, align = "") => {
    const active = state.ltSortBy === sortKey;
    return `<th style="padding:10px 12px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;
                        color:${active ? 'var(--navy)' : 'var(--taupe)'};border-bottom:1px solid var(--border);
                        white-space:nowrap;cursor:pointer;user-select:none;${align ? 'text-align:right' : ''}"
            class="lt-th" data-sort="${sortKey}">
      <span class="tooltip-wrap" style="${align ? 'justify-content:flex-end' : ''}">
        ${label}${active ? ' ▾' : ''}${tipKey ? `<span class="tooltip-icon">?</span><span class="tooltip-box">${TIPS[tipKey]||''}</span>` : ""}
      </span>
    </th>`;
  };

  const rows = filtered.map(s => {
    const pctToEntry = s.entryPrice && s.price ? ((s.entryPrice - s.price) / s.price * 100) : null;
    const atEntry    = pctToEntry != null && pctToEntry >= -2;
    return `
    <tr data-symbol="${s.symbol}"
        onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''"
        style="border-bottom:1px solid #f0ebe0;cursor:pointer">
      <td style="padding:9px 12px;font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
      <td style="padding:9px 12px;font-size:0.8rem;color:var(--taupe);max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace">$${fmt(s.price)}</td>
      <td style="padding:9px 12px;text-align:right">${chip(s.changePct)}</td>
      <td style="padding:9px 12px">${scoreBar(s.ltScore)}</td>
      <td style="padding:9px 12px">${scoreBar(s.qualityScore, s.qualityScore != null && s.qualityScore >= 70 ? "#2D6A4F" : s.qualityScore >= 45 ? "var(--gold)" : "var(--taupe)")}</td>
      <td style="padding:9px 12px">${zoneChip(s.zone)}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-weight:700;color:${atEntry ? '#2D6A4F' : 'var(--navy)'}">
        ${s.entryPrice ? "$"+fmt(s.entryPrice) : "—"}
        ${pctToEntry != null ? `<br><span style="font-size:0.7rem;font-weight:400;color:${pctToEntry < 0 ? 'var(--sage)' : 'var(--terracotta)'}">${pctToEntry >= 0 ? '▼' : '▲'}${Math.abs(pctToEntry).toFixed(1)}%</span>` : ""}
      </td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace">$${fmt(s.fairValue)}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace">${s.mos != null ? s.mos.toFixed(1)+"%" : "—"}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.8rem">${s.pe ?? "—"}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.8rem">${s.pbRatio?.toFixed(1) ?? "—"}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.8rem">${s.roe != null ? fmtPct(s.roe) : "—"}</td>
      <td style="padding:9px 12px;text-align:right;font-family:monospace;font-size:0.8rem">${s.debtToEquity?.toFixed(2) ?? "—"}</td>
      <td style="padding:9px 12px">${sentimentChip(s.sentimentScore)}</td>
    </tr>`;
  }).join("");

  $("#content").innerHTML = `
    ${zoneBanner}
    ${cardsHtml}
    <div class="med-card" style="overflow-x:auto">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-family:Georgia,serif;font-weight:600;color:var(--navy)">All Stocks — Full LT View</span>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-left:auto">
          ${sortBtn("ltScore",      "LT Score")}
          ${sortBtn("qualityScore", "Quality")}
          ${sortBtn("score",        "Undervalue")}
          ${sortBtn("mos",          "Margin of Safety")}
          ${sortBtn("entryPrice",   "Entry Price")}
        </div>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          ${thLT("Ticker",    null,         "symbol")}
          ${thLT("Name",      null,         "name")}
          ${thLT("Price",     "price",      "price",         "right")}
          ${thLT("Change",    "change",     "changePct",     "right")}
          ${thLT("LT Score",  "ltScore",    "ltScore")}
          ${thLT("Quality",   "quality",    "qualityScore")}
          ${thLT("Zone",      "zone",       "zone")}
          ${thLT("Entry $",   "entryPrice", "entryPrice",    "right")}
          ${thLT("Fair Value","fairValue",  "fairValue",     "right")}
          ${thLT("MoS%",      "mos",        "mos",           "right")}
          ${thLT("P/E",       "pe",         "pe",            "right")}
          ${thLT("P/B",       "pb",         "pbRatio",       "right")}
          ${thLT("ROE",       "roe",        "roe",           "right")}
          ${thLT("D/E",       "debtToEquity","debtToEquity", "right")}
          ${thLT("Sentiment", "sentiment",  "sentimentScore")}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  document.querySelectorAll(".lt-sort-btn,.lt-th").forEach(el => {
    el.addEventListener("click", () => { state.ltSortBy = el.dataset.sort; renderLTOpportunities(); });
  });
}

// ─── TAB: ALERTS ─────────────────────────────────────────────────────────────
function renderAlerts() {
  const items = state.alerts.slice(0, 100);
  if (!items.length) {
    $("#content").innerHTML = `<div class="med-card p-10 text-center" style="color:var(--taupe)">
      <p class="text-lg mb-2">No alerts yet.</p>
      <p class="text-sm">Alerts fire when a stock enters Prime Entry, Good Entry, hits your score threshold, or drops sharply. Edit thresholds in ⚙ Settings.</p>
    </div>`;
    return;
  }
  const rows = items.map(a => `
    <tr data-symbol="${a.sym}" style="border-bottom:1px solid #f0ebe0;cursor:pointer"
        onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''">
      <td style="padding:10px 14px;font-family:monospace;font-weight:700;color:var(--navy)">${a.sym}</td>
      <td style="padding:10px 14px;font-size:0.875rem;color:var(--terracotta)">${a.msg}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:0.875rem">$${fmt(a.price)}</td>
      <td style="padding:10px 14px;text-align:right;font-family:monospace;font-size:0.8rem;color:var(--sage)">${a.entry ? "$"+fmt(a.entry) : "—"}</td>
      <td style="padding:10px 14px;font-size:0.75rem;color:var(--taupe)">${new Date(a.ts).toLocaleString()}</td>
    </tr>`).join("");
  $("#content").innerHTML = `
    <div class="med-card med-card-terra" style="overflow-x:auto">
      <div style="padding:12px 16px;display:flex;align-items:center;gap:8px;border-bottom:1px solid var(--border)">
        <span style="font-family:Georgia,serif;font-weight:600;color:var(--navy)">🔔 Alerts</span>
        <span style="font-size:0.75rem;color:var(--taupe)">Click a row to view the stock</span>
        <button id="clear-alerts" class="btn-secondary ml-auto" style="color:var(--terracotta);border-color:var(--terracotta)">Clear all</button>
      </div>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr>
          ${["Symbol","Trigger","Price at Alert","Entry Price","When"].map((h,i) =>
            `<th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)${i===2||i===3?';text-align:right':''}">${h}${i===3 ? ' '+tip("entryPrice") : ""}</th>`
          ).join("")}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  document.getElementById("clear-alerts")?.addEventListener("click", () => {
    state.alerts = []; saveAlerts(); renderAlerts(); renderAlertBadge();
  });
}

// ─── TAB: SENTIMENT ───────────────────────────────────────────────────────────
function renderSentiment() {
  const all = state.universe.filter(s => !s.international).map(s => {
    const n = state.news[s.symbol];
    const q = state.quotes[s.symbol];
    return { ...s, price: q?.last ?? null, changePct: q?.changePct ?? null,
             sentimentScore: n?.sentimentScore ?? null, articles: n?.articles ?? [] };
  }).filter(s => s.sentimentScore != null);

  if (!all.length) {
    $("#content").innerHTML = `<div class="med-card p-10 text-center" style="color:var(--taupe)">
      <p class="text-lg mb-2">No sentiment data loaded yet.</p>
      <p class="text-sm">Sentiment loads alongside prices. Wait a moment and hit ↻ Refresh.</p>
    </div>`;
    return;
  }

  const positive = all.filter(s => s.sentimentScore >  0.15).sort((a,b) => b.sentimentScore - a.sentimentScore);
  const negative = all.filter(s => s.sentimentScore < -0.15).sort((a,b) => a.sentimentScore - b.sentimentScore);
  const neutral  = all.filter(s => s.sentimentScore >= -0.15 && s.sentimentScore <= 0.15);
  const total    = all.length;
  const pPct     = Math.round(positive.length / total * 100);
  const nPct     = Math.round(negative.length / total * 100);

  const summaryBar = `
    <div class="med-card med-card-gold" style="padding:20px;margin-bottom:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <span style="font-family:Georgia,serif;font-weight:600;color:var(--navy)">Market Sentiment Overview</span>
        <span style="font-size:0.75rem;color:var(--taupe)">${total} stocks · refreshes every 15 min</span>
      </div>
      <div style="display:flex;border-radius:6px;overflow:hidden;height:14px;margin-bottom:12px">
        <div style="background:var(--sage);width:${pPct}%"></div>
        <div style="background:var(--border);width:${100-pPct-nPct}%"></div>
        <div style="background:var(--terracotta);width:${nPct}%"></div>
      </div>
      <div style="display:flex;gap:20px;font-size:0.78rem">
        <span style="color:var(--sage)">▲ Positive ${positive.length} (${pPct}%)</span>
        <span style="color:var(--taupe)">● Neutral ${neutral.length} (${100-pPct-nPct}%)</span>
        <span style="color:var(--terracotta)">▼ Negative ${negative.length} (${nPct}%)</span>
      </div>
    </div>`;

  const sentThead = `<thead><tr>
    ${["Ticker","Name","Price","Change","Score","Latest Headline"].map(h =>
      `<th style="padding:10px 14px;background:#faf8f4;font-size:0.7rem;letter-spacing:0.06em;text-transform:uppercase;color:var(--taupe);border-bottom:1px solid var(--border)${h==='Price'||h==='Change'?';text-align:right':''}">${h}</th>`
    ).join("")}
  </tr></thead>`;

  const sentimentRow = s => {
    const bar    = sentimentBarHtml(s.sentimentScore);
    const latest = s.articles[0];
    return `
      <tr data-symbol="${s.symbol}" style="border-bottom:1px solid #f0ebe0;cursor:pointer"
          onmouseenter="this.style.background='#faf8f3'" onmouseleave="this.style.background=''">
        <td style="padding:10px 14px;font-family:monospace;font-weight:700;color:var(--navy)">${s.symbol}</td>
        <td style="padding:10px 14px;font-size:0.8rem;color:var(--taupe);max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</td>
        <td style="padding:10px 14px;text-align:right;font-family:monospace">$${fmt(s.price)}</td>
        <td style="padding:10px 14px;text-align:right">${chip(s.changePct)}</td>
        <td style="padding:10px 14px">${bar}</td>
        <td style="padding:10px 14px;font-size:0.8rem;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${latest ? `<span style="color:var(--navy)">${latest.headline}</span> <span style="color:var(--taupe)">· ${timeAgo(latest.publishedAt)}</span>` : "—"}
        </td>
      </tr>`;
  };

  const block = (list, label, color, cardClass) => list.length ? `
    <div class="med-card ${cardClass}" style="margin-bottom:16px">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px">
        <span style="width:10px;height:10px;border-radius:50%;background:${color};display:inline-block"></span>
        <span style="font-family:Georgia,serif;font-weight:600;color:var(--navy)">${label}</span>
        <span style="font-size:0.75rem;color:var(--taupe)">${list.length} stocks</span>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse">${sentThead}<tbody>${list.map(sentimentRow).join("")}</tbody></table>
      </div>
    </div>` : "";

  $("#content").innerHTML = summaryBar
    + block(positive, "▲ Positive Sentiment", "var(--sage)", "med-card-sage")
    + block(negative, "▼ Negative Sentiment", "var(--terracotta)", "med-card-terra")
    + (neutral.length ? `
      <details class="med-card" style="margin-bottom:16px">
        <summary style="padding:12px 16px;cursor:pointer;display:flex;align-items:center;gap:8px;border-radius:10px">
          <span style="width:10px;height:10px;border-radius:50%;background:var(--border);display:inline-block"></span>
          <span style="font-family:Georgia,serif;font-weight:600;color:var(--navy)">Neutral</span>
          <span style="font-size:0.75rem;color:var(--taupe)">${neutral.length} stocks</span>
          <span style="margin-left:auto;color:var(--taupe);font-size:0.8rem">▾</span>
        </summary>
        <div style="overflow-x:auto;border-top:1px solid var(--border)">
          <table style="width:100%;border-collapse:collapse">${sentThead}<tbody>${neutral.map(sentimentRow).join("")}</tbody></table>
        </div>
      </details>` : "");
}

function sentimentBarHtml(score) {
  if (score == null) return `<span style="color:var(--taupe)">—</span>`;
  const pct   = Math.abs(score) * 100;
  const isPos = score >= 0;
  const color = score >  0.15 ? "var(--sage)" : score < -0.15 ? "var(--terracotta)" : "var(--taupe)";
  const label = score > 0.15 ? `+${score.toFixed(2)}` : score.toFixed(2);
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
      <span style="font-size:0.75rem;font-weight:700;color:${color}">${label}</span>
    </div>`;
}

// ─── RENDER DISPATCHER ────────────────────────────────────────────────────────
function render() {
  if      (state.tab === "lt")        renderLTOpportunities();
  else if (state.tab === "value")     renderValue();
  else if (state.tab === "alerts")    renderAlerts();
  else if (state.tab === "sentiment") renderSentiment();
  else                                renderWatchlist();
}

function bindSummaryEvents() {
  document.getElementById("alerts-card")?.addEventListener("click", () => switchTab("alerts"));
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
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
      <p style="font-size:0.8rem;color:var(--taupe);margin-bottom:16px;line-height:1.5">These values drive the Fair Value, Entry Price, and LT Score calculations.</p>
      <div style="display:flex;flex-direction:column;gap:12px;font-size:0.875rem">
        ${cfgField("discountRate",        "Discount Rate (WACC)",              c.discountRate,        "0.01","0.30","0.01","10% = typical required return.")}
        ${cfgField("revenueGrowth",       "Expected Revenue Growth Rate",      c.revenueGrowth,       "0.01","0.40","0.01","8% = moderate growth assumption.")}
        ${cfgField("terminalGrowth",      "Long-Term Growth Rate",             c.terminalGrowth,      "0.00","0.05","0.01","2–3% = GDP-like terminal rate.")}
        ${cfgField("projectionYears",     "Years to Project",                  c.projectionYears,     "3","20","1","10 years is the LT standard.")}
        ${cfgField("marginOfSafetyPct",   "Margin of Safety % for Strong Buy", c.marginOfSafetyPct,   "5","50","5","25% = 25% discount to fair value.")}
        ${cfgField("alertThresholdScore", "Alert when Score reaches ≥",        c.alertThresholdScore, "50","100","5","Undervaluation score threshold 0–100.")}
        ${cfgField("alertDropPct",        "Alert when Price drops ≥ %",        c.alertDropPct,        "3","50","1","% drop to trigger an alert.")}
        ${cfgField("rsiOversold",         "RSI Oversold Level",                c.rsiOversold,         "20","50","1","RSI below this = oversold signal.")}
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
    ["discountRate","revenueGrowth","terminalGrowth","projectionYears",
     "marginOfSafetyPct","alertThresholdScore","alertDropPct","rsiOversold"].forEach(k => {
      const el = document.getElementById(`cfg-${k}`);
      if (el) state.cfg[k] = +el.value;
    });
    saveCfg(); closeSettings(); render();
  });
  document.getElementById("settings-reset").addEventListener("click", () => {
    state.cfg = { ...DEFAULT_CFG }; saveCfg(); closeSettings(); render();
  });
}

function cfgField(key, label, value, min, max, step, hint) {
  return `<label class="block">
    <span style="color:var(--navy);font-size:0.85rem;font-weight:500">${label}</span>
    ${hint ? `<span style="color:var(--taupe);font-size:0.75rem;margin-left:4px">${hint}</span>` : ""}
    <input id="cfg-${key}" type="number" min="${min}" max="${max}" step="${step}" value="${value}"
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
  const f = state.fundamentals[symbol];

  $("#m-symbol").textContent = symbol;
  $("#m-name").textContent   = `${stock.name} · ${stock.sector} / ${stock.industry}`;
  $("#m-price").textContent  = q ? `$${fmt(q.last)}` : "—";
  $("#m-change").innerHTML   = chip(q?.changePct);

  const dcfSource = f?.fcfYield != null ? "FCF Yield (FMP)" : f?.eps != null ? "EPS (FMP)" : "5% yield proxy";
  const hasFmp    = f?.fmpLoaded === true;
  const dataBadge = hasFmp
    ? `<span style="font-size:0.75rem;padding:2px 8px;border-radius:4px;background:rgba(122,155,132,0.15);color:var(--sage);border:1px solid rgba(122,155,132,0.3)">✓ FMP fundamentals loaded · DCF uses ${dcfSource}</span>`
    : `<span style="font-size:0.75rem;padding:2px 8px;border-radius:4px;background:rgba(212,165,116,0.15);color:var(--terracotta);border:1px solid rgba(212,165,116,0.3)">⚠ FMP not connected · DCF uses ${dcfSource}</span>`;

  const entryCtx = m.entryPrice ? `
    <div style="margin:12px 0;padding:12px 14px;border-radius:8px;border:1.5px solid ${m.price <= m.entryPrice ? '#2D6A4F' : 'var(--border)'};background:${m.price <= m.entryPrice ? 'rgba(45,106,79,0.07)' : '#faf8f4'}">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:0.8rem;font-weight:600;color:var(--navy)">Ideal Entry Price ${tip("entryPrice")}</span>
        <span style="font-family:monospace;font-size:1.1rem;font-weight:700;color:${m.price <= m.entryPrice ? '#2D6A4F' : 'var(--navy)'}">$${fmt(m.entryPrice)}</span>
        ${m.price <= m.entryPrice
          ? `<span style="font-size:0.78rem;padding:2px 8px;border-radius:20px;background:#2D6A4F;color:white;font-weight:600">🎯 At or below entry — actionable</span>`
          : `<span style="font-size:0.78rem;color:var(--taupe)">${(((m.entryPrice - m.price) / m.price) * 100).toFixed(1)}% below current price</span>`}
      </div>
      <p style="font-size:0.72rem;color:var(--taupe);margin-top:5px">median(DCF×0.75, Graham×0.85, MA200×0.95) · conservative LT entry</p>
    </div>` : "";

  document.getElementById("m-metrics").innerHTML = `
    <div style="margin-bottom:8px">${dataBadge}</div>
    ${entryCtx}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:12px 0">
      ${metricCard("LT Score",          scoreBar(m.ltScore))}
      ${metricCard("Quality Score",     scoreBar(m.qualityScore, m.qualityScore != null && m.qualityScore >= 70 ? "#2D6A4F" : "var(--gold)"))}
      ${metricCard("Entry Zone",        zoneChip(m.zone))}
      ${metricCard("RSI-14",            m.rsi != null ? m.rsi : "—")}
      ${metricCard("MA 50",             "$"+fmt(m.ma50))}
      ${metricCard("MA 200",            "$"+fmt(m.ma200))}
      ${metricCard("52w High",          "$"+fmt(m.high52w))}
      ${metricCard("Drawdown",          m.drawdown != null ? m.drawdown.toFixed(1)+"%" : "—")}
      ${metricCard("P/E (TTM)",         f?.pe          != null ? f.pe              : "—")}
      ${metricCard("P/B",               f?.pbRatio     != null ? f.pbRatio.toFixed(1) : "—")}
      ${metricCard("EV/EBITDA",         f?.evEbitda    != null ? f.evEbitda.toFixed(1) : "—")}
      ${metricCard("Dividend Yield",    f?.dividendYield!= null ? fmtPct(f.dividendYield) : "—")}
      ${metricCard("ROE",               f?.roe         != null ? fmtPct(f.roe)    : "—")}
      ${metricCard("Debt/Equity",       f?.debtToEquity!= null ? f.debtToEquity.toFixed(2) : "—")}
      ${metricCard("Oper. Margin",      f?.operatingMargin  != null ? fmtPct(f.operatingMargin) : "—")}
      ${metricCard("Rev Growth YoY",    f?.revenueGrowthYoy != null ? fmtPct(f.revenueGrowthYoy) : "—")}
      ${metricCard("EPS Growth YoY",    f?.earningsGrowthYoy!= null ? fmtPct(f.earningsGrowthYoy) : "—")}
      ${metricCard("EPS (TTM)",         f?.eps         != null ? "$"+fmt(f.eps)   : "—")}
      ${metricCard("Graham Number",     m.grahamNumber  ? "$"+fmt(m.grahamNumber) : "—")}
      ${metricCard("Fair Value (DCF)",  "$"+fmt(m.fairValue))}
      ${metricCard("Margin of Safety",  m.mos != null ? m.mos.toFixed(1)+"%" : "—")}
      ${metricCard("Sentiment",         sentimentChip(m.sentimentScore))}
    </div>`;

  $("#modal").classList.remove("hidden");

  const [barsResp, newsResp] = await Promise.all([
    fetch(`/api/bars?symbol=${symbol}&duration=${state.duration}`).then(r => r.json()),
    fetch(`/api/news?symbols=${symbol}&limit=10`).then(r => r.ok ? r.json() : null),
    fetchFundamentals([symbol], { wantFmp: true }),
  ]);

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

  const articles = newsResp?.news?.[symbol]?.articles ?? [];
  const newsFeed = document.getElementById("m-news");
  if (newsFeed) {
    newsFeed.innerHTML = !articles.length
      ? `<p style="color:var(--taupe);font-size:0.85rem;padding:12px 0">No recent news found.</p>`
      : articles.map(a => {
          const [sentBg, sentCol] = a.sentiment === "positive"
            ? ["rgba(122,155,132,0.18)","var(--sage)"]
            : a.sentiment === "negative"
            ? ["rgba(194,121,65,0.15)","var(--terracotta)"]
            : ["rgba(168,152,133,0.15)","var(--taupe)"];
          return `
            <a href="${a.url}" target="_blank" rel="noopener noreferrer"
               style="display:block;border-bottom:1px solid var(--border);padding:12px 0;text-decoration:none"
               onmouseover="this.style.background='#faf8f3'" onmouseout="this.style.background=''">
              <div style="display:flex;align-items:flex-start;gap:8px">
                <span style="flex-shrink:0;margin-top:2px;padding:2px 6px;border-radius:4px;font-size:0.65rem;font-weight:700;background:${sentBg};color:${sentCol};text-transform:uppercase">${a.sentiment}</span>
                <div>
                  <p style="font-size:0.875rem;font-weight:500;color:var(--navy);line-height:1.4;margin:0 0 3px">${a.headline}</p>
                  ${a.summary ? `<p style="font-size:0.75rem;color:var(--taupe);margin:0 0 4px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${a.summary}</p>` : ""}
                  <p style="font-size:0.72rem;color:var(--taupe);margin:0">${a.source} · ${timeAgo(a.publishedAt)}</p>
                </div>
              </div>
            </a>`;
        }).join("");
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
  return `<div style="background:#faf8f4;border-radius:8px;border:1px solid var(--border);padding:10px 12px">
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
  render();
  await refresh();
  state.timer     = setInterval(refresh, REFRESH_MS);
  state.fundTimer = setInterval(() => fetchFundamentals(ALL_SYMBOLS, { wantFmp: true }), FUND_TTL_MS);
})();
