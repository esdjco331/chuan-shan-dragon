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
    let stockName = resolved.stockName || "";

    let rows = await fetchTwseDaily(stockNo);

    if (rows.length < 60) {
      rows = await fetchTpexDaily(stockNo);
    }

    if (!stockName) {
      stockName = await getStockNameByCode(stockNo);
    }

    if (rows.length < 60) {
      return res.status(200).json({
        ok: false,
        stockNo,
        stockName,
        displayName: `${stockNo}${stockName ? " " + stockName : ""}`,
        message: "日K資料不足，可能是股號錯誤、非上市櫃，或資料來源暫時無法取得。"
      });
    }

    rows = addMA20(rows);

    const crosses = findCrosses(rows);

    if (crosses.length < 2) {
      return res.status(200).json({
        ok: false,
        stockNo,
        stockName,
        displayName: `${stockNo}${stockName ? " " + stockName : ""}`,
        message: "找不到足夠的穿惡訊號，至少需要最近一次穿惡與前方一段有效穿惡。"
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
        displayName: `${stockNo}${stockName ? " " + stockName : ""}`,
        message: "不符合穿山惡龍條件：最近一次穿惡之前，找不到漲幅大於30%的有效前波。"
      });
    }

    const low1 = validWave.low1;
    const high1 = validWave.high1;
    const low2 = latestCross.low;

    const gainPercent = ((high1 - low1) / low1) * 100;
    const factor = ((gainPercent + 100) / 100 * 0.5) + 1;
    const target = low2 * factor;

    return res.status(200).json({
      ok: true,
      stockNo,
      stockName,
      displayName: `${stockNo}${stockName ? " " + stockName : ""}`,
      crossDate1: validWave.crossDate,
      low1: round2(low1),
      high1: round2(high1),
      gainPercent: round2(gainPercent),
      breakDate1: validWave.breakDate,
      crossDate2: latestCross.date,
      low2: round2(low2),
      target: round2(target)
    });

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
  "環球晶": "6488"
};

async function resolveStock(input) {
  const text = normalizeText(input);

  if (/^\d{4,6}$/.test(text)) {
    const name = await getStockNameByCode(text);
    return {
      stockNo: text,
      stockName: name || ""
    };
  }

  if (STOCK_ALIAS[text]) {
    const code = STOCK_ALIAS[text];
    const name = await getStockNameByCode(code);
    return {
      stockNo: code,
      stockName: name || text
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
      stockName: ""
    };
  }

  return {
    stockNo: found.code,
    stockName: found.name
  };
}

async function getStockNameByCode(code) {
  const list = await getStockList();
  const found = list.find(s => s.code === code);
  return found ? found.name : "";
}

let STOCK_LIST_CACHE = null;
let STOCK_LIST_CACHE_TIME = 0;

async function getStockList() {
  const now = Date.now();

  if (STOCK_LIST_CACHE && now - STOCK_LIST_CACHE_TIME < 1000 * 60 * 60) {
    return STOCK_LIST_CACHE;
  }

  const list = [];

  try {
    const twseUrl = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
    const r = await fetch(twseUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const json = await r.json();

    if (Array.isArray(json)) {
      for (const item of json) {
        const code = String(item.Code || item["證券代號"] || "").trim();
        const name = String(item.Name || item["證券名稱"] || "").trim();

        if (/^\d{4,6}$/.test(code) && name) {
          list.push({ code, name });
        }
      }
    }
  } catch (_) {}

  try {
    const tpexUrl = "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes";
    const r = await fetch(tpexUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    const json = await r.json();

    if (Array.isArray(json)) {
      for (const item of json) {
        const code = String(
          item.Code ||
          item.SecuritiesCompanyCode ||
          item["代號"] ||
          item["證券代號"] ||
          ""
        ).trim();

        const name = String(
          item.Name ||
          item.CompanyName ||
          item.SecuritiesCompanyName ||
          item["名稱"] ||
          item["證券名稱"] ||
          ""
        ).trim();

        if (/^\d{4,6}$/.test(code) && name) {
          list.push({ code, name });
        }
      }
    }
  } catch (_) {}

  for (const [name, code] of Object.entries(STOCK_ALIAS)) {
    if (!list.some(s => s.code === code)) {
      list.push({ code, name });
    }
  }

  STOCK_LIST_CACHE = uniqueStockList(list);
  STOCK_LIST_CACHE_TIME = now;

  return STOCK_LIST_CACHE;
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

/* ===== 日K資料 ===== */

async function fetchTwseDaily(stockNo) {
  const all = [];
  const months = getRecentMonths(12);

  for (const ym of months) {
    const url =
      `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${ym}01&stockNo=${stockNo}`;

    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const json = await r.json();

      if (!json || !Array.isArray(json.data)) continue;

      for (const item of json.data) {
        const date = rocToDate(item[0]);
        const open = toNumber(item[3]);
        const high = toNumber(item[4]);
        const low = toNumber(item[5]);
        const close = toNumber(item[6]);

        if (date && open && high && low && close) {
          all.push({ date, open, high, low, close });
        }
      }
    } catch (_) {}
  }

  return uniqueSort(all);
}

async function fetchTpexDaily(stockNo) {
  const all = [];
  const months = getRecentRocMonths(12);

  for (const ym of months) {
    const url =
      `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${ym}&stkno=${stockNo}`;

    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const json = await r.json();

      if (!json || !Array.isArray(json.aaData)) continue;

      for (const item of json.aaData) {
        const date = rocToDate(item[0]);
        const open = toNumber(item[3]);
        const high = toNumber(item[4]);
        const low = toNumber(item[5]);
        const close = toNumber(item[6]);

        if (date && open && high && low && close) {
          all.push({ date, open, high, low, close });
        }
      }
    } catch (_) {}
  }

  return uniqueSort(all);
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

function getRecentRocMonths(count) {
  const arr = [];
  const now = new Date();

  for (let i = 0; i < count; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const rocYear = d.getFullYear() - 1911;
    const m = String(d.getMonth() + 1).padStart(2, "0");
    arr.push(`${rocYear}/${m}`);
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

  const n = Number(String(v).replace(/,/g, "").replace("--", "").trim());

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
