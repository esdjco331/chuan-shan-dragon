const RESULT_CACHE = new Map();
const STOCK_LIST_CACHE = {
  list: null,
  time: 0
};

const CACHE_TIME = 1000 * 5; // 5秒快取
const STOCK_LIST_CACHE_TIME = 1000 * 60 * 60; // 1小時快取

export default async function handler(req, res) {
  const input = String(req.query.stockNo || "").trim();

  if (!input) {
    return res.status(400).json({ ok: false, message: "請輸入股號或股名" });
  }

  try {
    const resolved = await resolveStock(input);

    if (!resolved.stockNo) {
      return res.status(200).json({
        ok: false,
        message: `查不到「${input}」對應的股號，請改用股號查詢。`
      });
    }

    const stockNo = resolved.stockNo;
    const cacheKey = stockNo;
    const forceRefresh = req.query.refresh === "1" || !!req.query._t;
    const cached = RESULT_CACHE.get(cacheKey);

    if (!forceRefresh && cached && Date.now() - cached.time < CACHE_TIME) {
      return res.status(200).json({
        ...cached.data,
        cache: true
      });
    }

    let stockName = resolved.stockName || "";
    let market = resolved.market || "";

    if (!market) {
      market = await detectMarket(stockNo);
    }

    const quote = await getRealtimeQuote(stockNo);

    let rows = [];

    // 抓取 7 個月資料，足以穩定計算 120MA (半年線)，速度極快
    if (market === "tpex") {
      rows = await fetchTpexDaily(stockNo, 7);
    } else if (market === "twse") {
      rows = await fetchTwseDaily(stockNo, 7);
    } else {
      const [twseRows, tpexRows] = await Promise.all([
        fetchTwseDaily(stockNo, 7),
        fetchTpexDaily(stockNo, 7)
      ]);

      if (twseRows.length >= tpexRows.length) {
        rows = twseRows;
        market = "twse";
      } else {
        rows = tpexRows;
        market = "tpex";
      }
    }

    if (!stockName) {
      stockName = quote.name || await getStockNameByCode(stockNo);
    }

    const displayName = `${stockNo}${stockName ? " " + stockName : ""}`;

    if (rows.length < 60) {
      return res.status(200).json({
        ok: false,
        stockNo,
        stockName,
        displayName,
        market,
        ...quote,
        message: `${displayName} 日K資料不足，可能是股號錯誤、非上市櫃，或資料來源暫時無法取得。`
      });
    }

    // 動態併入今日即時價
    const todayStr = getTodayRocDate();
    const lastRowDate = rows[rows.length - 1]?.date;

    if (quote.currentPrice) {
      if (lastRowDate === todayStr) {
        const last = rows[rows.length - 1];
        last.close = quote.currentPrice;
        if (quote.currentPrice > last.high) last.high = quote.currentPrice;
        if (quote.currentPrice < last.low) last.low = quote.currentPrice;
      } else {
        rows.push({
          date: todayStr,
          open: quote.currentPrice,
          high: quote.currentPrice,
          low: quote.currentPrice,
          close: quote.currentPrice
        });
      }
    }

    // 計算均線 (20MA, 60MA 季線, 120MA 半年線)
    rows = addAllMAs(rows);

    const latestRow = rows[rows.length - 1];
    const latestMA20 = latestRow?.ma20 ? round2(latestRow.ma20) : null;
    const latestMA60 = latestRow?.ma60 ? round2(latestRow.ma60) : null;
    const latestMA120 = latestRow?.ma120 ? round2(latestRow.ma120) : null;

    const currentPriceForMA = quote.currentPrice || latestRow.close;

    const isAboveMA20 = latestMA20 !== null && currentPriceForMA > latestMA20;
    
    // 濾網：需同時站上 60MA (季線) 與 120MA (半年線)
    const isAboveMA60 = latestMA60 === null || currentPriceForMA > latestMA60;
    const isAboveMA120 = latestMA120 === null || currentPriceForMA > latestMA120;

    const isAboveLongTermMAs = isAboveMA60 && isAboveMA120;

    const crosses = findCrosses(rows);

    // 未站上長天期均線時的處理
    if (!isAboveLongTermMAs) {
      return res.status(200).json({
        ok: false,
        stockNo,
        stockName,
        displayName,
        market,
        ...quote,
        latestMA20,
        latestMA60,
        latestMA120,
        isAboveMA20,
        isAboveLongTermMAs: false,
        ma20Status: isAboveMA20 ? "已站上20MA" : "未穿惡",
        message: `${displayName} 該股均線壓力大（未同時站在季線與半年線之上），故不顯示目標價。`
      });
    }

    if (crosses.length < 2) {
      return res.status(200).json({
        ok: false,
        stockNo,
        stockName,
        displayName,
        market,
        ...quote,
        latestMA20,
        isAboveMA20,
        isAboveLongTermMAs,
        ma20Status: isAboveMA20 ? "已站上20MA" : "未穿惡",
        message: `${displayName} 找不到足夠的穿惡訊號，至少需要最近一次穿惡與前方一段有效穿惡。`
      });
    }

    const latestCross = crosses[crosses.length - 1];
    const halfYearAgo = new Date();
    halfYearAgo.setMonth(halfYearAgo.getMonth() - 6);

    let validWave = null;
    let checkedWaveCount = 0;
    let bestWave = null;

    for (let i = crosses.length - 2; i >= 0; i--) {
      const cross = crosses[i];
      if (new Date(cross.date) < halfYearAgo) break;

      const wave = buildWave(rows, cross);
      if (!wave) continue;

      checkedWaveCount++;
      if (!bestWave || wave.gainPercent > bestWave.gainPercent) {
        bestWave = wave;
      }

      if (wave.gainPercent > 25) {
        validWave = wave;
        break;
      }
    }

    if (!validWave) {
      return res.status(200).json({
        ok: false,
        stockNo,
        stockName,
        displayName,
        market,
        ...quote,
        latestMA20,
        isAboveMA20,
        isAboveLongTermMAs,
        ma20Status: isAboveMA20 ? "已站上20MA" : "未穿惡",
        message: bestWave
          ? `${displayName} 半年內找過 ${checkedWaveCount} 段完成波段，最高漲幅僅 ${round2(bestWave.gainPercent)}%，未達25%。`
          : `${displayName} 半年內找不到符合條件的完成波段。`
      });
    }

    const low1 = validWave.low1;
    const high1 = validWave.high1;
    const gainPercent = ((high1 - low1) / low1) * 100;
    
    // 穿山惡龍目標價公式 (含 50% 加權)
    const factor = ((gainPercent + 100) / 100 * 0.5) + 1;
    const low2 = isAboveMA20 ? latestCross.low : null;

    const canShowTarget = isAboveMA20 && isAboveLongTermMAs;
    const roundedTarget = canShowTarget ? round2(low2 * factor) : null;

    const targetDistancePercent =
      canShowTarget && quote.currentPrice && roundedTarget
        ? round2(((roundedTarget - quote.currentPrice) / quote.currentPrice) * 100)
        : null;

    const reachedTarget =
      canShowTarget && quote.currentPrice && roundedTarget
        ? quote.currentPrice >= roundedTarget
        : null;

    const result = {
      ok: true,
      stockNo,
      stockName,
      displayName,
      market,

      currentPrice: quote.currentPrice,
      dayChange: quote.dayChange,
      dayChangePercent: quote.dayChangePercent,
      volume: quote.volume,
      volumeUnit: "張",

      latestMA20,
      latestMA60,
      latestMA120,
      isAboveMA20,
      isAboveLongTermMAs,
      ma20Status: isAboveMA20 ? "目前已站上20MA" : "目前尚未穿惡",

      low1: round2(low1),
      high1: round2(high1),
      low2: canShowTarget ? round2(low2) : null,

      target: roundedTarget,
      targetDistancePercent,
      reachedTarget,

      targetMessage:
        !isAboveLongTermMAs
          ? "該股均線壓力大，不顯示目標價"
          : !isAboveMA20
            ? "目前尚未穿惡，不顯示目標價"
            : reachedTarget === null
              ? "即時行情不足，無法判斷是否達標"
              : reachedTarget
                ? "目前股價已達目標價"
                : `距離目標價還有 ${targetDistancePercent}%`,

      cache: false
    };

    RESULT_CACHE.set(cacheKey, {
      time: Date.now(),
      data: result
    });

    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: "系統錯誤：" + err.message
    });
  }
}

/* ===== 即時行情解析 ===== */

async function getRealtimeQuote(stockNo) {
  try {
    const url =
      `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?` +
      `ex_ch=tse_${stockNo}.tw|otc_${stockNo}.tw&json=1&delay=0&_=${Date.now()}`;

    const r = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": "https://mis.twse.com.tw/stock/index.jsp",
        "Cache-Control": "no-cache"
      }
    });

    const json = await r.json();
    const row = json?.msgArray?.find(item => String(item.c || "").trim() === String(stockNo));

    if (!row) return emptyQuote();

    const currentPrice = parseRealtimePrice(row);
    const yesterdayClose = toNumber(row.y);

    const dayChange = currentPrice && yesterdayClose ? round2(currentPrice - yesterdayClose) : null;
    const dayChangePercent = currentPrice && yesterdayClose ? round2(((currentPrice - yesterdayClose) / yesterdayClose) * 100) : null;
    const volume = toNumber(row.v);

    return {
      name: String(row.n || "").trim(),
      currentPrice,
      dayChange,
      dayChangePercent,
      volume
    };
  } catch (_) {
    return emptyQuote();
  }
}

function parseRealtimePrice(row) {
  if (!row) return null;
  let val = cleanPriceStr(row.z);
  if (val !== null) return val;
  val = cleanPriceStr(row.pz);
  if (val !== null) return val;
  val = cleanPriceStr(row.a);
  if (val !== null) return val;
  val = cleanPriceStr(row.b);
  if (val !== null) return val;
  val = cleanPriceStr(row.o);
  if (val !== null) return val;
  return null;
}

function cleanPriceStr(v) {
  if (v === undefined || v === null) return null;
  const str = String(v).split("_")[0].split("|")[0].replace(/-/g, "").trim();
  if (!str) return null;
  const n = Number(str);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function emptyQuote() {
  return { name: "", currentPrice: null, dayChange: null, dayChangePercent: null, volume: null };
}

/* ===== 股號 / 股名解析 ===== */

const STOCK_ALIAS = {
  "台積電": "2330", "鴻海": "2317", "聯發科": "2454", "聯電": "2303",
  "廣達": "2382", "緯創": "3231", "群創": "3481", "友達": "2409",
  "聯鈞": "3450", "科嶠": "4542", "國精化": "4722", "前鼎": "4908",
  "台半": "5425", "環球晶": "6488", "波若威": "3163", "聯茂": "6213"
};

async function resolveStock(input) {
  const text = normalizeText(input);
  if (/^\d{4,6}$/.test(text)) {
    return { stockNo: text, stockName: getAliasNameByCode(text), market: "" };
  }
  if (STOCK_ALIAS[text]) {
    return { stockNo: STOCK_ALIAS[text], stockName: text, market: "" };
  }

  const list = await getStockList();
  let found = list.find(s => normalizeText(s.name) === text) || list.find(s => normalizeText(s.name).includes(text));

  if (!found) return { stockNo: "", stockName: "", market: "" };

  return { stockNo: found.code, stockName: found.name, market: found.market };
}

function getAliasNameByCode(code) {
  for (const [name, stockCode] of Object.entries(STOCK_ALIAS)) {
    if (stockCode === code) return name;
  }
  return "";
}

async function getStockNameByCode(code) {
  const aliasName = getAliasNameByCode(code);
  if (aliasName) return aliasName;
  const list = await getStockList();
  const found = list.find(s => s.code === code);
  return found ? found.name : "";
}

async function detectMarket(code) {
  const list = await getStockList();
  const found = list.find(s => s.code === code);
  return found ? found.market : "";
}

async function getStockList() {
  const now = Date.now();
  if (STOCK_LIST_CACHE.list && now - STOCK_LIST_CACHE.time < STOCK_LIST_CACHE_TIME) {
    return STOCK_LIST_CACHE.list;
  }

  const list = [];
  await Promise.all([fetchTwseStockList(list), fetchTpexStockList(list)]);

  for (const [name, code] of Object.entries(STOCK_ALIAS)) {
    if (!list.some(s => s.code === code)) {
      list.push({ code, name, market: "" });
    }
  }

  STOCK_LIST_CACHE.list = uniqueStockList(list);
  STOCK_LIST_CACHE.time = now;
  return STOCK_LIST_CACHE.list;
}

async function fetchTwseStockList(list) {
  try {
    const r = await fetch("https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL", { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await r.json();
    if (!Array.isArray(json)) return;
    for (const item of json) {
      const code = String(item.Code || item["證券代號"] || "").trim();
      const name = String(item.Name || item["證券名稱"] || "").trim();
      if (/^\d{4,6}$/.test(code) && name) list.push({ code, name, market: "twse" });
    }
  } catch (_) {}
}

async function fetchTpexStockList(list) {
  try {
    const r = await fetch("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes", { headers: { "User-Agent": "Mozilla/5.0" } });
    const json = await r.json();
    if (!Array.isArray(json)) return;
    for (const item of json) {
      const code = String(item.Code || item.SecuritiesCompanyCode || item["代號"] || "").trim();
      const name = String(item.Name || item.CompanyName || item["名稱"] || "").trim();
      if (/^\d{4,6}$/.test(code) && name) list.push({ code, name, market: "tpex" });
    }
  } catch (_) {}
}

function uniqueStockList(list) {
  const map = new Map();
  for (const item of list) {
    if (!map.has(item.code)) map.set(item.code, item);
  }
  return Array.from(map.values());
}

function normalizeText(str) {
  return String(str || "").replace(/\s/g, "").replace("臺", "台").trim();
}

/* ===== 日K資料抓取 (7 個月) ===== */

async function fetchTwseDaily(stockNo, monthCount = 7) {
  const months = getRecentMonths(monthCount);

  const results = await Promise.all(
    months.map(async ym => {
      const url = `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ym}01&stockNo=${stockNo}`;
      try {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const json = await r.json();
        if (!json || !Array.isArray(json.data)) return [];

        return json.data.map(item => {
          const date = rocToDate(item[0]);
          const open = toNumber(item[3]);
          const high = toNumber(item[4]);
          const low = toNumber(item[5]);
          const close = toNumber(item[6]);
          return (date && open && high && low && close) ? { date, open, high, low, close } : null;
        }).filter(Boolean);
      } catch (_) {
        return [];
      }
    })
  );

  return uniqueSort(results.flat());
}

async function fetchTpexDaily(stockNo, monthCount = 7) {
  const months = getRecentMonths(monthCount);

  const results = await Promise.all(
    months.map(async ym => {
      const year = ym.slice(0, 4);
      const month = ym.slice(4, 6);
      const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${stockNo}&date=${year}/${month}/01&response=json`;

      try {
        const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        const json = await r.json();
        const data = Array.isArray(json.data) ? json.data : Array.isArray(json.tables?.[0]?.data) ? json.tables[0].data : [];

        return data.map(item => {
          const date = rocToDate(item[0]);
          const open = toNumber(item[3]);
          const high = toNumber(item[4]);
          const low = toNumber(item[5]);
          const close = toNumber(item[6]);
          return (date && open && high && low && close) ? { date, open, high, low, close } : null;
        }).filter(Boolean);
      } catch (_) {
        return [];
      }
    })
  );

  return uniqueSort(results.flat());
}

/* ===== 計算 MA ===== */

function addAllMAs(rows) {
  return rows.map((row, i) => {
    const calcMA = (period) => {
      if (i < period - 1) return null;
      const slice = rows.slice(i - (period - 1), i + 1);
      return slice.reduce((acc, r) => acc + r.close, 0) / period;
    };

    return {
      ...row,
      ma20: calcMA(20),
      ma60: calcMA(60),
      ma120: calcMA(120)
    };
  });
}

function findCrosses(rows) {
  const crosses = [];

  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const curr = rows[i];

    if (!prev.ma20 || !curr.ma20) continue;

    const wasBelow = prev.close <= prev.ma20;
    const nowAbove = curr.close > curr.ma20;

    if (wasBelow && nowAbove) {
      crosses.push({
        index: i,
        date: curr.date,
        low: curr.low,
        high: curr.high,
        close: curr.close,
        ma20: curr.ma20
      });
    }
  }

  return crosses;
}

function buildWave(rows, cross) {
  let high1 = cross.high;
  let breakDate = null;

  for (let i = cross.index + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.ma20) continue;

    if (r.close < r.ma20) {
      breakDate = r.date;
      break;
    }
    if (r.high > high1) {
      high1 = r.high;
    }
  }

  if (!breakDate) return null;

  const low1 = cross.low;
  const gainPercent = ((high1 - low1) / low1) * 100;

  return { crossDate: cross.date, low1, high1, gainPercent, breakDate };
}

/* ===== 工具函式 ===== */

function getTodayRocDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getRecentMonths(count) {
  const arr = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    arr.push(`${y}${m}`);
  }

  return arr.reverse();
}

function rocToDate(str) {
  if (!str) return null;
  const parts = String(str).replace(/\s/g, "").split(/[./-]/);
  if (parts.length < 3) return null;
  let y = parseInt(parts[0], 10);
  const m = String(parseInt(parts[1], 10)).padStart(2, "0");
  const d = String(parseInt(parts[2], 10)).padStart(2, "0");
  if (y < 1911) y += 1911;
  return `${y}-${m}-${d}`;
}

function toNumber(v) {
  if (v === undefined || v === null) return null;
  const n = Number(String(v).replace(/,/g, "").replace("--", "").replace(/X|除權|除息|息|權/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function uniqueSort(rows) {
  const map = new Map();
  for (const r of rows) map.set(r.date, r);
  return Array.from(map.values()).sort((a, b) => new Date(a.date) - new Date(b.date));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
