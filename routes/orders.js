// backend/routes/orders.js
// Orders are tagged to the user's branch (from JWT branchId).
// Stock is deducted from BranchProduct for that branch.
// Falls back to global Product.stock when no BranchProduct row exists.

const express = require("express");
const { authenticate, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate);

// Helper — get branch-level stock row for a product
async function getBranchStock(tx, productId, branchId) {
  if (!branchId) return { branchStock: null, effectiveStock: null };
  const bp = await tx.branchProduct.findUnique({
    where: { branchId_productId: { branchId, productId } },
  });
  return { branchStock: bp, effectiveStock: bp ? bp.stock : null };
}

// POST /api/orders
// ── Sanitize text: strip HTML tags and dangerous characters ─────────────────
function sanitizeText(str, maxLen = 500) {
  if (!str || typeof str !== "string") return null;
  return str
    .replace(/<[^>]*>/g, "")           // strip HTML tags
    .replace(/[<>"'`]/g, "")          // strip XSS chars
    .replace(/javascript:/gi, "")      // strip JS protocol
    .trim()
    .slice(0, maxLen) || null;
}

router.post("/", async (req, res) => {
  const {
    items, customerId, paymentMethod, cashTendered,
    discountAmount, pointsRedeemed: rawPointsRedeemed,
    branchId: bodyBranchId, delivery: rawDelivery,
    couponCode: rawCouponCode,
  } = req.body;

  // Sanitize all free-text fields from the request body
  const safeDelivery = rawDelivery ? {
    isDelivery:   !!rawDelivery.isDelivery,
    name:         sanitizeText(rawDelivery.name,    100),
    phone:        sanitizeText(rawDelivery.phone,    20),
    altPhone:     sanitizeText(rawDelivery.altPhone, 20),
    address:      sanitizeText(rawDelivery.address,  200),
    area:         sanitizeText(rawDelivery.area,     100),
    landmark:     sanitizeText(rawDelivery.landmark, 200),
    town:         sanitizeText(rawDelivery.town,     100),
    notes:        sanitizeText(rawDelivery.notes,    500),
    deliveryTime: sanitizeText(rawDelivery.deliveryTime, 100),
    fee:          Math.max(0, parseFloat(rawDelivery.fee) || 0),
  } : null;
  const pointsRedeemed = Math.max(0, parseInt(rawPointsRedeemed) || 0);
  if (!items || !items.length) return res.status(400).json({ error: "Order must have at least one item" });
  if (!paymentMethod)          return res.status(400).json({ error: "paymentMethod required" });
  const validMethods = ["cash", "card", "mobile"];
  const method = paymentMethod.toLowerCase();
  if (!validMethods.includes(method)) return res.status(400).json({ error: `Invalid paymentMethod. Must be: ${validMethods.join(", ")}` });

  // Branch: JWT branchId (for branch-locked staff) OR body branchId (for admins selecting a branch in UI)
  // Note: ?? only falls through when req.user.branchId is null/undefined
  //       so admins (branchId=null in JWT) correctly use the body value
  const branchId = req.user.branchId != null ? req.user.branchId : (bodyBranchId != null ? +bodyBranchId : null);
  console.log(`[Order] user=${req.user.id} role=${req.user.role} jwtBranch=${req.user.branchId} bodyBranch=${bodyBranchId} resolved=${branchId}`);

  try {
    const result = await req.prisma.$transaction(async (tx) => {
      const productIds = items.map((i) => i.productId);
      const products   = await tx.product.findMany({ where: { id: { in: productIds }, isActive: true } });
      if (products.length !== productIds.length) throw new Error("One or more products not found or inactive");
      const productMap = Object.fromEntries(products.map((p) => [p.id, p]));

      // Check stock (branch-level preferred, global fallback)
      for (const item of items) {
        const p = productMap[item.productId];
        const { effectiveStock } = await getBranchStock(tx, item.productId, branchId);
        const available = effectiveStock !== null ? effectiveStock : p.stock;
        if (available < item.quantity)
          throw new Error(`Insufficient stock for '${p.name}' (have ${available}, need ${item.quantity})`);
      }

      const subtotal  = items.reduce((s, i) => s + parseFloat(productMap[i.productId].price) * i.quantity, 0);
      const discount  = Math.min(parseFloat(discountAmount) || 0, subtotal);
      const afterDisc = subtotal - discount;
      const tax       = Math.round((afterDisc - afterDisc / 1.16) * 100) / 100;
      const total     = afterDisc;
      const cash      = parseFloat(cashTendered) || 0;
      if (method === "cash" && cash < total) throw new Error(`Insufficient cash. Total is KSh ${total.toFixed(2)}`);
      const change = method === "cash" ? Math.max(0, cash - total) : 0;

      const orderData = {
        orderNumber:   `ORD-${Date.now()}`,
        subtotal, discountAmt: discount, taxAmt: tax, total,
        paymentMethod: method, status: "completed",
        cashTendered: method === "cash" ? cash : undefined,
        changeAmt:    method === "cash" ? change : undefined,
        orderItems: {
          create: items.map((item) => ({
            product:   { connect: { id: item.productId } },
            quantity:  item.quantity,
            unitPrice: parseFloat(productMap[item.productId].price),
            subtotal:  parseFloat(productMap[item.productId].price) * item.quantity,
          })),
        },
      };
      if (req.user.id) orderData.user     = { connect: { id: req.user.id } };
      if (customerId)  orderData.customer = { connect: { id: +customerId } };
      if (branchId)    orderData.branch   = { connect: { id: branchId } };

      const order = await tx.order.create({
        data: orderData,
        include: { orderItems: { include: { product: true } }, customer: true },
      });

      // Deduct stock — branch first, then global
      for (const item of items) {
        const { branchStock } = await getBranchStock(tx, item.productId, branchId);
        if (branchStock) {
          await tx.branchProduct.update({
            where: { branchId_productId: { branchId, productId: item.productId } },
            data:  { stock: { decrement: item.quantity } },
          });
        }
        await tx.product.update({ where: { id: item.productId }, data: { stock: { decrement: item.quantity } } });
      }

      if (customerId) {
        await tx.customer.update({
          where: { id: +customerId },
          data: {
            totalSpent:  { increment: total },
            totalOrders: { increment: 1 },
          },
        });

        // Explicit points update — done separately to avoid Prisma increment bug with negatives
        if (customerId) {
          const earned   = Math.floor(total / 100);
          const netDelta = earned - pointsRedeemed; // can be negative if more redeemed than earned
          await tx.$executeRaw`
            UPDATE customers
            SET points = GREATEST(0, points + ${netDelta})
            WHERE id = ${parseInt(customerId)}
          `;
        }
      }
      return order;
    });
    // ── Audit log ────────────────────────────────────────────────────────────
    req.prisma.auditLog.create({
      data: {
        userId:    req.user.id,
        action:    "ORDER_CREATED",
        tableName: "orders",
        recordId:  result.id,
        newValues: {
          orderNumber: result.orderNumber,
          total:       parseFloat(result.total),
          items:       result.orderItems.length,
          method:      result.paymentMethod,
          branchId:    result.branchId || null,
        },
        ipAddress: req.ip,
      },
    }).catch(() => {}); // non-blocking — never fail the order

    // ── Fraud detection ───────────────────────────────────────────────────────
    // Check 1: unusually large order
    if (parseFloat(result.total) > 50000) {
      req.prisma.auditLog.create({
        data: {
          userId:    req.user.id,
          action:    "FRAUD_ALERT_LARGE_ORDER",
          tableName: "orders",
          recordId:  result.id,
          newValues: { total: parseFloat(result.total), threshold: 50000, orderNumber: result.orderNumber },
          ipAddress: req.ip,
        },
      }).catch(() => {});
    }

    // Check 2: rapid orders — user placed > 5 orders in the last 10 minutes
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    req.prisma.order.count({
      where: { userId: req.user.id, createdAt: { gte: tenMinAgo }, status: "completed" },
    }).then(recentCount => {
      if (recentCount > 5) {
        req.prisma.auditLog.create({
          data: {
            userId:    req.user.id,
            action:    "FRAUD_ALERT_RAPID_ORDERS",
            tableName: "orders",
            recordId:  result.id,
            newValues: { recentCount, windowMinutes: 10, orderNumber: result.orderNumber },
            ipAddress: req.ip,
          },
        }).catch(() => {});
      }
    }).catch(() => {});

    res.status(201).json(result);
  } catch (e) {
    console.error("Order error:", e.message);
    res.status(e.message.includes("Insufficient") || e.message.includes("not found") ? 400 : 500).json({ error: e.message });
  }
});

// GET /api/orders
router.get("/", async (req, res) => {
  try {
    const { date, limit = 50, offset = 0 } = req.query;
    const where = {};
    if (req.user.role === "cashier") where.userId = req.user.id;
    if (req.user.branchId && req.user.role !== "admin") where.branchId = req.user.branchId;
    if (date) {
      const d = new Date(date);
      where.createdAt = { gte: new Date(new Date(d).setHours(0,0,0,0)), lt: new Date(new Date(d).setHours(23,59,59,999)) };
    }
    const [orders, total] = await Promise.all([
      req.prisma.order.findMany({
        where, orderBy: { createdAt: "desc" }, take: +limit, skip: +offset,
        include: { orderItems: { include: { product: { select: { name: true, emoji: true } } } }, customer: { select: { name: true } }, user: { select: { name: true } }, branch: { select: { name: true, location: true } } },
      }),
      req.prisma.order.count({ where }),
    ]);
    res.json({ orders, total, limit: +limit, offset: +offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders/:id
router.get("/:id", async (req, res) => {
  try {
    const order = await req.prisma.order.findUnique({
      where: { id: +req.params.id },
      include: { orderItems: { include: { product: true } }, customer: true, user: { select: { name: true, role: true } }, branch: { select: { name: true, location: true } } },
    });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (req.user.role === "cashier" && order.userId !== req.user.id) return res.status(403).json({ error: "Access denied" });
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/orders/:id/void — manager+ only
router.patch("/:id/void", requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const order = await req.prisma.order.findUnique({ where: { id: +req.params.id }, include: { orderItems: true } });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.status !== "completed") return res.status(400).json({ error: "Only completed orders can be voided" });
    await req.prisma.$transaction(async (tx) => {
      for (const item of order.orderItems) {
        if (order.branchId) {
          const bp = await tx.branchProduct.findUnique({ where: { branchId_productId: { branchId: order.branchId, productId: item.productId } } });
          if (bp) await tx.branchProduct.update({ where: { branchId_productId: { branchId: order.branchId, productId: item.productId } }, data: { stock: { increment: item.quantity } } });
        }
        await tx.product.update({ where: { id: item.productId }, data: { stock: { increment: item.quantity } } });
      }
      await tx.order.update({ where: { id: order.id }, data: { status: "voided" } });
    });
    res.json({ message: "Order voided and stock restored" });
  } catch (e) {
    console.error("Order error:", e.message);
    // Return 409 Conflict for stock issues so offline sync detects them separately
    if (e.message && e.message.includes("Insufficient stock")) {
      return res.status(409).json({ error: e.message, conflict: "stock" });
    }
    return res.status(500).json({ error: e.message });
  }
});

module.exports = router;
