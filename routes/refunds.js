/**
 * routes/refunds.js — Refunds & Returns Management
 *
 * POST /api/refunds              — process a refund (full or partial)
 * GET  /api/refunds              — list refunds (admin/manager)
 * GET  /api/refunds/:id          — single refund detail
 * GET  /api/orders/search        — search orders by number/customer for refund lookup
 */

const express = require("express");
const router  = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");

// ── Search orders (for refund lookup) ────────────────────────────────────────
// GET /api/refunds/orders/search?q=ORD-001
router.get("/orders/search", authenticate, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);

    const orders = await req.prisma.order.findMany({
      where: {
        status: "completed",
        OR: [
          { orderNumber: { contains: q, mode: "insensitive" } },
          { customer: { name: { contains: q, mode: "insensitive" } } },
          { customer: { phone: { contains: q } } },
        ],
      },
      include: {
        customer:   { select: { name: true, phone: true } },
        user:       { select: { name: true } },
        branch:     { select: { name: true } },
        orderItems: {
          include: {
            product: { select: { id: true, name: true, emoji: true, sku: true } },
          },
        },
        refunds:    { select: { id: true, amount: true, status: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    res.json(orders);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get single order for refund ───────────────────────────────────────────────
router.get("/orders/:id", authenticate, async (req, res) => {
  try {
    const order = await req.prisma.order.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        customer:   { select: { name: true, phone: true, email: true } },
        user:       { select: { name: true } },
        branch:     { select: { name: true } },
        orderItems: {
          include: {
            product: { select: { id: true, name: true, emoji: true, sku: true, price: true } },
          },
        },
        refunds: true,
      },
    });
    if (!order) return res.status(404).json({ error: "Order not found." });
    res.json(order);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Process refund ────────────────────────────────────────────────────────────
// POST /api/refunds
// Body: { orderId, items: [{orderItemId, productId, quantity, unitPrice}], reason, refundMethod, refundAmount, notes }
router.post("/", authenticate, requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const {
      orderId,
      items,          // array of { orderItemId, productId, quantity, unitPrice, restoreStock }
      reason,
      refundMethod,   // "cash" | "mobile" | "store_credit"
      refundAmount,   // override amount (optional — defaults to sum of items)
      notes,
    } = req.body;

    // Reasons where item is NOT resellable — stock should never be restored
    const NON_RESELLABLE_REASONS = [
      "Defective / damaged product",
      "Product expired",
    ];
    const defaultRestoreStock = !NON_RESELLABLE_REASONS.includes(reason);

    if (!orderId)           return res.status(400).json({ error: "orderId is required." });
    if (!items?.length)     return res.status(400).json({ error: "At least one item required." });
    if (!reason?.trim())    return res.status(400).json({ error: "Reason is required." });
    if (!refundMethod)      return res.status(400).json({ error: "Refund method is required." });

    // Load original order
    const order = await req.prisma.order.findUnique({
      where:   { id: parseInt(orderId) },
      include: { orderItems: true, refunds: true },
    });
    if (!order)             return res.status(404).json({ error: "Order not found." });
    if (order.status === "voided") return res.status(400).json({ error: "Cannot refund a voided order." });

    // Calculate already-refunded amount
    const alreadyRefunded = order.refunds
      .filter(r => r.status === "approved")
      .reduce((s, r) => s + parseFloat(r.amount), 0);

    // Validate each return item against original order
    const validatedItems = [];
    for (const item of items) {
      const original = order.orderItems.find(oi => oi.id === parseInt(item.orderItemId));
      if (!original) return res.status(400).json({ error: `Order item ${item.orderItemId} not found in this order.` });

      // Check how much of this item has already been refunded
      const prevRefundedQty = await req.prisma.refundItem.aggregate({
        where: {
          orderItemId: original.id,
          refund: { status: "approved" },
        },
        _sum: { quantity: true },
      });
      const prevQty = prevRefundedQty._sum.quantity || 0;
      const maxQty  = original.quantity - prevQty;

      if (item.quantity <= 0)        return res.status(400).json({ error: `Quantity for item ${original.id} must be > 0.` });
      if (item.quantity > maxQty)    return res.status(400).json({ error: `Cannot refund ${item.quantity}x — only ${maxQty} remaining for item ${original.id}.` });

      // restoreStock: per-item override → falls back to reason-based default
      const restoreStock = item.restoreStock !== undefined
        ? Boolean(item.restoreStock)
        : defaultRestoreStock;

      validatedItems.push({
        orderItemId:  original.id,
        productId:    original.productId,
        quantity:     item.quantity,
        unitPrice:    parseFloat(original.unitPrice),
        subtotal:     parseFloat(original.unitPrice) * item.quantity,
        restoreStock,
      });
    }

    // Calculate refund amount
    const calculatedAmount = validatedItems.reduce((s, i) => s + i.subtotal, 0);
    const finalAmount = refundAmount
      ? Math.min(parseFloat(refundAmount), calculatedAmount)
      : calculatedAmount;

    // Ensure we don't refund more than the original order total
    if (alreadyRefunded + finalAmount > parseFloat(order.total)) {
      return res.status(400).json({
        error: `Total refunds (KSh ${(alreadyRefunded + finalAmount).toFixed(2)}) would exceed order total (KSh ${parseFloat(order.total).toFixed(2)}).`,
      });
    }

    // Generate refund number
    const refundNumber = `REF-${Date.now().toString().slice(-8)}`;

    // Process everything in a transaction
    const refund = await req.prisma.$transaction(async (tx) => {
      // 1. Create the refund record
      const created = await tx.refund.create({
        data: {
          refundNumber,
          orderId:      order.id,
          processedById: req.user.id,
          branchId:     order.branchId,
          reason:       reason.trim(),
          refundMethod,
          amount:       finalAmount,
          notes:        notes?.trim() || null,
          status:       "approved",
          items: {
            create: validatedItems.map(i => ({
              orderItemId: i.orderItemId,
              productId:   i.productId,
              quantity:    i.quantity,
              unitPrice:   i.unitPrice,
              subtotal:    i.subtotal,
            })),
          },
        },
        include: {
          items:       { include: { product: { select: { name: true, emoji: true } } } },
          order:       { select: { orderNumber: true, total: true, paymentMethod: true } },
          processedBy: { select: { name: true } },
        },
      });

      // 2. Restore stock only for resellable items
      for (const item of validatedItems) {
        if (!item.restoreStock) {
          console.log(`[Refund] Skipping stock restore for product ${item.productId} — item not resellable`);
          continue;
        }

        // Restore global stock
        await tx.product.update({
          where: { id: item.productId },
          data:  { stock: { increment: item.quantity } },
        });

        // Restore branch stock if order had a branch
        if (order.branchId) {
          const bp = await tx.branchProduct.findUnique({
            where: { branchId_productId: { branchId: order.branchId, productId: item.productId } },
          });
          if (bp) {
            await tx.branchProduct.update({
              where: { branchId_productId: { branchId: order.branchId, productId: item.productId } },
              data:  { stock: { increment: item.quantity } },
            });
          }
        }
        console.log(`[Refund] Stock restored: +${item.quantity} for product ${item.productId}`);
      }

      // 3. Check if ALL items are now fully refunded → mark order as "refunded"
      const allItems = await tx.orderItem.findMany({ where: { orderId: order.id } });
      const totalOriginalQty = allItems.reduce((s, i) => s + i.quantity, 0);
      const totalRefundedQty = validatedItems.reduce((s, i) => s + i.quantity, 0)
        + (await tx.refundItem.aggregate({
            where:  { refund: { orderId: order.id, status: "approved", id: { not: created.id } } },
            _sum:   { quantity: true },
          }))._sum.quantity || 0;

      if (totalRefundedQty >= totalOriginalQty) {
        await tx.order.update({
          where: { id: order.id },
          data:  { status: "refunded" },
        });
      }

      // 4. Update customer stats if applicable
      if (order.customerId && finalAmount > 0) {
        await tx.customer.update({
          where: { id: order.customerId },
          data: {
            totalSpent: { decrement: finalAmount },
            points:     { decrement: Math.floor(finalAmount / 100) },
          },
        });
      }

      return created;
    });

    // Build summary of what happened to stock
    const stockSummary = validatedItems.map(i => ({
      productId:    i.productId,
      quantity:     i.quantity,
      restoreStock: i.restoreStock,
    }));
    res.json({ message: `Refund ${refundNumber} processed successfully.`, refund, stockSummary });
  } catch (e) {
    console.error("Refund error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── List refunds ──────────────────────────────────────────────────────────────
router.get("/", authenticate, requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const { days = 30, branchId, status } = req.query;
    const since = new Date();
    since.setDate(since.getDate() - parseInt(days));

    const where = {
      createdAt: { gte: since },
      ...(status   ? { status }                       : {}),
      ...(branchId ? { branchId: parseInt(branchId) } : {}),
      // Managers only see their own branch
      ...(req.user.role === "manager" && req.user.branchId
        ? { branchId: req.user.branchId }
        : {}),
    };

    const refunds = await req.prisma.refund.findMany({
      where,
      include: {
        order:       { select: { orderNumber: true, total: true, paymentMethod: true } },
        processedBy: { select: { name: true } },
        branch:      { select: { name: true } },
        items: {
          include: { product: { select: { name: true, emoji: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json(refunds);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Single refund ─────────────────────────────────────────────────────────────
router.get("/:id", authenticate, async (req, res) => {
  try {
    const refund = await req.prisma.refund.findUnique({
      where:   { id: parseInt(req.params.id) },
      include: {
        order:       { include: { customer: true } },
        processedBy: { select: { name: true } },
        branch:      { select: { name: true } },
        items: {
          include: { product: { select: { name: true, emoji: true, sku: true } } },
        },
      },
    });
    if (!refund) return res.status(404).json({ error: "Refund not found." });
    res.json(refund);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;