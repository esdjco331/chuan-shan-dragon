export default async function handler(req, res) {

  const { stockNo } = req.query;

  if (!stockNo) {
    return res.status(400).json({
      ok: false,
      message: "請輸入股號"
    });
  }

  try {

    return res.status(200).json({
      ok: true,

      crossDate1: "2025-01-10",
      low1: 100,

      high1: 145,

      gainPercent: 45,

      breakDate1: "2025-03-05",

      crossDate2: "2025-05-20",

      low2: 120
    });

  } catch (err) {

    return res.status(500).json({
      ok: false,
      message: err.message
    });

  }

}
