// backend/routes/branches.js
// Mounted at: /api/branches
//
// Branch model — StarMart multi-location system:
// • "StarMart HQ" (id=1) is the default branch, always exists
// • Each location self-registers via POST /api/branches/self-register
// • Staff configure their branch in Settings; the branch ID is stored in their JWT
// • Shared: products, customers, loyalty points, orders (all branches visible to admin)

const express = require("express");
const { authenticate, requireRole } = require("../middleware/auth");
const router  = express.Router();
router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/branches  — all active branches
// ─────────────────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const branches = await req.prisma.branch.findMany({
      where:   { isActive: true },
      orderBy: [{ isHQ: "desc" }, { createdAt: "asc" }],
      select:  { id: true, name: true, location: true, phone: true, isHQ: true, createdAt: true },
    });
    res.json(branches);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/branches/my  — the calling user's own branch info
// ─────────────────────────────────────────────────────────────────────────────
router.get("/my", async (req, res) => {
  try {
    const { branchId } = req.user;
    if (!branchId) {
      // HQ / admin with no branch = StarMart HQ
      const hq = await req.prisma.branch.findFirst({
        where: { isActive: true },
        orderBy: { id: "asc" },
        select: { id: true, name: true, location: true, phone: true, isHQ: true },
      });
      return res.json(hq || { id: null, name: "StarMart HQ", location: "", phone: "" });
    }
    const branch = await req.prisma.branch.findUnique({
      where:  { id: branchId },
      select: { id: true, name: true, location: true, phone: true },
    });
    if (!branch) return res.status(404).json({ error: "Branch not found" });
    res.json(branch);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/branches/my  — branch updates its own name/location/phone (admin/manager)
// This is how each location self-configures from Settings.
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/my", requireRole(["admin", "manager"]), async (req, res) => {
  try {
    const { branchId } = req.user;
    const { name, location, phone, isHQ } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Branch name is required" });

    let branch;
    if (branchId) {
      branch = await req.prisma.branch.update({
        where: { id: branchId },
        data:  { name: name.trim(), location: location?.trim() || null, phone: phone?.trim() || null },
        select: { id: true, name: true, location: true, phone: true },
      });
    } else {
      // Admin at HQ with no branch — create or update the HQ branch
      const existing = await req.prisma.branch.findFirst({ orderBy: { id: "asc" } });
      if (existing) {
        branch = await req.prisma.branch.update({
          where: { id: existing.id },
          data:  { name: name.trim(), location: location?.trim() || null, phone: phone?.trim() || null },
          select: { id: true, name: true, location: true, phone: true },
        });
      } else {
        branch = await req.prisma.branch.create({
          data:  { name: name.trim(), location: location?.trim() || null, phone: phone?.trim() || null },
          select: { id: true, name: true, location: true, phone: true },
        });
      }
    }
    res.json(branch);
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "A branch with that name already exists" });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/branches  — Admin creates a new branch and optionally assigns it
// ─────────────────────────────────────────────────────────────────────────────
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const { name, location, phone } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Branch name is required" });

    // Same name + same location = likely a duplicate, but same name + different location = fine
    const duplicate = await req.prisma.branch.findFirst({
      where: {
        name:      name.trim(),
        location:  location?.trim() || null,
        isActive:  true,
      },
    });
    if (duplicate) return res.status(409).json({ error: "A branch with this name and location already exists." });

    // Check if a deleted branch with same name+location exists — reactivate it
    const deleted = await req.prisma.branch.findFirst({
      where: { name: name.trim(), location: location?.trim() || null, isActive: false },
    });

    let branch;
    if (deleted) {
      branch = await req.prisma.branch.update({
        where:  { id: deleted.id },
        data:   { isActive: true, phone: phone?.trim() || null },
        select: { id: true, name: true, location: true, phone: true, isHQ: true },
      });
    } else {
      // Auto-set as HQ if no HQ exists yet
      const hqExists = await req.prisma.branch.findFirst({ where: { isHQ: true, isActive: true } });
      branch = await req.prisma.branch.create({
        data:   { name: name.trim(), location: location?.trim() || null, phone: phone?.trim() || null, isHQ: !hqExists },
        select: { id: true, name: true, location: true, phone: true, isHQ: true },
      });
    }
    res.status(201).json(branch);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/branches/:id  — Admin edits any branch
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id", requireRole("admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, location, phone } = req.body;


    // If setting as HQ, clear the existing HQ first
    if (isHQ === true) {
      await req.prisma.branch.updateMany({ where: { isHQ: true }, data: { isHQ: false } });
    }

    const branch = await req.prisma.branch.update({
      where:  { id },
      data:   {
        ...(name     !== undefined && { name:     name.trim() }),
        ...(location !== undefined && { location: location.trim() || null }),
        ...(phone    !== undefined && { phone:    phone.trim() || null }),
        ...(isHQ     !== undefined && { isHQ:     !!isHQ }),
      },
      select: { id: true, name: true, location: true, phone: true, isHQ: true },
    });
    res.json(branch);
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Branch not found" });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/branches/:id  — Admin deactivates a branch
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await req.prisma.branch.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Branch not found" });
    // Mangle name so the same name can be re-used when creating a new branch
    // We use findFirst in POST so this mangle will be found and reactivated correctly
    await req.prisma.branch.update({
      where: { id },
      data:  { isActive: false },
    });
    res.json({ message: "Branch removed" });
  } catch (e) {
    if (e.code === "P2025") return res.status(404).json({ error: "Branch not found" });
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/branches/cross-report  — Revenue per branch (admin/manager)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/cross-report", requireRole(["admin", "manager"]), async (req, res) => {
  try {
    const days  = parseInt(req.query.days) || 30;
    const since = new Date();
    since.setDate(since.getDate() - (days - 1));
    since.setHours(0, 0, 0, 0);

    const branchRows = await req.prisma.$queryRaw`
      SELECT
        b.id              AS "branchId",
        b.name            AS "branchName",
        b.location        AS "branchLocation",
        b.is_hq           AS "isHQ",
        COUNT(o.id)::int  AS "orders",
        COALESCE(SUM(o.total), 0)::float AS "revenue"
      FROM branches b
      LEFT JOIN orders o
        ON o.branch_id = b.id
        AND o.status   = 'completed'
        AND o.created_at >= ${since}
      WHERE b.is_active = true
      GROUP BY b.id, b.name
      ORDER BY revenue DESC
    `;

    const unassigned = await req.prisma.$queryRaw`
      SELECT COUNT(*)::int AS "orders", COALESCE(SUM(total), 0)::float AS "revenue"
      FROM orders
      WHERE status = 'completed' AND branch_id IS NULL AND created_at >= ${since}
    `;

    const allOrders = await req.prisma.$queryRaw`
      SELECT COUNT(*)::int AS "total" FROM orders
      WHERE status = 'completed' AND created_at >= ${since}
    `;

    res.json({
      branches:          branchRows,
      unassignedOrders:  Number(unassigned[0]?.orders  || 0),
      unassignedRevenue: Number(unassigned[0]?.revenue || 0),
      totalOrderCount:   Number(allOrders[0]?.total    || 0),
      hasUnassigned:     Number(unassigned[0]?.orders  || 0) > 0,
    });
  } catch (e) {
    console.error("[cross-report]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Stock transfer routes (unchanged)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/transfer", requireRole(["admin", "manager"]), async (req, res) => {
  try {
    const { fromBranchId, toBranchId, productId, quantity, notes } = req.body;
    if (!fromBranchId || !toBranchId || !productId || !quantity)
      return res.status(400).json({ error: "fromBranchId, toBranchId, productId and quantity are required" });
    if (fromBranchId === toBranchId)
      return res.status(400).json({ error: "Source and destination branch must be different" });

    const fromBP = await req.prisma.branchProduct.findFirst({
      where: { branchId: fromBranchId, productId },
    });
    if (!fromBP || fromBP.stock < quantity)
      return res.status(400).json({ error: `Insufficient stock at source branch (available: ${fromBP?.stock || 0})` });

    const isAdmin   = req.user.role === "admin";
    const transfer  = await req.prisma.stockTransfer.create({
      data: {
        fromBranchId, toBranchId, productId, quantity,
        notes: notes || null,
        status: isAdmin ? "approved" : "pending",
        createdById: req.user.id,
      },
      include: {
        fromBranch: { select: { name: true, location: true } },
        toBranch:   { select: { name: true, location: true } },
        product:    { select: { name: true, emoji: true } },
      },
    });

    if (isAdmin) {
      await req.prisma.$transaction([
        req.prisma.branchProduct.update({
          where: { branchId_productId: { branchId: fromBranchId, productId } },
          data:  { stock: { decrement: quantity } },
        }),
        req.prisma.branchProduct.upsert({
          where:  { branchId_productId: { branchId: toBranchId, productId } },
          update: { stock: { increment: quantity } },
          create: { branchId: toBranchId, productId, stock: quantity },
        }),
      ]);
    }
    res.status(201).json({ ...transfer, status: isAdmin ? "approved" : "pending", message: isAdmin ? "Stock transferred" : "Transfer request sent to Admin for approval" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/transfer/:id/approve", requireRole("admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const transfer = await req.prisma.stockTransfer.findUnique({ where: { id } });
    if (!transfer || transfer.status !== "pending")
      return res.status(400).json({ error: "Transfer not found or not pending" });

    const fromBP = await req.prisma.branchProduct.findFirst({
      where: { branchId: transfer.fromBranchId, productId: transfer.productId },
    });
    if (!fromBP || fromBP.stock < transfer.quantity)
      return res.status(400).json({ error: `Insufficient stock (${fromBP?.stock || 0} available)` });

    await req.prisma.$transaction([
      req.prisma.stockTransfer.update({ where: { id }, data: { status: "approved" } }),
      req.prisma.branchProduct.update({
        where: { branchId_productId: { branchId: transfer.fromBranchId, productId: transfer.productId } },
        data:  { stock: { decrement: transfer.quantity } },
      }),
      req.prisma.branchProduct.upsert({
        where:  { branchId_productId: { branchId: transfer.toBranchId, productId: transfer.productId } },
        update: { stock: { increment: transfer.quantity } },
        create: { branchId: transfer.toBranchId, productId: transfer.productId, stock: transfer.quantity },
      }),
    ]);
    res.json({ message: `Transfer approved — ${transfer.quantity} units moved` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/transfer/:id/reject", requireRole("admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    await req.prisma.stockTransfer.update({ where: { id }, data: { status: "rejected" } });
    res.json({ message: "Transfer rejected" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/transfers", requireRole(["admin", "manager"]), async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;
    const where = {};
    if (status && status !== "all") where.status = status;
    if (req.user.role === "manager" && req.user.branchId) where.fromBranchId = req.user.branchId;
    const transfers = await req.prisma.stockTransfer.findMany({
      where, take: parseInt(limit), orderBy: { createdAt: "desc" },
      include: {
        fromBranch: { select: { name: true, location: true } },
        toBranch:   { select: { name: true, location: true } },
        product:    { select: { name: true, emoji: true } },
        createdBy:  { select: { name: true } },
      },
    });
    res.json(transfers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/pending-transfers", requireRole(["admin", "manager"]), async (req, res) => {
  try {
    const where = { status: "pending" };
    if (req.user.role === "manager" && req.user.branchId) where.fromBranchId = req.user.branchId;
    const transfers = await req.prisma.stockTransfer.findMany({
      where, orderBy: { createdAt: "desc" },
      include: {
        fromBranch: { select: { name: true, location: true } },
        toBranch:   { select: { name: true, location: true } },
        product:    { select: { name: true, emoji: true } },
        createdBy:  { select: { name: true } },
      },
    });
    res.json(transfers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put("/:branchId/stock/:productId", requireRole("admin"), async (req, res) => {
  try {
    const branchId = parseInt(req.params.branchId);
    const productId = parseInt(req.params.productId);
    const { stock } = req.body;
    const bp = await req.prisma.branchProduct.upsert({
      where:  { branchId_productId: { branchId, productId } },
      update: { stock: parseInt(stock) },
      create: { branchId, productId, stock: parseInt(stock) },
    });
    res.json(bp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/assign-unassigned", requireRole("admin"), async (req, res) => {
  try {
    const { branchId } = req.body;
    if (!branchId) return res.status(400).json({ error: "branchId required" });
    const result = await req.prisma.order.updateMany({
      where: { branchId: null },
      data:  { branchId: parseInt(branchId) },
    });
    res.json({ message: `${result.count} orders assigned to branch`, count: result.count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/reassign-orders", requireRole("admin"), async (req, res) => {
  try {
    const { orderIds, branchId } = req.body;
    if (!orderIds?.length || !branchId) return res.status(400).json({ error: "orderIds and branchId required" });
    const result = await req.prisma.order.updateMany({
      where: { id: { in: orderIds } },
      data:  { branchId: parseInt(branchId) },
    });
    res.json({ message: `${result.count} orders reassigned`, count: result.count });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/unassigned-orders", requireRole("admin"), async (req, res) => {
  try {
    const orders = await req.prisma.order.findMany({
      where:   { branchId: null, status: "completed" },
      orderBy: { createdAt: "desc" },
      take:    100,
      select:  { id: true, orderNumber: true, total: true, createdAt: true },
    });
    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
