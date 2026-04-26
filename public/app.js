// Stock Tracker - vanilla JS frontend
// Calls /api/quotes for batch prices, /api/bars for individual charts.

const REFRESH_MS = 30_000;
const FAV_KEY    = "stock-tracker.favorites.v1";

const $ = (s) => document.querySelector(s);
const fmt = (n) => n == null ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const state = {
  universe:  [],          // [{symbol,name,sector,industry}]
  bySector:  {},          // sector -> [tickers]
  quotes:    {},          // symbol -> {last, prev, changePct, ts}
  duration:  "1d",
  tab:       "sectors",
  search:    "",
  favorites: new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")),
  timer:     null,
};

// ---------- Universe loading ----------
function parseCsvLine(line) {
  const out = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
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
  state.bySector = rows.reduce((acc, r) => {
    (acc[r.sector] ||= []).push(r);
    return acc;
  }, {});
}

// ---------- Data fetching ----------
async function fetchQuotes(symbols) {
  if (!symbols.length) return {};
  // chunk to keep URLs reasonable
  const out = {};
  for (let i = 0; i < symbols.length; i += 200) {
    const chunk = symbols.slice(i, i + 200);
    const url = `/api/quotes?symbols=${chunk.join(",")}&duration=${state.duration}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`quotes ${r.status}`);
    const j = await r.json();
    Object.assign(out, j.quotes || {});
  }
  return out;
}

function visibleSymbols() {
  if (state.tab === "favorites") return [...state.favorites];
  if (state.tab === "all") return state.universe.map(s => s.symbol);
  // sectors view: load everything once so sector aggregates work
  return state.universe.map(s => s.symbol);
}

async function refresh() {
  const syms = visibleSymbols();
  setStatus("Loading…");
  try {
    state.quotes = { ...state.quotes, ...(await fetchQuotes(syms)) };
    render();
    // Detect market state from any quote with marketOpen flag
    const sample = Object.values(state.quotes).find(q => q);
    const open   = sample?.marketOpen;
    const asOf   = sample?.asOf ? new Date(sample.asOf).toLocaleDateString() : "";
    const tag    = open ? `<span class="text-green-600">● Live</span>`
                        : `<span class="text-amber-600">● Market closed · last session ${asOf}</span>`;
    $("#status").innerHTML = `${tag} · updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
}

function setStatus(msg) { $("#status").textContent = msg; }

// ---------- Rendering ----------
function chip(pct) {
  if (pct == null || isNaN(pct)) return `<span class="text-slate-400">—</span>`;
  const cls = pct > 0 ? "bg-green-100 text-green-800"
            : pct < 0 ? "bg-red-100 text-red-800"
            : "bg-slate-100 text-slate-700";
  const sign = pct > 0 ? "+" : "";
  return `<span class="inline-block px-2 py-0.5 rounded text-xs font-semibold ${cls}">${sign}${pct.toFixed(2)}%</span>`;
}

function starBtn(sym) {
  const on = state.favorites.has(sym);
  return `<button data-fav="${sym}" class="text-lg leading-none ${on ? "text-yellow-500" : "text-slate-300 hover:text-yellow-400"}">★</button>`;
}

function rowHtml(s) {
  const q = state.quotes[s.symbol];
  return `
    <tr class="border-b hover:bg-slate-50 cursor-pointer" data-symbol="${s.symbol}">
      <td class="py-2 px-2">${starBtn(s.symbol)}</td>
      <td class="py-2 px-2 font-mono font-semibold">${s.symbol}</td>
      <td class="py-2 px-2 text-sm text-slate-600 truncate max-w-xs">${s.name}</td>
      <td class="py-2 px-2 text-right font-mono">${q ? fmt(q.last) : "—"}</td>
      <td class="py-2 px-2 text-right">${chip(q?.changePct)}</td>
      <td class="py-2 px-2 text-xs text-slate-500">${s.industry}</td>
    </tr>`;
}

function tableHtml(stocks) {
  const filtered = filterBySearch(stocks);
  if (!filtered.length) return `<p class="text-slate-500 text-sm p-4">No stocks.</p>`;
  return `
    <table class="w-full text-sm">
      <thead class="text-left text-xs uppercase text-slate-500 border-b">
        <tr>
          <th class="py-2 px-2"></th>
          <th class="py-2 px-2">Ticker</th>
          <th class="py-2 px-2">Name</th>
          <th class="py-2 px-2 text-right">Price</th>
          <th class="py-2 px-2 text-right">Change</th>
          <th class="py-2 px-2">Industry</th>
        </tr>
      </thead>
      <tbody>${filtered.map(rowHtml).join("")}</tbody>
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

function renderSectors() {
  const sectors = Object.keys(state.bySector).sort();
  const cards = sectors.map(sec => {
    const stocks = state.bySector[sec];
    const avg = sectorAggregate(stocks);
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
  $("#content").innerHTML = `<div class="space-y-2">${cards}</div>`;
}

function renderFavorites() {
  const stocks = state.universe.filter(s => state.favorites.has(s.symbol));
  if (!stocks.length) {
    $("#content").innerHTML = `<p class="text-slate-500 p-8 text-center">No favorites yet. Click ★ next to any stock to add.</p>`;
    return;
  }
  // group favorites by sector for readability
  const groups = stocks.reduce((acc, s) => { (acc[s.sector] ||= []).push(s); return acc; }, {});
  $("#content").innerHTML = Object.entries(groups).map(([sec, list]) => `
    <section class="bg-white rounded shadow-sm mb-3">
      <div class="p-3 flex items-center gap-3 border-b">
        <span class="font-semibold flex-1">${sec}</span>
        ${chip(sectorAggregate(list))}
      </div>
      <div class="overflow-x-auto">${tableHtml(list)}</div>
    </section>`).join("");
}

function renderAll() {
  $("#content").innerHTML = `<div class="bg-white rounded shadow-sm overflow-x-auto">${tableHtml(state.universe)}</div>`;
}

function render() {
  if      (state.tab === "favorites") renderFavorites();
  else if (state.tab === "all")       renderAll();
  else                                 renderSectors();
}

// ---------- Detail modal ----------
let chart = null;
async function openDetail(symbol) {
  const stock = state.universe.find(s => s.symbol === symbol);
  if (!stock) return;
  const q = state.quotes[symbol];
  $("#m-symbol").textContent = symbol;
  $("#m-name").textContent   = `${stock.name} · ${stock.sector} / ${stock.industry}`;
  $("#m-price").textContent  = q ? `$${fmt(q.last)}` : "—";
  $("#m-change").innerHTML   = chip(q?.changePct);
  $("#modal").classList.remove("hidden");

  const r = await fetch(`/api/bars?symbol=${symbol}&duration=${state.duration}`);
  const j = await r.json();
  const bars = j.bars || [];
  if (chart) chart.destroy();
  const ctx = document.getElementById("m-chart").getContext("2d");
  const up = bars.length > 1 && bars.at(-1).c >= bars[0].c;
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels:   bars.map(b => b.t),
      datasets: [{
        data:           bars.map(b => b.c),
        borderColor:    up ? "#16a34a" : "#dc2626",
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

// ---------- Events ----------
function bindEvents() {
  $("#duration").addEventListener("change", e => {
    state.duration = e.target.value;
    refresh();
  });
  $("#refresh").addEventListener("click", refresh);
  $("#search").addEventListener("input", e => {
    state.search = e.target.value;
    render();
  });
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => {
        b.classList.toggle("border-blue-600", b === btn);
        b.classList.toggle("border-transparent", b !== btn);
      });
      render();
    });
  });
  document.addEventListener("click", e => {
    const fav = e.target.closest("[data-fav]");
    if (fav) {
      e.stopPropagation();
      const sym = fav.dataset.fav;
      state.favorites.has(sym) ? state.favorites.delete(sym) : state.favorites.add(sym);
      localStorage.setItem(FAV_KEY, JSON.stringify([...state.favorites]));
      render();
      return;
    }
    const row = e.target.closest("[data-symbol]");
    if (row) openDetail(row.dataset.symbol);
  });
  $("#m-close").addEventListener("click", () => $("#modal").classList.add("hidden"));
  $("#modal").addEventListener("click", e => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); });
}

// ---------- Boot ----------
(async () => {
  bindEvents();
  await loadUniverse();
  render();
  await refresh();
  state.timer = setInterval(refresh, REFRESH_MS);
})();
