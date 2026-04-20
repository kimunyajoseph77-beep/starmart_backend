/**
 * routes/barcode.js
 * GET /api/barcode/:code
 *
 * Queries global product databases server-side to auto-fill product details
 * when scanning a barcode — especially good for electronics (Transcend, Kingston,
 * SanDisk, Samsung, etc.) and consumer goods.
 *
 * ── Sources (queried in parallel, best result wins) ─────────────────────────
 *
 * 1. Go-UPC          500M+ products, BEST for electronics  FREE key: go-upc.com/plans/api/trial
 *    Add to .env:  GO_UPC_KEY=your_key_here
 *
 * 2. UPCItemDB       693M+ barcodes, good general coverage  100 free/day, no key needed
 *    Paid key:     UPCITEMDB_KEY=your_key_here (upcitemdb.com)
 *
 * 3. Open Food Facts unlimited free, excellent for food & beauty products
 *    No key needed.
 *
 * ── Getting your free Go-UPC key (takes 2 minutes) ─────────────────────────
 *   1. Go to https://go-upc.com/plans/api/trial
 *   2. Fill in the form → get key by email
 *   3. Add GO_UPC_KEY=your_key to C:\starmart\backend\.env
 *   4. Redeploy backend → Transcend, Samsung, Kingston all auto-fill instantly
 */

const express = require("express");
const https   = require("https");
const http    = require("http");
const router  = express.Router();
const { authenticate } = require("../middleware/auth");

// ── HTTP helper (uses Node built-in — no extra npm install needed) ────────────
function fetchJSON(url, headers = {}, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const opts = {
      headers: {
        "Accept":     "application/json",
        "User-Agent": "StarMart-POS/2.0",
        ...headers,
      },
    };
    const req = lib.get(url, opts, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

// ── Category normaliser ───────────────────────────────────────────────────────
function normaliseCategory(raw = "") {
  const s = (raw || "").toLowerCase();
  if (s.match(/electron|phone|comput|laptop|tablet|tv|audio|camera|headphone|usb|flash|memory|hard.?drive|ssd|router|printer|transcend|kingston|sandisk|samsung|seagate|western.?digital|wd|toshiba|corsair/))
    return "Electronics";
  if (s.match(/beauty|skin|hair|cosmetic|cologne|perfume|deodorant|lotion|shampoo|soap/))
    return "Beauty";
  if (s.match(/food|drink|beverage|snack|juice|milk|oil|grocery|coffee|tea|water|sauce/))
    return "Food";
  if (s.match(/cloth|shirt|shoe|apparel|fashion|wear|trouser|dress/))
    return "Clothing";
  if (s.match(/sport|gym|fitness|outdoor|football|basketball/))
    return "Sports";
  if (s.match(/home|kitchen|furniture|clean|household/))
    return "Home & Living";
  if (s.match(/medicine|health|pharma|vitamin|supplement/))
    return "Health";
  return "Other";
}

// ── Source 1: Go-UPC (BEST for electronics) ───────────────────────────────────
// Free trial: 150 requests/month — sign up at go-upc.com/plans/api/trial
// Paid: $19.95/month for 5,000 calls — worth it for a shop scanning electronics
async function queryGoUPC(code) {
  const key = process.env.GO_UPC_KEY;
  if (!key) return null; // skip if no key configured

  try {
    const { status, body } = await fetchJSON(
      `https://go-upc.com/api/v1/code/${encodeURIComponent(code)}`,
      { "Authorization": `Bearer ${key}` }
    );
    if (status !== 200 || !body?.product?.name) return null;

    const p = body.product;
    return {
      name:        p.name           || "",
      brand:       p.brand          || "",
      description: p.description    || "",
      category:    normaliseCategory(p.category || p.name || ""),
      image:       p.imageUrl        || null,
      source:      "Go-UPC",
      confidence:  "high",
    };
  } catch { return null; }
}

// ── Source 2: UPCItemDB (693M+ products, 100 free/day) ───────────────────────
async function queryUPCItemDB(code) {
  try {
    const key  = process.env.UPCITEMDB_KEY;
    const url  = key
      ? `https://api.upcitemdb.com/prod/v1/lookup?upc=${encodeURIComponent(code)}&user_key=${key}`
      : `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`;

    const { status, body } = await fetchJSON(url);
    if (status !== 200 || body?.code !== "OK" || !body?.items?.length) return null;

    const item  = body.items[0];
    const title = item.title || "";
    if (!title) return null;

    // Pick best image
    const image = (Array.isArray(item.images) ? item.images : [])
      .find(u => u && u.startsWith("http")) || null;

    return {
      name:        title,
      brand:       item.brand       || "",
      description: item.description || "",
      category:    normaliseCategory(item.category || title),
      image,
      source:      "UPCItemDB",
      confidence:  "high",
    };
  } catch { return null; }
}

// ── Source 3: Open Food Facts (unlimited free, food & beauty) ─────────────────
async function queryOpenFoodFacts(code) {
  try {
    const { status, body } = await fetchJSON(
      `https://world.openfoodfacts.org/api/v0/product/${encodeURIComponent(code)}.json`
    );
    if (status !== 200 || body?.status !== 1 || !body?.product) return null;

    const p    = body.product;
    const name = p.product_name || p.product_name_en || "";
    if (!name) return null;

    const image = p.image_front_url || p.image_url || null;

    return {
      name,
      brand:       p.brands || "",
      description: p.ingredients_text_en || "",
      category:    normaliseCategory(p.categories || name),
      image,
      source:      "Open Food Facts",
      confidence:  "high",
    };
  } catch { return null; }
}

// ── Main endpoint ─────────────────────────────────────────────────────────────
// Public route — no auth needed (just a product info lookup)
router.get("/:code", async (req, res) => {
  const code = (req.params.code || "").trim();

  if (!code || code.length < 4) {
    return res.status(400).json({ error: "Invalid barcode" });
  }

  console.log(`[Barcode] Looking up: ${code}`);
  console.log(`[Barcode] GO_UPC_KEY set: ${!!process.env.GO_UPC_KEY}`);
  console.log(`[Barcode] UPCITEMDB_KEY set: ${!!process.env.UPCITEMDB_KEY}`);

  // Run all sources in parallel
  const [goUpc, upcItemDb, offResult] = await Promise.allSettled([
    queryGoUPC(code),
    queryUPCItemDB(code),
    queryOpenFoodFacts(code),
  ]);

  console.log(`[Barcode] Go-UPC result:         ${goUpc.status === "fulfilled" ? (goUpc.value ? goUpc.value.name : "null") : "error: " + goUpc.reason}`);
  console.log(`[Barcode] UPCItemDB result:      ${upcItemDb.status === "fulfilled" ? (upcItemDb.value ? upcItemDb.value.name : "null") : "error: " + upcItemDb.reason}`);
  console.log(`[Barcode] Open Food Facts result: ${offResult.status === "fulfilled" ? (offResult.value ? offResult.value.name : "null") : "error: " + offResult.reason}`);

  const result =
    (goUpc.status     === "fulfilled" && goUpc.value)     ||
    (upcItemDb.status === "fulfilled" && upcItemDb.value) ||
    (offResult.status === "fulfilled" && offResult.value) ||
    null;

  if (!result) {
    return res.json({
      found:   false,
      barcode: code,
      message: "Product not found in any global database",
      tip:     !process.env.GO_UPC_KEY
        ? "GO_UPC_KEY not set in environment — add it for electronics coverage"
        : "Barcode not in any database — try entering details manually",
    });
  }

  console.log(`[Barcode] Found: "${result.name}" via ${result.source}`);

  res.json({
    found:       true,
    barcode:     code,
    name:        result.name.trim(),
    brand:       (result.brand || "").trim(),
    description: result.description || "",
    category:    result.category    || "Other",
    image:       result.image       || null,
    source:      result.source,
    confidence:  result.confidence  || "high",
  });
});

module.exports = router;