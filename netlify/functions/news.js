// GET /api/news?symbols=AAPL,MSFT&limit=10
// Returns per-symbol: { articles: [{headline, url, source, publishedAt, sentiment, summary}],
//                       sentimentScore }  (-1 to +1)
//
// Data source: Alpaca News API v1beta1 (already authenticated via existing keys)
// Sentiment: Alpaca tags each article with "positive" | "negative" | "neutral"
//            We aggregate into a numeric score: avg of (+1 / 0 / -1) across articles.
// Free tier: 200 req/min — one call per symbol batch (up to 10 symbols per call).

const ALPACA_NEWS = "https://data.alpaca.markets/v1beta1";

function authHeaders() {
  return {
    "APCA-API-KEY-ID":     process.env.APCA_API_KEY_ID,
    "APCA-API-SECRET-KEY": process.env.APCA_API_SECRET_KEY,
  };
}

const SENTIMENT_VAL = { positive: 1, neutral: 0, negative: -1 };

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Fetch news for up to 10 symbols at once from Alpaca
async function fetchNewsChunk(symbols, limit) {
  const params = new URLSearchParams({
    symbols:    symbols.join(","),
    limit:      String(limit),
    sort:       "desc",
    include_content: "false",   // headlines + summary only — keeps payload small
  });
  const r = await fetch(`${ALPACA_NEWS}/news?${params}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`Alpaca news ${r.status}: ${await r.text()}`);
  return r.json();
}

export default async (req) => {
  const url    = new URL(req.url);
  const syms   = (url.searchParams.get("symbols") || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const limit  = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);

  if (!syms.length) {
    return new Response(JSON.stringify({ error: "symbols required" }), {
      status: 400, headers: { "content-type": "application/json" },
    });
  }

  try {
    // Alpaca news supports up to 10 symbols per call
    const chunkResults = await Promise.all(
      chunks(syms, 10).map(batch => fetchNewsChunk(batch, limit))
    );

    // Collect all articles
    const allArticles = chunkResults.flatMap(r => r.news || []);

    // Group articles by symbol, deduplicate by article id
    const bySymbol = {};
    for (const sym of syms) bySymbol[sym] = [];

    const seen = new Set();
    for (const article of allArticles) {
      if (seen.has(article.id)) continue;
      seen.add(article.id);

      const sentiment = article.sentiment ?? "neutral";
      const clean = {
        id:          article.id,
        headline:    article.headline,
        url:         article.url,
        source:      article.source,
        publishedAt: article.created_at,
        sentiment,                          // "positive" | "negative" | "neutral"
        summary:     article.summary || "",
        symbols:     article.symbols || [],
      };

      // Assign to each symbol mentioned in the article that we care about
      for (const sym of (article.symbols || [])) {
        if (bySymbol[sym]) bySymbol[sym].push(clean);
      }
    }

    // Compute aggregate sentiment score per symbol (-1 to +1)
    const result = {};
    for (const sym of syms) {
      const articles = bySymbol[sym].slice(0, limit);
      let score = null;
      if (articles.length > 0) {
        const sum = articles.reduce((acc, a) => acc + (SENTIMENT_VAL[a.sentiment] ?? 0), 0);
        score = +(sum / articles.length).toFixed(3);
      }
      result[sym] = { articles, sentimentScore: score };
    }

    return new Response(JSON.stringify({ news: result }), {
      status: 200,
      headers: {
        "content-type":  "application/json",
        "cache-control": "public, max-age=900",  // cache 15 min — news doesn't change that fast
      },
    });
  } catch (e) {
    console.error("news error:", e.message);
    return new Response(JSON.stringify({ error: String(e.message || e) }), {
      status: 502, headers: { "content-type": "application/json" },
    });
  }
};

export const config = { path: "/api/news" };
