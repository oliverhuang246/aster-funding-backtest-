const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { URL } = require("url");

const root = __dirname;
const port = Number(process.env.PORT || 4173);
const ASTER = "https://fapi.asterdex.com";
const marketCache = new Map();
const fundingHistoryCache = new Map();
const FUNDING_HISTORY_TTL = 10 * 60 * 1000;
const types = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function fetchPowerShell(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(root, "fetch-aster.ps1"),
        url,
      ],
      { timeout: 30000, maxBuffer: 1024 * 1024 * 16 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function fetchCurl(url) {
  return new Promise((resolve, reject) => {
    execFile(
      "curl.exe",
      ["-L", "--silent", "--show-error", "--max-time", "20", "-H", "accept: application/json", url],
      { timeout: 25000, maxBuffer: 1024 * 1024 * 16 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function requestText(url) {
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "aster-funding-backtest-panel",
      },
    });
    const body = await response.text();
    if (!response.ok) throw new Error(body || `HTTP ${response.status}`);
    return body;
  } catch (error) {
    return fetchPowerShell(url);
  }
}

async function requestJson(url) {
  return JSON.parse(await requestText(url));
}

function batchFetch(kind, symbols, options = {}) {
  const uniqueSymbols = [...new Set(symbols.filter(Boolean))];
  if (!uniqueSymbols.length) return {};
  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(root, "fetch-aster-batch.ps1"),
    kind,
    uniqueSymbols.join(","),
  ];
  if (options.startTime || options.endTime || options.limit) {
    args.push(
      String(options.startTime || ""),
      String(options.endTime || ""),
      String(options.limit || "8"),
      String(options.pauseMs || "0"),
    );
  }

  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      args,
      { timeout: 120000, maxBuffer: 1024 * 1024 * 64 },
      (error, stdout) => {
        if (error) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(stdout || "{}"));
        } catch (parseError) {
          resolve({});
        }
      },
    );
  });
}

async function proxyFunding(res, requestUrl) {
  const upstream = new URL("/fapi/v1/fundingRate", ASTER);
  for (const key of ["symbol", "startTime", "endTime", "limit"]) {
    const value = requestUrl.searchParams.get(key);
    if (value) upstream.searchParams.set(key, value);
  }

  try {
    const body = await requestText(upstream.toString());
    send(res, 200, body, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function marketStats(res, requestUrl) {
  const limit = clamp(Number(requestUrl.searchParams.get("limit") || 120), 20, 300);
  const historyLimit = clamp(Number(requestUrl.searchParams.get("historyLimit") || limit), 0, 300);
  const cacheKey = `${limit}:${historyLimit}`;
  const cached = marketCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 55000) {
    send(res, 200, cached.body, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    return;
  }

  try {
    const [premium, ticker] = await Promise.all([
      requestJson(`${ASTER}/fapi/v1/premiumIndex`),
      requestJson(`${ASTER}/fapi/v1/ticker/24hr`),
    ]);

    const tickerMap = new Map((Array.isArray(ticker) ? ticker : []).map((row) => [row.symbol, row]));
    const marketTime = Math.max(...premium.map((row) => Number(row.time)).filter(Number.isFinite));
    const now = Number.isFinite(marketTime) ? marketTime : Date.now();
    const allRows = (Array.isArray(premium) ? premium : [])
      .filter((row) => row.symbol && Number(row.lastFundingRate) !== 0)
      .map((row) => {
        const tickerRow = tickerMap.get(row.symbol) || {};
        const fundingRate = Number(row.lastFundingRate) || 0;
        const price = Number(tickerRow.lastPrice || row.markPrice || row.indexPrice || 0);
        const openInterest = Number(row.openInterest || 0);
        const fallbackInterval = inferIntervalHours(row);
        return {
          symbol: row.symbol,
          price,
          fundingRate,
          annualized: fundingRate * (24 / fallbackInterval) * 365,
          intervalHours: fallbackInterval,
          openInterestUsd: openInterest * price,
          quoteVolume: Number(tickerRow.quoteVolume || 0),
          sum7d: fundingRate * (24 / fallbackInterval) * 7,
          sum30d: fundingRate * (24 / fallbackInterval) * 30,
          exactHistory: false,
          nextFundingTime: Number(row.nextFundingTime) || null,
        };
      })
      .sort((a, b) => b.annualized - a.annualized);

    const baseRows = historyLimit > limit
      ? selectExtremes(allRows, "annualized", historyLimit)
      : selectExtremes(allRows, "annualized", limit);

    const historyRows = baseRows.slice(0, historyLimit);
    const start30d = now - 30 * 86400000;
    const start7d = now - 7 * 86400000;
    const historyMap = {};
    const staleHistoryRows = [];
    const cacheTime = Date.now();
    historyRows.forEach((row) => {
      const cachedHistory = fundingHistoryCache.get(row.symbol);
      if (
        cachedHistory &&
        cacheTime - cachedHistory.time < FUNDING_HISTORY_TTL &&
        cachedHistory.startTime <= start30d &&
        cachedHistory.endTime >= now - 5 * 60000
      ) {
        historyMap[row.symbol] = cachedHistory.rows;
      } else {
        staleHistoryRows.push(row);
      }
    });

    if (staleHistoryRows.length) {
      const fetchedHistoryMap = await batchFundingHistories(
        staleHistoryRows.map((row) => row.symbol),
        start30d,
        now,
      );
      staleHistoryRows.forEach((row) => {
        const fetchedHistory = Array.isArray(fetchedHistoryMap[row.symbol])
          ? fetchedHistoryMap[row.symbol]
          : null;
        if (fetchedHistory?.length) {
          fundingHistoryCache.set(row.symbol, {
            time: cacheTime,
            startTime: start30d,
            endTime: now,
            rows: fetchedHistory,
          });
          historyMap[row.symbol] = fetchedHistory;
          return;
        }

        const cachedHistory = fundingHistoryCache.get(row.symbol);
        if (cachedHistory?.rows?.length) {
          historyMap[row.symbol] = cachedHistory.rows;
        }
      });
    }
    historyRows.forEach((row) => {
      const history = Array.isArray(historyMap[row.symbol]) ? historyMap[row.symbol] : [];
      if (!history.length) {
        row.annualized = row.fundingRate * (24 / row.intervalHours) * 365;
        return;
      }
      const exactInterval = inferIntervalFromHistory(history);
      if (exactInterval) {
        row.intervalHours = exactInterval;
      }
      row.annualized = row.fundingRate * (24 / row.intervalHours) * 365;
      row.sum7d = sumFundingRates(history, start7d, now);
      row.sum30d = sumFundingRates(history, start30d, now);
      row.exactHistory = true;
    });

    const rows = historyLimit > limit
      ? selectMultiMetricExtremes(baseRows, ["annualized", "sum7d", "sum30d"], limit)
      : [...baseRows].sort((a, b) => b.annualized - a.annualized).slice(0, limit);

    const openInterestRows = rows.slice(0, Math.min(limit, 100));
    const openInterestMap = await batchFetch("openInterest", openInterestRows.map((row) => row.symbol));
    openInterestRows.forEach((row) => {
      const openInterestValue = Number(openInterestMap[row.symbol]?.openInterest) || 0;
      if (openInterestValue) row.openInterestUsd = openInterestValue * row.price;
    });

    const body = JSON.stringify({
        updatedAt: new Date().toISOString(),
        rows,
      });
    marketCache.set(cacheKey, { time: Date.now(), body });
    send(res, 200, body, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
  } catch (error) {
    sendError(res, error);
  }
}

async function contractMeta(res, requestUrl) {
  const symbol = String(requestUrl.searchParams.get("symbol") || "").trim().toUpperCase();
  if (!symbol) {
    send(res, 400, JSON.stringify({ error: "Missing symbol" }), {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    return;
  }

  try {
    const premiumUrl = new URL("/fapi/v1/premiumIndex", ASTER);
    premiumUrl.searchParams.set("symbol", symbol);
    const premium = await requestJson(premiumUrl.toString());
    const now = Number(premium.time) || Date.now();
    const history = await fundingHistory(symbol, now - 10 * 86400000, now);
    const intervalHours = inferIntervalFromHistory(history) || inferIntervalHours(premium);
    send(
      res,
      200,
      JSON.stringify({
        symbol,
        intervalHours,
        fundingRate: Number(premium.lastFundingRate) || 0,
        nextFundingTime: Number(premium.nextFundingTime) || null,
        time: Number(premium.time) || null,
      }),
      {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      },
    );
  } catch (error) {
    sendError(res, error);
  }
}

function inferIntervalHours(row) {
  const now = Number(row.time);
  const next = Number(row.nextFundingTime);
  if (Number.isFinite(now) && Number.isFinite(next)) {
    const hoursToNext = (next - now) / 3600000;
    if (hoursToNext <= 1.5) return 1;
    if (hoursToNext <= 4.5) return 4;
  }
  return 8;
}

function inferIntervalFromHistory(history) {
  const times = (Array.isArray(history) ? history : [])
    .map((row) => Number(row.fundingTime))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const buckets = new Map();
  for (let i = 1; i < times.length; i += 1) {
    const hours = (times[i] - times[i - 1]) / 3600000;
    if (hours > 0.2 && hours <= 24) {
      const rounded = Math.round(hours);
      buckets.set(rounded, (buckets.get(rounded) || 0) + 1);
    }
  }
  if (!buckets.size) return null;
  return [...buckets.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function selectExtremes(rows, metric, limit) {
  const positiveLimit = Math.ceil(limit / 2);
  const negativeLimit = Math.floor(limit / 2);
  const positives = rows
    .filter((row) => Number(row[metric]) >= 0)
    .sort((a, b) => (Number(b[metric]) || 0) - (Number(a[metric]) || 0))
    .slice(0, positiveLimit);
  const negatives = rows
    .filter((row) => Number(row[metric]) < 0)
    .sort((a, b) => (Number(a[metric]) || 0) - (Number(b[metric]) || 0))
    .slice(0, negativeLimit);
  return [...positives, ...negatives];
}

function selectMultiMetricExtremes(rows, metrics, limit) {
  const bySymbol = new Map();
  const perSideMetricLimit = Math.max(6, Math.ceil(limit / metrics.length / 2));
  metrics.forEach((metric) => {
    selectExtremes(rows, metric, perSideMetricLimit * 2).forEach((row) => {
      bySymbol.set(row.symbol, row);
    });
  });

  const selected = [...bySymbol.values()];
  if (selected.length < limit) {
    selectExtremes(rows, "annualized", limit).forEach((row) => {
      if (selected.length < limit && !bySymbol.has(row.symbol)) {
        bySymbol.set(row.symbol, row);
        selected.push(row);
      }
    });
  }

  return selected
    .sort((a, b) => (Number(b.annualized) || 0) - (Number(a.annualized) || 0))
    .slice(0, limit);
}

function sumFundingRates(history, startTime, endTime) {
  return (Array.isArray(history) ? history : []).reduce((sum, row) => {
    const time = Number(row.fundingTime);
    const rate = Number(row.fundingRate);
    if (
      Number.isFinite(time) &&
      Number.isFinite(rate) &&
      time >= startTime &&
      time <= endTime
    ) {
      return sum + rate;
    }
    return sum;
  }, 0);
}

async function fundingHistory(symbol, startTime, endTime) {
  const url = new URL("/fapi/v1/fundingRate", ASTER);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("startTime", String(Math.floor(startTime)));
  url.searchParams.set("endTime", String(Math.floor(endTime)));
  url.searchParams.set("limit", "1000");
  const history = await requestJson(url.toString());
  return Array.isArray(history) ? history : [];
}

async function batchFundingHistories(symbols, startTime, endTime) {
  const uniqueSymbols = [...new Set(symbols.filter(Boolean))];
  const result = {};
  await mapWithConcurrency(
    uniqueSymbols.map((symbol) => ({ symbol })),
    8,
    async (item) => {
      try {
        result[item.symbol] = await fundingHistory(item.symbol, startTime, endTime);
      } catch (error) {
        result[item.symbol] = null;
      }
    },
  );
  return result;
}

async function recentFundingHistory(symbol, limit = 8) {
  const url = new URL("/fapi/v1/fundingRate", ASTER);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("limit", String(limit));
  const history = await requestJson(url.toString());
  return Array.isArray(history) ? history : [];
}

async function fetchOpenInterest(symbol) {
  const url = new URL("/fapi/v1/openInterest", ASTER);
  url.searchParams.set("symbol", symbol);
  const payload = await requestJson(url.toString());
  return Number(payload.openInterest) || 0;
}

async function mapWithConcurrency(items, concurrency, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      try {
        await worker(current);
      } catch (error) {
        current.historyError = error.message;
      }
    }
  });
  await Promise.all(workers);
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function sendError(res, error) {
  send(
    res,
    502,
    JSON.stringify({
      error: "Unable to reach Aster API",
      detail: error.message,
    }),
    {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    },
  );
}

function serveFile(res, requestUrl) {
  let pathname = decodeURIComponent(requestUrl.pathname);
  if (pathname === "/") pathname = "/index.html";

  const file = path.normalize(path.join(root, pathname));
  if (!file.startsWith(root)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(file, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, data, {
      "content-type": types[path.extname(file)] || "application/octet-stream",
    });
  });
}

http
  .createServer((req, res) => {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (requestUrl.pathname === "/api/fundingRate") {
      proxyFunding(res, requestUrl);
      return;
    }
    if (requestUrl.pathname === "/api/marketStats") {
      marketStats(res, requestUrl);
      return;
    }
    if (requestUrl.pathname === "/api/contractMeta") {
      contractMeta(res, requestUrl);
      return;
    }
    serveFile(res, requestUrl);
  })
  .listen(port, () => {
    console.log(`Aster funding backtest: http://127.0.0.1:${port}`);
  });
