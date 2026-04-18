/**
 * routes/security.js  Security: Audit Logs, Fraud Detection, Backup
 *
 * GET  /api/security/audit-logs         paginated audit log (admin)
 * GET  /api/security/fraud-alerts       flagged suspicious transactions (admin)
 * POST /api/security/fraud-alerts/:id/dismiss  dismiss an alert (admin)
 * GET  /api/security/backup             download DB backup as JSON (admin)
 * GET  /api/security/summary            security dashboard stats (admin)
 */

const express = require("express");
const router  = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");

const adminOnly = [authenticate, requireRole("admin")];

// - Audit Logs -
// Human-readable description builder
function describeAction(log) {
  const who  = log.user ? `${log.user.name} (${log.user.role})` : "System";
  const vals = log.newValues || {};
  switch (log.action) {
    case "ORDER_CREATED":
      return `${who} completed a sale  Order ${vals.orderNumber || "#"+log.recordId} for KSh ${vals.total ? Number(vals.total).toLocaleString("en-KE") : ""}`;
    case "LOGIN":
      return `${who} signed in`;
    case "LOGIN_FAILED":
      return `Failed login attempt for ${vals.email || "unknown email"}`;
    case "LOGOUT":
      return `${who} signed out`;
    case "PRODUCT_CREATED":
      return `${who} added product "${vals.name || ""}" (SKU: ${vals.sku || ""})`;
    case "PRODUCT_UPDATED":
      return `${who} edited product ${vals.name ? `"${vals.name}"` : "#"+log.recordId}`;
    case "PRODUCT_DELETED":
      return `${who} deleted product "${vals.name || "#"+log.recordId}"`;
    case "REFUND_PROCESSED":
      return `${who} processed refund ${vals.refundNumber || "#"+log.recordId}  KSh ${vals.amount ? Number(vals.amount).toLocaleString("en-KE") : ""}`;
    case "CUSTOMER_CREATED":
      return `${who} added customer "${vals.name || ""}"`;
    case "CUSTOMER_UPDATED":
      return `${who} updated customer "${vals.name || "#"+log.recordId}"`;
    case "STAFF_CREATED":
      return `${who} created staff account for "${vals.name || ""}" as ${vals.role || ""}`;
    case "STAFF_UPDATED":
      return `${who} updated staff account "${vals.name || "#"+log.recordId}"`;
    case "BRANCH_CREATED":
      return `${who} added branch "${vals.name || ""}"`;
    case "BRANCH_UPDATED":
      return `${who} updated branch "${vals.name || "#"+log.recordId}"`;
    case "BRANCH_DELETED":
      return `${who} removed branch "${vals.name || "#"+log.recordId}"`;
    case "STOCK_TRANSFER_REQUESTED":
      return `${who} requested stock transfer  ${vals.quantity || "?"} units from ${vals.fromBranch || "?"} to ${vals.toBranch || "?"}`;
    case "STOCK_TRANSFER_APPROVED":
      return `${who} approved stock transfer #${log.recordId}`;
    case "STOCK_TRANSFER_REJECTED":
      return `${who} rejected stock transfer #${log.recordId}`;
    case "FRAUD_ALERT_LARGE_ORDER":
      return `System flagged large order  KSh ${vals.total ? Number(vals.total).toLocaleString("en-KE") : ""} by ${who}`;
    case "FRAUD_ALERT_RAPID_ORDERS":
      return `System flagged rapid orders  ${vals.count || "?"} orders in 10 min by ${who}`;
    case "FRAUD_ALERT_DISMISSED":
      return `${who} dismissed fraud alert`;
    case "DATA_BACKUP":
      return `${who} downloaded a data backup`;
    case "POINTS_ADJUSTED":
      return `${who} adjusted loyalty points  ${vals.delta > 0 ? "+" : ""}${vals.delta || 0} pts for customer "${vals.customerName || ""}"`;
    default:
      return `${who}  ${log.action.replace(/_/g," ").toLowerCase()}`;
  }
}

router.get("/audit-logs", ...adminOnly, async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(100, parseInt(req.query.limit) || 50);
    const skip    = (page - 1) * limit;
    const search  = req.query.search  || "";   // free text on action or user name
    const action  = req.query.action  || "";   // specific action filter
    const userId  = req.query.userId  ? parseInt(req.query.userId) : undefined;
    const days    = parseInt(req.query.days) || 90;
    const since   = new Date();
    since.setDate(since.getDate() - days);

    // Build where  search across action text OR user name
    const where = {
      createdAt: { gte: since },
      ...(action ? { action: { contains: action, mode: "insensitive" } } : {}),
      ...(userId ? { userId } : {}),
      ...(search && !action ? {
        OR: [
          { action: { contains: search, mode: "insensitive" } },
          { user: { name: { contains: search, mode: "insensitive" } } },
        ],
      } : {}),
    };

    const [logs, total] = await Promise.all([
      req.prisma.auditLog.findMany({
        where,
        include: {
          user: { select: { id: true, name: true, role: true, email: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      req.prisma.auditLog.count({ where }),
    ]);

    // Enrich each log with human-readable description
    const enriched = logs.map(log => ({
      ...log,
      description: describeAction(log),
    }));

    res.json({ logs: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// - Fraud Alerts -
router.get("/fraud-alerts", ...adminOnly, async (req, res) => {
  try {
    const days  = parseInt(req.query.days) || 7;
    const since = new Date();
    since.setDate(since.getDate() - days);

    // Fetch all dismissed alert record IDs from audit log so we can exclude them
    const dismissed = await req.prisma.auditLog.findMany({
      where: { action: "FRAUD_ALERT_DISMISSED" },
      select: { tableName: true, recordId: true },
    });
    // Build a Set of "alertType_recordId" keys to filter against
    const dismissedSet = new Set(
      dismissed.map(d => `${d.tableName}_${d.recordId}`)
    );
    const isDismissed = (alertType, id) =>
      id != null && dismissedSet.has(`${alertType}_${id}`);

    // Run multiple fraud detection queries in parallel
    const [
      largeOrders,
      rapidOrders,
      highRefunds,
      voidedByUser,
      lateNightOrders, // always empty  removed from fraud detection
    ] = await Promise.all([

      // 1. Unusually large single orders (> KSh 50,000)
      req.prisma.order.findMany({
        where: { total: { gt: 50000 }, status: "completed", createdAt: { gte: since } },
        include: {
          user:     { select: { name: true, role: true } },
          customer: { select: { name: true } },
          branch:   { select: { name: true } },
        },
        orderBy: { total: "desc" },
        take: 20,
      }),

      // 2. Users placing > 10 orders within any 10-minute window
      req.prisma.$queryRaw`
        SELECT
          u.id             AS "userId",
          u.name           AS "userName",
          u.role,
          COUNT(o.id)::int AS "orderCount",
          MIN(o.created_at) AS "firstAt",
          MAX(o.created_at) AS "lastAt",
          COALESCE(SUM(o.total),0)::float AS "totalAmount"
        FROM orders o
        JOIN users u ON u.id = o.user_id
        WHERE o.created_at >= ${since}
          AND o.status = 'completed'
        GROUP BY u.id, u.name, u.role
        HAVING COUNT(o.id) >= 10
        ORDER BY "orderCount" DESC
        LIMIT 10
      `,

      // 3. Users with high refund ratio (refunds > 30% of sales)
      req.prisma.$queryRaw`
        SELECT
          u.id             AS "userId",
          u.name           AS "userName",
          COUNT(DISTINCT o.id)::int   AS "orderCount",
          COUNT(DISTINCT r.id)::int   AS "refundCount",
          COALESCE(SUM(r.amount),0)::float AS "refundTotal"
        FROM users u
        LEFT JOIN orders o  ON o.user_id = u.id AND o.created_at >= ${since}
        LEFT JOIN refunds r ON r.processed_by_id = u.id AND r.created_at >= ${since}
        GROUP BY u.id, u.name
        HAVING COUNT(DISTINCT r.id) > 0
          AND COUNT(DISTINCT o.id) > 0
          AND COUNT(DISTINCT r.id)::float / COUNT(DISTINCT o.id)::float > 0.3
        ORDER BY "refundCount" DESC
        LIMIT 10
      `,

      // 4. Orders voided after payment
      req.prisma.order.findMany({
        where: { status: "voided", createdAt: { gte: since } },
        include: {
          user:   { select: { name: true, role: true } },
          branch: { select: { name: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),

      // Late-night transactions removed  business may operate 24hrs
      Promise.resolve([]),
    ]);

    // Filter out dismissed alerts
    const filteredLargeOrders   = largeOrders.filter(o => !isDismissed("largeOrders",   o.id));
    const filteredRapidUsers    = rapidOrders.filter(u => !isDismissed("rapidUsers",    u.userId));
    const filteredHighRefunds   = highRefunds.filter(u => !isDismissed("highRefundUsers",u.userId));
    const filteredVoided        = voidedByUser.filter(o => !isDismissed("voidedOrders", o.id));

    res.json({
      largeOrders:     filteredLargeOrders,
      rapidUsers:      filteredRapidUsers,
      highRefundUsers: filteredHighRefunds,
      voidedOrders:    filteredVoided,
      lateNightOrders: [],
      generatedAt:     new Date(),
    });
  } catch (e) {
    console.error("[fraud-alerts] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// - Dismiss a fraud alert (write to audit log) -
router.post("/fraud-alerts/dismiss", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const { alertType, recordId, reason } = req.body;

    // Parse recordId safely  may be numeric string, number, or undefined
    const parsedRecordId = recordId != null && !isNaN(parseInt(recordId))
      ? parseInt(recordId)
      : null;

    await req.prisma.auditLog.create({
      data: {
        userId:    req.user.id,
        action:    "FRAUD_ALERT_DISMISSED",
        tableName: alertType || "orders",
        recordId:  parsedRecordId,
        newValues: { reason: reason || "Reviewed and dismissed by admin", alertType },
        ipAddress: req.ip,
      },
    });
    res.json({ message: "Alert dismissed and logged." });
  } catch (e) {
    console.error("[dismiss alert] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// - Security Summary (dashboard stats) -
router.get("/summary", ...adminOnly, async (req, res) => {
  try {
    const since7  = new Date(); since7.setDate(since7.getDate() - 7);
    const since30 = new Date(); since30.setDate(since30.getDate() - 30);

    const [
      totalLogs,
      loginLogs,
      failedLogins,
      refundCount,
      voidedCount,
      largeOrderCount,
      activeUsers,
    ] = await Promise.all([
      req.prisma.auditLog.count({ where: { createdAt: { gte: since30 } } }),
      req.prisma.auditLog.count({ where: { action: "LOGIN", createdAt: { gte: since7 } } }),
      req.prisma.auditLog.count({ where: { action: { contains: "FAIL" }, createdAt: { gte: since7 } } }),
      req.prisma.refund.count({   where: { createdAt: { gte: since7 } } }),
      req.prisma.order.count({    where: { status: "voided", createdAt: { gte: since7 } } }),
      req.prisma.order.count({    where: { total: { gt: 50000 }, createdAt: { gte: since7 } } }),
      req.prisma.user.count({     where: { isActive: true } }),
    ]);

    res.json({
      totalAuditLogs:  totalLogs,
      logins7d:        loginLogs,
      failedLogins7d:  failedLogins,
      refunds7d:       refundCount,
      voided7d:        voidedCount,
      largeOrders7d:   largeOrderCount,
      activeUsers,
      lastChecked:     new Date(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// - Backup -
router.get("/backup", ...adminOnly, async (req, res) => {
  try {
    // Export all critical tables as JSON
    const [products, orders, customers, users, branches, refunds, auditLogs] = await Promise.all([
      req.prisma.product.findMany({ include: { category: true } }),
      req.prisma.order.findMany({
        include: { orderItems: true, customer: true },
        orderBy: { createdAt: "desc" },
        take: 5000,
      }),
      req.prisma.customer.findMany(),
      req.prisma.user.findMany({
        select: { id:true, name:true, email:true, role:true, branchId:true, isActive:true, createdAt:true },
      }),
      req.prisma.branch.findMany(),
      req.prisma.refund.findMany({ include: { items: true } }),
      req.prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 1000 }),
    ]);

    const backup = {
      exportedAt:  new Date().toISOString(),
      exportedBy:  req.user.name,
      version:     "2.0",
      data: { products, orders, customers, users, branches, refunds, auditLogs },
    };

    const filename = `starmart_backup_${new Date().toISOString().split("T")[0]}.json`;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    // Log the backup action
    await req.prisma.auditLog.create({
      data: {
        userId:    req.user.id,
        action:    "DATA_BACKUP",
        tableName: "system",
        newValues: { filename, recordCounts: { products: products.length, orders: orders.length, customers: customers.length } },
        ipAddress: req.ip,
      },
    });

    res.json(backup);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/security/audit — log custom audit events (cart clear, discounts) ─
router.post("/audit", authenticate, async (req, res) => {
  try {
    const { action, details } = req.body;
    if (!action) return res.status(400).json({ error: "Action required" });
    await req.prisma.auditLog.create({
      data: {
        userId:    req.user.id,
        action:    action.toUpperCase().replace(/[^A-Z_]/g, "_").slice(0, 50),
        tableName: "pos",
        newValues: details || {},
        ipAddress: req.ip,
      },
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
