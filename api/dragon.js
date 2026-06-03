export default async function handler(req, res) {
  const stockNo = String(req.query.stockNo || "").trim();

  if (!stockNo) {
    return res.status(400).json({ ok: false, message: "請輸入股號" });
  }

  try {
    let rows = await fetchTwseDaily(stockNo);

    if (rows.length < 60) {
      rows = await fetchTpexDaily(stockNo);
    }

    if (rows.length < 60) {
      return res.status(200).json({
        ok: false,
        message: "日K資料不足，可能是股號錯誤、非上市櫃，或資料來源暫時無法取得。"
      });
    }

    rows = addMA20(rows);

    const crosses = findCrosses(rows);

    if (crosses.length < 2) {
      return res.status(200).json({
        ok: false,
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
