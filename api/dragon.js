const RESULT_CACHE = new Map();
const STOCK_LIST_CACHE = {
  list: null,
  time: 0
};

const CACHE_TIME = 1000 * 60 * 10; // 10分鐘
const STOCK_LIST_CACHE_TIME = 1000 * 60 * 60; // 1小時

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
    const cached = RESULT_CACHE.get(cacheKey);

    if (cached && Date.now() - cached.time < CACHE_TIME) {
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

    let rows = [];

    if (market === "tpex") {
      rows = await fetchTpexDaily(stockNo);
    } else if (market === "twse") {
      rows = await fetchTwseDaily(stockNo);
    } else {
      const [twseRows, tpexRows] = await Promise.all([
        fetchTwseDaily(stockNo),
        fetchTpexDaily(stockNo)
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
      stockName = await getStockNameByCode(stockNo);
    }

    const displayName = `${stockNo}${stockName ? " " + stockName : ""}`;

    if (rows.length < 60) {
      return res.status(200).json({
        ok: false,
        stockNo,
        stockName,
        displayName,
        market,
        message: `${displayName} 日K資料不足，可能是股號錯誤、非上市櫃，或資料來源暫時無法取得。`
      });
    }

    rows = addMA20(rows);

    const crosses = findCrosses(rows);

    if (crosses.length < 2) {
      return res.status(200).json({
        ok: false,
        stockNo,
        stockName,
        displayName,
        market,
        message: `${displayName} 找不到足夠的穿惡訊號，至少需要最近一次穿惡與前方一段有效穿惡。`
      });
    }

    const latestCross = crosses[crosses.length - 1];

    let validWave = null;

    for (let i = crosses.length - 2; i >= 0; i--) {
      const wave = buildWave(rows, crosses[i]);
      if (!wave) continue;

      if (wave.gainPercent > 30) {
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
        message: `${displayName} 不符合穿山惡龍條件：最近一次穿惡之前，找不到漲幅大於30%的有效前波。`
      });
    }

    const low1 = validWave.low1;
    const high1 = validWave.high1;
    const low2 = latestCross.low;

    const gainPercent = ((high1 - low1) / low1) * 100;
    const factor = ((gainPercent + 100) / 100 * 0.5) + 1;
    const target = low2 * factor;

    const result = {
      ok: true,
      stockNo,
      stockName,
      displayName,
      market,
      crossDate1: validWave.crossDate,
      low1: round2(low1),
      high1: round2(high1),
      gainPercent: round2(gainPercent),
      breakDate1: validWave.breakDate,
      crossDate2: latestCross.date,
      low2: round2(low2),
      target: round2(target),
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

/* ===== 股號 / 股名解析 ===== */

const STOCK_ALIAS = {
  "台積電": "2330",
  "鴻海": "2317",
  "聯發科": "2454",
  "聯電": "2303",
  "廣達": "2382",
  "緯創": "3231",
  "群創": "3481",
  "友達": "2409",
  "聯鈞": "3450",
  "科嶠": "4542",
  "國精化": "4722",
  "前鼎": "4908",
  "台半": "5425",
  "環球晶": "6488",
  "波若威": "3163"
};

async function resolveStock(input) {
  const text = normalizeText(input);

  if (/^\d{4,6}$/.test(text)) {
    return {
      stockNo: text,
      stockName: getAliasNameByCode(text),
      market: ""
    };
  }

  if (STOCK_ALIAS[text]) {
    const code = STOCK_ALIAS[text];
    return {
      stockNo: code,
      stockName: text,
      market: ""
    };
  }

  const list = await getStockList();

  let found = list.find(s => normalizeText(s.name) === text);

  if (!found) {
    found = list.find(s => normalizeText(s.name).includes(text));
  }

  if (!found) {
    return {
      stockNo: "",
      stockName: "",
      market: ""
    };
  }

  return {
    stockNo: found.code,
    stockName: found.name,
    market: found.market
  };
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

  if (
    STOCK_LIST_CACHE.list &&
    now - STOCK_LIST_CACHE.time < STOCK_LIST_CACHE_TIME
  ) {
    return STOCK_LIST_CACHE.list;
  }

  const list = [];

  await Promise.all([
    fetchTwseStockList(list),
    fetchTpexStockList(list)
  ]);

  for (const [name, code] of Object.entries(STOCK_ALIAS)) {
    if (!list.some(s => s.code === code)) {
      list.push({
        code,
        name,
        market: ""
      });
    }
  }

  STOCK_LIST_CACHE.list = uniqueStockList(list);
  STOCK_LIST_CACHE.time = now;

  return STOCK_LIST_CACHE.list;
}

async function fetchTwseStockList(list) {
  try {
    const url = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";

    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const json = await r.json();

    if (!Array.isArray(json)) return;

    for (const item of json) {
      const code = String(item.Code || item["證券代號"] || "").trim();
      const name = String(item.Name || item["證券名稱"] || "").trim();

      if (/^\d{4,6}$/.test(code) && name) {
        list.push({
          code,
          name,
          market: "twse"
        });
      }
    }
  } catch (_) {}
}

async function fetchTpexStockList(list) {
  try {
    const url = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";

    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const json = await r.json();

    if (!Array.isArray(json)) return;

    for (const item of json) {
      const code = String(
        item.Code ||
        item.SecuritiesCompanyCode ||
        item["SecuritiesCompanyCode"] ||
        item["代號"] ||
        item["證券代號"] ||
        ""
      ).trim();

      const name = String(
        item.Name ||
        item.CompanyName ||
        item.SecuritiesCompanyName ||
        item["SecuritiesCompanyName"] ||
        item["名稱"] ||
        item["證券名稱"] ||
        ""
      ).trim();

      if (/^\d{4,6}$/.test(code) && name) {
        list.push({
          code,
          name,
          market: "tpex"
        });
      }
    }
  } catch (_) {}
}

function uniqueStockList(list) {
  const map = new Map();

  for (const item of list) {
    if (!map.has(item.code)) {
      map.set(item.code, item);
    }
  }

  return Array.from(map.values());
}

function normalizeText(str) {
  return String(str || "")
    .replace(/\s/g, "")
    .replace("臺", "台")
    .trim();
}

/* ===== 日K資料：平行抓月份 ===== */

async function fetchTwseDaily(stockNo) {
  const months = getRecentMonths(12);

  const results = await Promise.all(
    months.map(async ym => {
      const url =
        `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ym}01&stockNo=${stockNo}`;

      try {
        const r = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" }
        });

        const json = await r.json();

        if (!json || !Array.isArray(json.data)) return [];

        return json.data.map(item => {
          const date = rocToDate(item[0]);
          const open = toNumber(item[3]);
          const high = toNumber(item[4]);
          const low = toNumber(item[5]);
          const close = toNumber(item[6]);

          if (date && open && high && low && close) {
            return { date, open, high, low, close };
          }

          return null;
        }).filter(Boolean);

      } catch (_) {
        return [];
      }
    })
  );

  return uniqueSort(results.flat());
}

async function fetchTpexDaily(stockNo) {
  const months = getRecentMonths(12);

  const results = await Promise.all(
    months.map(async ym => {
      const year = ym.slice(0, 4);
      const month = ym.slice(4, 6);

      const url =
        `https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${stockNo}&date=${year}/${month}/01&response=json`;

      try {
        const r = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0" }
        });

        const json = await r.json();

        const data = Array.isArray(json.data)
          ? json.data
          : Array.isArray(json.tables?.[0]?.data)
            ? json.tables[0].data
            : [];

        return data.map(item => {
          const date = rocToDate(item[0]);
          const open = toNumber(item[3]);
          const high = toNumber(item[4]);
          const low = toNumber(item[5]);
          const close = toNumber(item[6]);

          if (date && open && high && low && close) {
            return { date, open, high, low, close };
          }

          return null;
        }).filter(Boolean);

      } catch (_) {
        return [];
      }
    })
  );

  return uniqueSort(results.flat());
}

/* ===== 穿山惡龍邏輯 ===== */

function addMA20(rows) {
  return rows.map((row, i) => {
    if (i < 19) return { ...row, ma20: null };

    const slice = rows.slice(i - 19, i + 1);
    const sum = slice.reduce((acc, r) => acc + r.close, 0);

    return {
      ...row,
      ma20: sum / 20
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

  for (let i = cross.index; i < rows.length; i++) {
    const r = rows[i];

    if (!r.ma20) continue;

    if (r.high > high1) high1 = r.high;

    if (i > cross.index && r.close < r.ma20) {
      breakDate = r.date;
      break;
    }
  }

  if (!breakDate) return null;

  const low1 = cross.low;
  const gainPercent = ((high1 - low1) / low1) * 100;

  return {
    crossDate: cross.date,
    low1,
    high1,
    gainPercent,
    breakDate
  };
}

/* ===== 工具函式 ===== */

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

  const n = Number(
    String(v)
      .replace(/,/g, "")
      .replace("--", "")
      .replace(/X|除權|除息|息|權/g, "")
      .trim()
  );

  return Number.isFinite(n) ? n : null;
}

function uniqueSort(rows) {
  const map = new Map();

  for (const r of rows) {
    map.set(r.date, r);
  }

  return Array.from(map.values()).sort((a, b) => {
    return new Date(a.date) - new Date(b.date);
  });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
