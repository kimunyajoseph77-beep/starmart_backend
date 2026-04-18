// backend/routes/products.js
const express = require("express");
const { authenticate, requireRole } = require("../middleware/auth");

const router = express.Router();

// - GET /api/products -
// Returns all active products with their category name.
// Images (base64) are included so the frontend can display them.
router.get("/", authenticate, async (req, res) => {
  try {
    // branchId: from JWT (for branch-assigned staff) OR query param (admin viewing a branch)
    const branchId = req.user.branchId ?? (req.query.branchId ? parseInt(req.query.branchId) : null);

    const products = await req.prisma.product.findMany({
      where:   { isActive: true },
      include: {
        category:   { select: { name: true } },
        // Include per-branch stock rows so frontend can show branch-level quantities
        // Always include branchId so the frontend can identify which branch each row belongs to
        branchStock: branchId
          ? { where: { branchId }, select: { branchId: true, stock: true, minStock: true } }
          : { select: { branchId: true, stock: true, minStock: true } },
      },
      orderBy: { name: "asc" },
    });

    res.json(
      products.map((p) => {
        // If user is assigned to a branch, surface that branch's stock
        const bpRow   = branchId ? p.branchStock[0] : null;
        const effStock = bpRow ? bpRow.stock : p.stock;

        return {
          id:           p.id,
          name:         p.name,
          sku:          p.sku,
          barcode:      p.barcode,
          price:        p.price,
          stock:        effStock,          // branch stock if available, else global
          globalStock:  p.stock,           // always include global for admin views
          branchStock:  p.branchStock,     // full array for multi-branch breakdown
          minStock:     bpRow?.minStock ?? p.minStock,
          emoji:        p.emoji,
          image:        p.image,
          isActive:     p.isActive,
          cat:          p.category?.name ?? "General",
          category:     p.category,
          createdAt:    p.createdAt,
        };
      })
    );
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// - POST /api/products -
// Admin only.  Creates a new product.
router.post("/", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const {
      name, barcode, price, stock = 0,
      emoji, image, categoryName,
    } = req.body;
    let { sku } = req.body;

    if (!name || price == null)
      return res.status(400).json({ error: "name and price are required" });

    // - Auto-generate SKU if not provided -
    if (!sku || !sku.trim()) {
      const words = name.trim().toUpperCase().split(/\s+/);
      const prefix = words.length >= 2
        ? words.slice(0, 2).map(w => w.slice(0, 2)).join("")
        : words[0].slice(0, 4);
      // Try up to 10 times to find a unique SKU
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = `${prefix}-${Math.floor(1000 + Math.random() * 9000)}`;
        const taken = await req.prisma.product.findFirst({
          where: { sku: candidate, isActive: true },
        });
        if (!taken) { sku = candidate; break; }
      }
      // Fallback: timestamp-based SKU (guaranteed unique)
      if (!sku) sku = `${prefix}-${Date.now().toString().slice(-6)}`;
    }
    sku = sku.trim();

    // Auto-generate a 13-digit barcode if none provided
    const resolvedBarcode = barcode || `200${Date.now().toString().slice(-10)}`;

    // resolve category (create if missing)
    let category = await req.prisma.category.findUnique({ where: { name: categoryName || "General" } });
    if (!category) {
      category = await req.prisma.category.create({ data: { name: categoryName || "General" } });
    }

    const productData = {
      name,
      sku,
      barcode: resolvedBarcode,
      price:      parseFloat(price),
      stock:      parseInt(stock),
      emoji:      emoji || "",
      image:      image || null,
      isActive:   true,
      categoryId: category.id,
    };

    // - Step 1: Find the best deleted record to reactivate -
    // Search broadly: exact sku, mangled sku (new format __deleted_N_SKU),
    // or mangled barcode. This handles all deletion format variants.
    const existing = await req.prisma.product.findFirst({
      where: {
        isActive: false,
        OR: [
          { sku },
          { sku: { endsWith: `_${sku}` } },
          ...(barcode ? [{ barcode }, { barcode: { endsWith: `_${barcode}` } }] : []),
        ],
      },
      orderBy: { id: "desc" }, // prefer most recently deleted
    });

    // - Step 2: Clear any OTHER inactive records that hold the same sku/barcode -
    // This prevents unique constraint violations from orphaned deleted records
    // (old deletion format that we can't identify by original sku).
    const conflictWhere = {
      isActive: false,
      NOT: existing ? [{ id: existing.id }] : [],
      OR: [
        { sku },
        { barcode: resolvedBarcode },
      ],
    };
    const conflicts = await req.prisma.product.findMany({ where: conflictWhere, select: { id: true } });
    if (conflicts.length > 0) {
      await Promise.all(conflicts.map(c =>
        req.prisma.product.update({
          where: { id: c.id },
          data: {
            sku:     `__purged_${c.id}_${Date.now()}`,
            barcode: `__purged_${c.id}_${Date.now()}_bc`,
          },
        })
      ));
    }

    // - Step 3: Reactivate or create -
    let product;
    if (existing) {
      product = await req.prisma.product.update({
        where: { id: existing.id },
        data:  productData,
        include: { category: { select: { name: true } } },
      });
    } else {
      product = await req.prisma.product.create({
        data:    productData,
        include: { category: { select: { name: true } } },
      });
    }

    res.status(201).json({ ...product, cat: product.category?.name });
  } catch (e) {
    if (e.code === "P2002") {
      // Unique constraint  SKU collision despite check (race condition). Retry with timestamp SKU.
      try {
        const { name, barcode, price, stock=0, emoji, image, categoryName } = req.body;
        const words = (name||"PROD").trim().toUpperCase().split(/\s+/);
        const prefix = words.length>=2 ? words.slice(0,2).map(w=>w.slice(0,2)).join("") : words[0].slice(0,4);
        const fallbackSku = `${prefix}-${Date.now().toString().slice(-6)}`;
        const resolvedBarcode2 = barcode || `200${Date.now().toString().slice(-10)}`;
        let cat2 = await req.prisma.category.findUnique({ where:{ name: categoryName||"General" } });
        if (!cat2) cat2 = await req.prisma.category.create({ data:{ name: categoryName||"General" } });
        const product2 = await req.prisma.product.create({
          data:{ name, sku:fallbackSku, barcode:resolvedBarcode2, price:parseFloat(price), stock:parseInt(stock||0),
            emoji:emoji||"", image:image||null, isActive:true, categoryId:cat2.id },
          include:{ category:{ select:{ name:true } } },
        });
        return res.status(201).json({ ...product2, cat: product2.category?.name });
      } catch(e2) {
        return res.status(500).json({ error: e2.message });
      }
    }
    res.status(500).json({ error: e.message });
  }
});

// - PATCH /api/products/:id -
// Admin: can update everything.
// Manager: can only update price + stock.
router.patch("/:id", authenticate, requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const id      = parseInt(req.params.id);
    const isAdmin = req.user.role === "admin";
    const {
      name, sku, price, stock,
      emoji, image, categoryName, barcode,
      branchId,   // optional  if provided, also update BranchProduct row for this branch
    } = req.body;

    // Build the update data object based on role
    const data = {};

    if (price  != null) data.price  = parseFloat(price);
    if (stock  != null) data.stock  = parseInt(stock);

    // Barcode: only update if explicitly sent; if blank, auto-generate
    if (Object.prototype.hasOwnProperty.call(req.body, "barcode")) {
      data.barcode = barcode || `200${Date.now().toString().slice(-10)}`;
    }

    if (isAdmin) {
      // Admins can update everything
      if (name)          data.name  = name;
      if (sku)           data.sku   = sku;
      if (emoji != null) data.emoji = emoji;

      // image: allow explicit null to clear, allow new base64, allow undefined (no change)
      if (Object.prototype.hasOwnProperty.call(req.body, "image")) {
        data.image = image || null;
      }

      if (categoryName) {
        let cat = await req.prisma.category.findUnique({ where: { name: categoryName } });
        if (!cat) cat = await req.prisma.category.create({ data: { name: categoryName } });
        data.categoryId = cat.id;
      }
    }

    if (Object.keys(data).length === 0)
      return res.status(400).json({ error: "No valid fields to update" });

    const product = await req.prisma.product.update({
      where: { id },
      data,
      include: { category: { select: { name: true } } },
    });

    // If a branchId was provided and stock was updated, keep BranchProduct in sync
    if (branchId && stock != null) {
      const bid = parseInt(branchId);
      await req.prisma.branchProduct.upsert({
        where:  { branchId_productId: { branchId: bid, productId: id } },
        update: { stock: parseInt(stock) },
        create: { branchId: bid, productId: id, stock: parseInt(stock) },
      });
    }

    res.json({ ...product, cat: product.category?.name });
  } catch (e) {
    if (e.code === "P2025")
      return res.status(404).json({ error: "Product not found" });
    res.status(500).json({ error: e.message });
  }
});

// - DELETE /api/products/:id -
// Admin only  soft delete (sets isActive = false, clears SKU/barcode so they can be reused).
router.delete("/:id", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    // Fetch first so we can preserve the original SKU in the mangled value
    const existing = await req.prisma.product.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Product not found" });
    // Mangle SKU as __deleted_${id}_${originalSku} so the original can be recovered
    await req.prisma.product.update({
      where: { id },
      data: {
        isActive: false,
        sku:     `__deleted_${id}_${existing.sku}`,
        barcode: existing.barcode ? `__deleted_${id}_${existing.barcode}` : `__deleted_${id}`,
      },
    });
    res.json({ message: "Product deleted" });
  } catch (e) {
    if (e.code === "P2025")
      return res.status(404).json({ error: "Product not found" });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
