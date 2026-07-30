const API_BASE = "https://fapi.asterdex.com";

const state = {
  raw: [],
  result: [],
  market: [],
  marketSort: { key: "annualized", dir: "desc" },
  marketTimer: null,
  marketLoading: false,
  marketSearchTimer: null,
  marketSearchRow: null,
  marketSearchLoading: false,
  contractMeta: new Map(),
  chartRange: "7",
  chartHoverIndex: null,
  chartGeometry: null,
};

const el = {
  symbol: document.querySelector("#symbol"),
  startDate: document.querySelector("#startDate"),
  endDate: document.querySelector("#endDate"),
  side: document.querySelector("#side"),
  notional: document.querySelector("#notional"),
  intervalHours: document.querySelector("#intervalHours"),
  intervalDisplay: document.querySelector("#intervalDisplay"),
  intervalSource: document.querySelector("#intervalSource"),
  entryCostBps: document.querySelector("#entryCostBps"),
  exitCostBps: document.querySelector("#exitCostBps"),
  compound: document.querySelector("#compound"),
  fetchBtn: document.querySelector("#fetchBtn"),
  sampleBtn: document.querySelector("#sampleBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  dataStatus: document.querySelector("#dataStatus"),
  totalPnl: document.querySelector("#totalPnl"),
  pnlCaption: document.querySelector("#pnlCaption"),
  apr: document.querySelector("#apr"),
  drawdown: document.querySelector("#drawdown"),
  periods: document.querySelector("#periods"),
  dateRange: document.querySelector("#dateRange"),
  chartCaption: document.querySelector("#chartCaption"),
  chartRanges: document.querySelectorAll(".chart-range"),
  positiveBar: document.querySelector("#positiveBar"),
  negativeBar: document.querySelector("#negativeBar"),
  flatBar: document.querySelector("#flatBar"),
  positiveCount: document.querySelector("#positiveCount"),
  negativeCount: document.querySelector("#negativeCount"),
  flatCount: document.querySelector("#flatCount"),
  rateSummary: document.querySelector("#rateSummary"),
  tableCount: document.querySelector("#tableCount"),
  rows: document.querySelector("#rows"),
  chart: document.querySelector("#equityChart"),
  chartTooltip: document.querySelector("#chartTooltip"),
  marketRows: document.querySelector("#marketRows"),
  marketSearch: document.querySelector("#marketSearch"),
  refreshMarketBtn: document.querySelector("#refreshMarketBtn"),
  marketStatus: document.querySelector("#marketStatus"),
  marketUpdated: document.querySelector("#marketUpdated"),
  marketCount: document.querySelector("#marketCount"),
  marketPositive: document.querySelector("#marketPositive"),
  marketNegative: document.querySelector("#marketNegative"),
  marketTopApr: document.querySelector("#marketTopApr"),
};

function setDefaultDates() {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - 30);
  el.endDate.value = toDateInput(end);
  el.startDate.value = toDateInput(start);
}

function toDateInput(date) {
  return date.toISOString().slice(0, 10);
}

function startMs() {
  return new Date(`${el.startDate.value}T00:00:00Z`).getTime();
}

function endMs() {
  return new Date(`${el.endDate.value}T23:59:59Z`).getTime();
}

function money(value, compact = false) {
  const abs = Math.abs(Number(value) || 0);
  const sign = value < 0 ? "-" : "";
  if (compact) {
    if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(2)}B`;
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`;
  }
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function price(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
  return `$${n.toPrecision(5)}`;
}

function pct(value, decimals = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(decimals)}%`;
}

function signedClass(value) {
  if (value > 0) return "gain";
  if (value < 0) return "loss";
  return "";
}

function localApi(path) {
  return location.protocol.startsWith("http") ? path : `${API_BASE}${path}`;
}

function currentSymbol() {
  return el.symbol.value.trim().toUpperCase();
}

function setIntervalHours(hours, sourceText = "") {
  const value = Number(hours);
  const normalized = Number.isFinite(value) && value > 0 ? value : 8;
  el.intervalHours.value = String(normalized);
  el.intervalDisplay.textContent = `${normalized} 小时`;
  el.intervalSource.textContent = sourceText;
}

function inferIntervalFromRows(rows) {
  const diffs = rows
    .slice(1)
    .map((row, index) => (row.fundingTime - rows[index].fundingTime) / 3600000)
    .filter((hours) => Number.isFinite(hours) && hours > 0.2 && hours <= 24);
  if (!diffs.length) return null;
  const buckets = new Map();
  for (const hours of diffs) {
    const rounded = Math.round(hours);
    buckets.set(rounded, (buckets.get(rounded) || 0) + 1);
  }
  return [...buckets.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

async function loadContractMeta(symbol = currentSymbol(), source = "当前合约") {
  if (!symbol) return;
  const cached = state.contractMeta.get(symbol);
  if (cached) {
    setIntervalHours(cached.intervalHours, cached.sourceText || source);
    return;
  }

  const marketRow = state.market.find((row) => row.symbol === symbol);
  if (marketRow?.intervalHours) {
    const meta = { intervalHours: marketRow.intervalHours, sourceText: "来自市场榜单" };
    state.contractMeta.set(symbol, meta);
    setIntervalHours(meta.intervalHours, meta.sourceText);
    return;
  }

  el.intervalDisplay.textContent = "";
  el.intervalSource.textContent = "";
  try {
    const url = new URL("/api/contractMeta", location.origin);
    url.searchParams.set("symbol", symbol);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Aster 鎺ュ彛杩斿洖 ${response.status}`);
    const meta = await response.json();
    const saved = { intervalHours: meta.intervalHours || 8, sourceText: "来自 Aster 合约数据" };
    state.contractMeta.set(symbol, saved);
    setIntervalHours(saved.intervalHours, saved.sourceText);
  } catch (error) {
    setIntervalHours(8, "");
  }
}

async function fetchFundingHistory() {
  const symbol = el.symbol.value.trim().toUpperCase();
  if (!symbol) throw new Error("Please enter a symbol");

  const from = startMs();
  const to = endMs();
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error("请选择有效的开始日期和结束日期");
  }

  const all = [];
  let cursor = from;
  let guard = 0;

  while (cursor <= to && guard < 30) {
    const url = new URL(localApi("/api/fundingRate"), location.origin);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(to));
    url.searchParams.set("limit", "1000");

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Aster 鎺ュ彛杩斿洖 ${response.status}`);

    const batch = await response.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);

    const lastTime = Number(batch[batch.length - 1].fundingTime);
    if (!Number.isFinite(lastTime) || lastTime <= cursor) break;
    cursor = lastTime + 1;
    guard += 1;
    if (batch.length < 1000) break;
  }

  return normalizeRows(all, symbol);
}

function normalizeRows(rows, fallbackSymbol) {
  const seen = new Set();
  return rows
    .map((item) => ({
      symbol: item.symbol || fallbackSymbol,
      fundingRate: Number(item.fundingRate),
      fundingTime: Number(item.fundingTime),
    }))
    .filter((item) => {
      const key = `${item.symbol}-${item.fundingTime}`;
      const ok =
        item.symbol &&
        Number.isFinite(item.fundingRate) &&
        Number.isFinite(item.fundingTime) &&
        !seen.has(key);
      if (ok) seen.add(key);
      return ok;
    })
    .sort((a, b) => a.fundingTime - b.fundingTime);
}

function buildSample() {
  const symbol = el.symbol.value.trim().toUpperCase() || "BTCUSDT";
  const from = startMs();
  const to = endMs();
  const interval = Number(el.intervalHours.value) * 60 * 60 * 1000;
  const rows = [];
  let index = 0;

  for (let time = from; time <= to; time += interval) {
    const wave = Math.sin(index / 4) * 0.00009 + Math.cos(index / 11) * 0.00004;
    const drift = index % 17 > 10 ? -0.00003 : 0.000025;
    rows.push({ symbol, fundingRate: Number((wave + drift).toFixed(8)), fundingTime: time });
    index += 1;
  }

  return rows;
}

function runBacktest(rows) {
  const sideSign = el.side.value === "short" ? 1 : -1;
  const baseNotional = Math.max(Number(el.notional.value), 0);
  const entryCost = (baseNotional * Number(el.entryCostBps.value || 0)) / 10000;
  const exitCost = (baseNotional * Number(el.exitCostBps.value || 0)) / 10000;
  let equity = -entryCost;
  let notional = baseNotional;

  const result = rows.map((row) => {
    const pnl = notional * row.fundingRate * sideSign;
    equity += pnl;
    if (el.compound.checked) notional = Math.max(0, baseNotional + equity);
    return { ...row, pnl, equity };
  });

  if (result.length) {
    equity -= exitCost;
    result[result.length - 1] = {
      ...result[result.length - 1],
      equity,
      pnl: result[result.length - 1].pnl - exitCost,
    };
  }

  return result;
}

function summarize(result) {
  if (!result.length) {
    return { total: 0, apr: 0, maxDrawdown: 0, positive: 0, negative: 0, flat: 0, avgRate: 0, days: 0 };
  }

  const initial = Math.max(Number(el.notional.value), 1);
  const total = result[result.length - 1].equity;
  const first = result[0].fundingTime;
  const last = result[result.length - 1].fundingTime;
  const days = Math.max((last - first) / 86400000, 1 / 24);
  let peak = 0;
  let maxDrawdown = 0;

  for (const row of result) {
    peak = Math.max(peak, row.equity);
    const dd = peak === 0 ? Math.max(0, -row.equity / initial) : Math.max(0, (peak - row.equity) / initial);
    maxDrawdown = Math.max(maxDrawdown, dd);
  }

  const positive = result.filter((row) => row.fundingRate > 0).length;
  const negative = result.filter((row) => row.fundingRate < 0).length;
  const flat = result.length - positive - negative;
  const avgRate = result.reduce((sum, row) => sum + row.fundingRate, 0) / result.length;

  return { total, apr: (total / initial / days) * 365, maxDrawdown, positive, negative, flat, avgRate, days };
}

function updateUi(rows, sourceLabel) {
  state.raw = rows;
  state.result = runBacktest(rows);
  const summary = summarize(state.result);
  const totalCount = Math.max(state.result.length, 1);

  el.dataStatus.textContent = sourceLabel;
  el.totalPnl.textContent = money(summary.total);
  el.totalPnl.className = signedClass(summary.total);
  el.pnlCaption.textContent = `${el.side.value === "short" ? "Short" : "Long"} funding net`;
  el.apr.textContent = pct(summary.apr);
  el.apr.className = signedClass(summary.apr);
  el.drawdown.textContent = pct(summary.maxDrawdown);
  el.periods.textContent = String(state.result.length);
  el.dateRange.textContent = state.result.length
    ? `${new Date(state.result[0].fundingTime).toLocaleDateString()} - ${new Date(
        state.result[state.result.length - 1].fundingTime,
      ).toLocaleDateString()}`
    : "暂无区间";
  el.rateSummary.textContent = `平均 ${pct(summary.avgRate, 4)}`;
  el.positiveCount.textContent = String(summary.positive);
  el.negativeCount.textContent = String(summary.negative);
  el.flatCount.textContent = String(summary.flat);
  el.positiveBar.style.width = `${(summary.positive / totalCount) * 100}%`;
  el.negativeBar.style.width = `${(summary.negative / totalCount) * 100}%`;
  el.flatBar.style.width = `${(summary.flat / totalCount) * 100}%`;
  el.tableCount.textContent = `${state.result.length} rows`;
  updateChartCaption(state.result);

  renderTable(state.result);
  drawChart(state.result);
}

function renderTable(result) {
  if (!result.length) {
    el.rows.innerHTML = '<tr><td colspan="5" class="empty">没有该区间的资金费率数据</td></tr>';
    return;
  }

  el.rows.innerHTML = result
    .slice()
    .reverse()
    .map(
      (row) => `<tr>
        <td>${new Date(row.fundingTime).toLocaleString()}</td>
        <td>${row.symbol}</td>
        <td class="${signedClass(row.fundingRate)}">${pct(row.fundingRate, 4)}</td>
        <td class="${signedClass(row.pnl)}">${money(row.pnl)}</td>
        <td class="${signedClass(row.equity)}">${money(row.equity)}</td>
      </tr>`,
    )
    .join("");
}

async function refreshMarketStats() {
  if (state.marketLoading) return;
  state.marketLoading = true;
  el.refreshMarketBtn.disabled = true;
  el.marketStatus.textContent = "刷新中...";
  if (!state.market.length) {
    el.marketRows.innerHTML = `<tr><td colspan="10" class="empty">正在加载市场数据...</td></tr>`;
  }
  try {
    const quickUrl = new URL("/api/marketStats", location.origin);
    quickUrl.searchParams.set("limit", "200");
    quickUrl.searchParams.set("historyLimit", "0");
    quickUrl.searchParams.set("_", String(Date.now()));
    const response = await fetch(quickUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Aster 鎺ュ彛杩斿洖 ${response.status}`);
    const payload = await response.json();
    state.market = Array.isArray(payload.rows) ? payload.rows : [];
    state.market.forEach((row) => {
      if (row.symbol && row.intervalHours) {
        state.contractMeta.set(row.symbol, {
          intervalHours: row.intervalHours,
          sourceText: "来自市场榜单",
        });
      }
    });
    renderMarket();
    loadContractMeta(currentSymbol());
    loadFullMarketHistory();
    el.marketStatus.textContent = "每分钟自动刷新";
    el.marketUpdated.textContent = `更新于 ${new Date(payload.updatedAt || Date.now()).toLocaleTimeString()}`;
  } catch (error) {
    el.marketStatus.textContent = "刷新失败";
    el.marketRows.innerHTML = `<tr><td colspan="10" class="empty">${error.message}</td></tr>`;
  } finally {
    state.marketLoading = false;
    el.refreshMarketBtn.disabled = false;
  }
}

async function loadFullMarketHistory() {
  try {
    const historyUrl = new URL("/api/marketStats", location.origin);
    historyUrl.searchParams.set("limit", "200");
    historyUrl.searchParams.set("historyLimit", "260");
    historyUrl.searchParams.set("_", String(Date.now()));
    const response = await fetch(historyUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Aster API returned ${response.status}`);
    const payload = await response.json();
    state.market = Array.isArray(payload.rows) ? payload.rows : [];
    state.market.forEach((row) => {
      if (row.symbol && row.intervalHours) {
        state.contractMeta.set(row.symbol, {
          intervalHours: row.intervalHours,
          sourceText: "Market list",
        });
      }
    });
    renderMarket();
    loadContractMeta(currentSymbol());
    el.marketStatus.textContent = "每分钟自动刷新";
    el.marketUpdated.textContent = `更新于 ${new Date(payload.updatedAt || Date.now()).toLocaleTimeString()}`;
  } catch (error) {
    el.marketStatus.textContent = "";
  }
}

function scheduleMarketSearch() {
  if (!el.marketSearch) return;
  const query = marketSearchQuery();
  state.marketSearchRow = null;
  window.clearTimeout(state.marketSearchTimer);
  renderMarket();
  if (!query) return;

  const normalized = normalizeMarketQuery(query);
  const exactLocal = state.market.some((row) => String(row.symbol || "").toUpperCase() === normalized);
  if (exactLocal || query.length < 2) return;

  state.marketSearchTimer = window.setTimeout(() => searchMarketSymbol(normalized), 350);
}

async function searchMarketSymbol(symbol) {
  if (!symbol) return;
  state.marketSearchLoading = true;
  renderMarket();
  try {
    const url = new URL("/api/marketSymbol", location.origin);
    url.searchParams.set("symbol", symbol);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Aster API returned ${response.status}`);
    const payload = await response.json();
    state.marketSearchRow = payload.row || null;
    if (state.marketSearchRow?.symbol && state.marketSearchRow?.intervalHours) {
      state.contractMeta.set(state.marketSearchRow.symbol, {
        intervalHours: state.marketSearchRow.intervalHours,
        sourceText: "来自 Aster 全市场查询",
      });
    }
  } catch (error) {
    state.marketSearchRow = null;
  } finally {
    state.marketSearchLoading = false;
    renderMarket();
  }
}

function renderMarket() {
  const query = marketSearchQuery();
  const rows = marketRowsForQuery(query).sort((a, b) => compareMarket(a, b));
  const positive = rows.filter((row) => row.fundingRate > 0).length;
  const negative = rows.filter((row) => row.fundingRate < 0).length;
  const top = rows.reduce((best, row) => (!best || row.annualized > best.annualized ? row : best), null);
  updateMarketSortHeaders();

  el.marketCount.textContent = String(rows.length);
  el.marketPositive.textContent = String(positive);
  el.marketNegative.textContent = String(negative);
  el.marketTopApr.textContent = top ? pct(top.annualized) : "0.00%";
  el.marketTopApr.className = top ? signedClass(top.annualized) : "";

  if (!rows.length) {
    const message = query
      ? (state.marketSearchLoading ? "正在查询 Aster 全市场..." : "未找到该合约")
      : "暂无市场数据";
    el.marketRows.innerHTML = `<tr><td colspan="10" class="empty">${message}</td></tr>`;
    return;
  }

  el.marketRows.innerHTML = rows
    .map(
      (row, index) => `<tr data-symbol="${row.symbol}">
        <td>${index + 1}</td>
        <td><button class="symbol-chip" type="button" data-symbol="${row.symbol}">${row.symbol}</button></td>
        <td>${price(row.price)}</td>
        <td class="${signedClass(row.fundingRate)}">${pct(row.fundingRate, 4)}</td>
        <td class="${signedClass(row.annualized)}">${pct(row.annualized)}</td>
        <td>${row.intervalHours || "-"}h</td>
        <td>${money(row.openInterestUsd, true)}</td>
        <td>${money(row.quoteVolume, true)}</td>
        <td class="${signedClass(row.sum7d)}">${pct(row.sum7d, 4)}</td>
        <td class="${signedClass(row.sum30d)}">${pct(row.sum30d, 4)}</td>
      </tr>`,
    )
    .join("");
}

function marketSearchQuery() {
  return (el.marketSearch?.value || "").trim().toUpperCase();
}

function normalizeMarketQuery(query) {
  const compact = String(query || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!compact) return "";
  return compact.endsWith("USDT") || compact.endsWith("USD") ? compact : `${compact}USDT`;
}

function marketRowsForQuery(query) {
  if (!query) return [...state.market];
  const normalized = normalizeMarketQuery(query);
  const localRows = state.market.filter((row) => {
    const symbol = String(row.symbol || "").toUpperCase();
    return symbol.includes(query) || symbol === normalized;
  });
  const searchRows = state.marketSearchRow ? [state.marketSearchRow] : [];
  const merged = new Map();
  [...searchRows, ...localRows].forEach((row) => merged.set(row.symbol, row));
  return [...merged.values()];
}

function compareMarket(a, b) {
  const { key, dir } = state.marketSort;
  const directionalRateKeys = new Set(["fundingRate", "annualized", "sum7d", "sum30d"]);
  const av = a[key];
  const bv = b[key];
  if (directionalRateKeys.has(key)) {
    const primary = dir === "desc"
      ? (Number(bv) || 0) - (Number(av) || 0)
      : (Number(av) || 0) - (Number(bv) || 0);
    if (primary !== 0) return primary;
    return String(a.symbol || "").localeCompare(String(b.symbol || ""));
  }
  const direction = dir === "asc" ? 1 : -1;
  if (typeof av === "string" || typeof bv === "string") {
    return String(av || "").localeCompare(String(bv || "")) * direction;
  }
  const primary = ((Number(av) || 0) - (Number(bv) || 0)) * direction;
  if (primary !== 0) return primary;
  return String(a.symbol || "").localeCompare(String(b.symbol || ""));
}

function updateMarketSortHeaders() {
  document.querySelectorAll(".market-table th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === state.marketSort.key;
    th.classList.toggle("sort-active", active);
    th.dataset.direction = active ? state.marketSort.dir : "";
    const arrow = th.querySelector(".sort-arrow");
    if (arrow) arrow.innerHTML = active ? (state.marketSort.dir === "desc" ? "&#8595;" : "&#8593;") : "&#8597;";
  });
}

async function selectMarketSymbol(symbol) {
  el.symbol.value = symbol;
  const row = state.market.find((item) => item.symbol === symbol);
  if (row?.intervalHours) setIntervalHours(row.intervalHours, "来自市场榜单");
  await handleFetch();
  document.querySelector(".workspace")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function visibleChartRows(result) {
  if (!result.length || state.chartRange === "all") return result;
  const days = Number(state.chartRange);
  if (!Number.isFinite(days)) return result;
  const end = result[result.length - 1].fundingTime;
  const start = end - days * 86400000;
  return result.filter((row) => row.fundingTime >= start);
}

function updateChartCaption(result) {
  const rows = visibleChartRows(result);
  if (!rows.length) {
    el.chartCaption.textContent = "";
    return;
  }
  const latest = rows[rows.length - 1].fundingRate;
  const avg = rows.reduce((sum, row) => sum + row.fundingRate, 0) / rows.length;
  const label = state.chartRange === "all" ? "All" : `Last ${state.chartRange} days`;
  el.chartCaption.textContent = `${label} latest ${pct(latest, 4)} / avg ${pct(avg, 4)}`;
}

function drawChart(result) {
  const canvas = el.chart;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(760, Math.floor(rect.width * dpr));
  canvas.height = Math.floor((rect.width > 900 ? 380 : 320) * dpr);

  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = 48 * dpr;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfc";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#dce4e0";
  ctx.lineWidth = dpr;
  ctx.font = `${12 * dpr}px Inter, sans-serif`;
  ctx.fillStyle = "#65736d";

  for (let i = 0; i <= 4; i += 1) {
    const y = pad + ((height - pad * 2) * i) / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(width - pad, y);
    ctx.stroke();
  }

  const rows = visibleChartRows(result);
  updateChartCaption(result);

  if (!rows.length) {
    return;
  }

  const values = rows.map((row) => row.fundingRate);
  const rawMin = Math.min(...values, 0);
  const rawMax = Math.max(...values, 0);
  const spread = rawMax - rawMin || Math.max(Math.abs(rawMax), 0.0001);
  const min = rawMin - spread * 0.12;
  const max = rawMax + spread * 0.12;
  const range = max - min || 1;
  const plotW = width - pad * 2;
  const plotH = height - pad * 2;

  function xAt(index) {
    return pad + (plotW * index) / Math.max(values.length - 1, 1);
  }

  function yAt(value) {
    return pad + plotH - ((value - min) / range) * plotH;
  }

  const zeroY = yAt(0);
  ctx.strokeStyle = "rgba(23, 32, 29, 0.45)";
  ctx.beginPath();
  ctx.moveTo(pad, zeroY);
  ctx.lineTo(width - pad, zeroY);
  ctx.stroke();

  ctx.beginPath();
  values.forEach((value, index) => {
    const x = xAt(index);
    const y = yAt(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "rgba(23, 32, 29, 0.18)";
  ctx.lineWidth = 3 * dpr;
  ctx.stroke();

  drawRateSegment(ctx, values, xAt, yAt, (value) => value >= 0, "#0d8f63", dpr);
  drawRateSegment(ctx, values, xAt, yAt, (value) => value < 0, "#d84f45", dpr);

  ctx.fillStyle = "#65736d";
  ctx.fillText(pct(rawMax, 4), pad, pad - 14 * dpr);
  ctx.fillText(pct(rawMin, 4), pad, height - pad + 28 * dpr);
  ctx.fillText("0.0000%", width - pad - 70 * dpr, zeroY - 8 * dpr);

  const ticks = Math.min(rows.length, 6);
  ctx.fillStyle = "#8a9691";
  for (let i = 0; i < ticks; i += 1) {
    const index = Math.round((rows.length - 1) * (i / Math.max(ticks - 1, 1)));
    const date = new Date(rows[index].fundingTime);
    const label = `${date.getMonth() + 1}/${date.getDate()}`;
    ctx.fillText(label, xAt(index) - 14 * dpr, height - 16 * dpr);
  }
}

function drawRateSegment(ctx, values, xAt, yAt, predicate, color, dpr) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2 * dpr;
  ctx.beginPath();
  let drawing = false;
  values.forEach((value, index) => {
    if (!predicate(value)) {
      drawing = false;
      return;
    }
    const x = xAt(index);
    const y = yAt(value);
    if (!drawing) {
      ctx.moveTo(x, y);
      drawing = true;
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();
}

function drawChart(result) {
  const canvas = el.chart;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(760, Math.floor(rect.width * dpr));
  canvas.height = Math.floor((rect.width > 900 ? 380 : 320) * dpr);

  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const padLeft = 76 * dpr;
  const padRight = 28 * dpr;
  const padTop = 42 * dpr;
  const padBottom = 54 * dpr;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#fbfcfc";
  ctx.fillRect(0, 0, width, height);

  const rows = visibleChartRows(result);
  updateChartCaption(result);

  if (!rows.length) {
    state.chartGeometry = null;
    hideChartTooltip();
    ctx.font = `${13 * dpr}px Inter, sans-serif`;
    ctx.fillStyle = "#65736d";
    return;
  }

  const values = rows.map((row) => row.fundingRate);
  const rawMin = Math.min(...values, 0);
  const rawMax = Math.max(...values, 0);
  const spread = rawMax - rawMin || Math.max(Math.abs(rawMax), 0.0001);
  const min = rawMin - spread * 0.12;
  const max = rawMax + spread * 0.12;
  const range = max - min || 1;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const xAt = (index) => padLeft + (plotW * index) / Math.max(values.length - 1, 1);
  const yAt = (value) => padTop + plotH - ((value - min) / range) * plotH;

  state.chartGeometry = { rows, values, xAt, yAt, dpr, padLeft, padRight, padTop, padBottom, width, height };

  ctx.lineWidth = dpr;
  ctx.font = `${12 * dpr}px Inter, sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";

  buildYAxisTicks(rawMin, rawMax).forEach((tick) => {
    const y = yAt(tick);
    ctx.strokeStyle = Math.abs(tick) < 1e-12 ? "rgba(23, 32, 29, 0.42)" : "#dce4e0";
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(width - padRight, y);
    ctx.stroke();
    ctx.fillStyle = "#65736d";
    ctx.fillText(pct(tick, 4), padLeft - 12 * dpr, y);
  });

  ctx.beginPath();
  values.forEach((value, index) => {
    const x = xAt(index);
    const y = yAt(value);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = "rgba(23, 32, 29, 0.18)";
  ctx.lineWidth = 3 * dpr;
  ctx.stroke();

  drawRateSegment(ctx, values, xAt, yAt, (value) => value >= 0, "#0d8f63", dpr);
  drawRateSegment(ctx, values, xAt, yAt, (value) => value < 0, "#d84f45", dpr);

  const ticks = Math.min(rows.length, 6);
  ctx.fillStyle = "#8a9691";
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  for (let i = 0; i < ticks; i += 1) {
    const index = Math.round((rows.length - 1) * (i / Math.max(ticks - 1, 1)));
    const date = new Date(rows[index].fundingTime);
    ctx.fillText(`${date.getMonth() + 1}/${date.getDate()}`, xAt(index), height - 18 * dpr);
  }

  if (state.chartHoverIndex !== null) drawChartHover(ctx, state.chartGeometry, state.chartHoverIndex);
}

function buildYAxisTicks(rawMin, rawMax) {
  const ticks = [];
  for (let i = 4; i >= 0; i -= 1) {
    ticks.push(rawMin + ((rawMax - rawMin) * i) / 4);
  }
  if (rawMin < 0 && rawMax > 0) ticks.push(0);
  if (rawMin === rawMax) ticks.push(0);
  return [...new Set(ticks.map((tick) => Number(tick.toFixed(8))))].sort((a, b) => b - a);
}

function drawChartHover(ctx, geometry, index) {
  const row = geometry.rows[index];
  if (!row) return;
  const x = geometry.xAt(index);
  const y = geometry.yAt(row.fundingRate);
  const dpr = geometry.dpr;

  ctx.save();
  ctx.strokeStyle = "rgba(23, 32, 29, 0.45)";
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(x, geometry.padTop);
  ctx.lineTo(x, geometry.height - geometry.padBottom);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, 4.2 * dpr, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = row.fundingRate >= 0 ? "#0d8f63" : "#d84f45";
  ctx.stroke();
  ctx.restore();
}

function nearestChartIndex(clientX) {
  const geometry = state.chartGeometry;
  if (!geometry) return null;
  const rect = el.chart.getBoundingClientRect();
  const x = (clientX - rect.left) * geometry.dpr;
  const plotW = geometry.width - geometry.padLeft - geometry.padRight;
  const ratio = (x - geometry.padLeft) / Math.max(plotW, 1);
  return Math.max(0, Math.min(geometry.rows.length - 1, Math.round(ratio * (geometry.rows.length - 1))));
}

function showChartTooltip(index, clientX, clientY) {
  const row = state.chartGeometry?.rows[index];
  if (!row || !el.chartTooltip) return;
  const wrap = el.chart.parentElement.getBoundingClientRect();
  const left = Math.min(Math.max(clientX - wrap.left + 14, 8), wrap.width - 148);
  const top = Math.max(clientY - wrap.top - 56, 8);
  el.chartTooltip.hidden = false;
  el.chartTooltip.style.left = `${left}px`;
  el.chartTooltip.style.top = `${top}px`;
  el.chartTooltip.innerHTML = `${new Date(row.fundingTime).toLocaleString()}<strong>${pct(row.fundingRate, 4)}</strong>`;
}

function hideChartTooltip() {
  if (el.chartTooltip) el.chartTooltip.hidden = true;
}

function exportCsv() {
  if (!state.result.length) return;
  const header = ["time", "symbol", "fundingRate", "periodPnl", "cumulativePnl"];
  const lines = state.result.map((row) =>
    [new Date(row.fundingTime).toISOString(), row.symbol, row.fundingRate, row.pnl.toFixed(8), row.equity.toFixed(8)].join(","),
  );
  const blob = new Blob([[header.join(","), ...lines].join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${el.symbol.value.trim().toUpperCase() || "ASTER"}-funding-backtest.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function handleFetch() {
  el.fetchBtn.disabled = true;
  el.fetchBtn.textContent = "加载中...";
  el.dataStatus.textContent = "";
  try {
    const rows = await fetchFundingHistory();
    const inferred = inferIntervalFromRows(rows);
    if (inferred) {
      const symbol = currentSymbol();
      const meta = { intervalHours: inferred, sourceText: "来自历史结算记录" };
      state.contractMeta.set(symbol, meta);
      setIntervalHours(meta.intervalHours, meta.sourceText);
    }
    updateUi(rows, "Aster 实盘数据");
  } catch (error) {
    el.dataStatus.textContent = "请求失败";
    alert(`${error.message}\n\n可以先点击示例数据查看回测面板。`);
  } finally {
    el.fetchBtn.disabled = false;
    el.fetchBtn.textContent = "获取 Aster 数据";
  }
}

setDefaultDates();
setIntervalHours(8, "");
drawChart([]);
refreshMarketStats();
state.marketTimer = window.setInterval(refreshMarketStats, 60000);

el.fetchBtn.addEventListener("click", handleFetch);
let symbolMetaTimer = null;
el.symbol.addEventListener("input", () => {
  window.clearTimeout(symbolMetaTimer);
  symbolMetaTimer = window.setTimeout(() => loadContractMeta(currentSymbol()), 650);
});
el.symbol.addEventListener("change", () => loadContractMeta(currentSymbol()));
el.symbol.addEventListener("blur", () => loadContractMeta(currentSymbol()));
el.sampleBtn.addEventListener("click", () => updateUi(buildSample(), "绀轰緥鏁版嵁"));
el.exportBtn.addEventListener("click", exportCsv);
el.refreshMarketBtn.addEventListener("click", refreshMarketStats);
el.marketSearch?.addEventListener("input", scheduleMarketSearch);
el.marketRows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-symbol]");
  if (button) selectMarketSymbol(button.dataset.symbol);
});
document.querySelectorAll(".market-table th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    state.marketSort = {
      key,
      dir: state.marketSort.key === key && state.marketSort.dir === "desc" ? "asc" : "desc",
    };
    renderMarket();
  });
});
el.chartRanges.forEach((button) => {
  button.addEventListener("click", () => {
    state.chartRange = button.dataset.range;
    el.chartRanges.forEach((item) => item.classList.toggle("active", item === button));
    drawChart(state.result);
  });
});
el.chart.addEventListener("mousemove", (event) => {
  const index = nearestChartIndex(event.clientX);
  if (index === null) return;
  state.chartHoverIndex = index;
  drawChart(state.result);
  showChartTooltip(index, event.clientX, event.clientY);
});
el.chart.addEventListener("mouseleave", () => {
  state.chartHoverIndex = null;
  hideChartTooltip();
  drawChart(state.result);
});

[el.side, el.notional, el.entryCostBps, el.exitCostBps, el.compound].forEach((control) => {
  control.addEventListener("input", () => {
    if (state.raw.length) updateUi(state.raw, el.dataStatus.textContent);
  });
});

window.addEventListener("resize", () => drawChart(state.result));
