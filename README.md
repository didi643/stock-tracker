# Stock Tracker

Static dashboard for the S&P 500 with sector grouping, favorites, and live prices via Alpaca. Built for Netlify (static site + Netlify Functions).

## Architecture

```
Browser  ──▶  Netlify CDN (public/)
                 │
                 │ fetch /api/quotes /api/bars
                 ▼
              Netlify Functions (netlify/functions/)
                 │ APCA_API_KEY_ID, APCA_API_SECRET_KEY (env vars)
                 ▼
              Alpaca Data API (IEX feed)
```

- **Frontend** — vanilla JS + Tailwind CDN + Chart.js. No build step.
- **Backend** — two Netlify Functions (Node 18+) that hold the Alpaca API key server-side and proxy requests. Keys never reach the browser.
- **Data** — S&P 500 universe bundled as `public/sp500.csv` (530 rows, 11 GICS sectors).
- **Favorites** — stored in browser `localStorage`, persists per-device.
- **Refresh** — frontend polls `/api/quotes` every 30s; functions cache 20s.

## Files

```
Stock Tracker/
├── public/
│   ├── index.html      # UI shell
│   ├── app.js          # state, render, polling, favorites
│   └── sp500.csv       # ticker,name,sector,industry
├── netlify/functions/
│   ├── quotes.js       # GET /api/quotes?symbols=...&duration=1d
│   └── bars.js         # GET /api/bars?symbol=AAPL&duration=1m
├── netlify.toml        # build/redirect config
├── package.json        # netlify-cli devDep
├── .env.example        # template
└── .gitignore
```

## Local development

```bash
# 1. Install Netlify CLI
npm install

# 2. Set up env (or run `netlify link` if you've already deployed)
cp .env.example .env
# edit .env with your Alpaca keys

# 3. Run locally — serves frontend + functions on http://localhost:8888
npx netlify dev
```

## Deploy to Netlify

1. **Push to GitHub.** Create a repo, commit, push.
2. **Connect to Netlify.** New site → import from Git → pick the repo.
   - Build command: *(leave blank)*
   - Publish directory: `public`
   - Functions directory: `netlify/functions` (auto-detected from `netlify.toml`)
3. **Add env vars** (Site settings → Environment variables):
   - `APCA_API_KEY_ID`
   - `APCA_API_SECRET_KEY`
   - `ALPACA_FEED` = `iex`
4. **Add password protection** (Site settings → Visitor access → Password protection). Set a single shared password and share it with your 2-3 users. *Note: this is a paid feature on Netlify ($19/mo Pro). Free alternative: use Netlify Identity with role-gated access, or a simple in-function token check.*
5. **Deploy.** Netlify rebuilds on every push.

## API endpoints

### `GET /api/quotes?symbols=AAPL,MSFT&duration=1d`
Batch latest price + change vs duration anchor.
```json
{ "duration": "1d", "feed": "iex",
  "quotes": { "AAPL": { "last": 218.42, "prev": 215.10, "changePct": 1.54, "ts": "..." } } }
```
Durations: `1d, 2d, 1w, 1m, 3m, ytd, 1y`.

### `GET /api/bars?symbol=AAPL&duration=1m`
Historical OHLCV bars for charting.

## Cost & quota

- **Netlify free tier** — 100 GB bandwidth + 125k function invocations/month. With 3 users polling every 30s: ~3 × 2 calls/min × 60 × 8h × 22d ≈ 63k calls/month. Comfortably within free tier.
- **Alpaca IEX feed** — free, 200 req/min rate limit. Each quote refresh = ~3 batched calls (≤200 symbols each).

## Security notes

- API keys live only in Netlify env vars; the browser never sees them.
- Password-protect the site so the function URL isn't publicly hammered.
- The `.env` file is gitignored.
- **Rotate any key that has been pasted into chat or committed.**

## Customization

- **Limit universe** — edit `public/sp500.csv` to a smaller list.
- **Refresh rate** — change `REFRESH_MS` in `public/app.js`.
- **Sectors** — already grouped by GICS sector in the CSV; edit there to regroup.
