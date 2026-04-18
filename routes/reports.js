// backend/routes/reports.js
const express = require("express");
const { authenticate, requireRole } = require("../middleware/auth");

const router = express.Router();
router.use(authenticate, requireRole(["manager", "admin"]));

// GET /api/reports/summary — KPI cards
router.get("/summary", async (req, res) => {
  try {
    const today    = new Date(); today.setHours(0,0,0,0);
    const todayEnd = new Date(); todayEnd.setHours(23,59,59,999);
    const weekStart = new Date(today); weekStart.setDate(today.getDate() - 6);

    const [todaySales, weekSales, totalProducts, lowStockCount] = await Promise.all([
      req.prisma.order.aggregate({ where: { createdAt: { gte: today, lte: todayEnd }, status: "completed" }, _sum: { total: true }, _count: true }),
      req.prisma.order.aggregate({ where: { createdAt: { gte: weekStart }, status: "completed" }, _sum: { total: true }, _count: true }),
      req.prisma.product.count({ where: { isActive: true } }),
      req.prisma.$queryRaw`SELECT COUNT(*) as count FROM products WHERE stock <= min_stock AND is_active = TRUE`,
    ]);

    // Prisma returns Decimal objects — convert to plain numbers
    const todayRev = parseFloat(todaySales._sum.total) || 0;
    const weekRev  = parseFloat(weekSales._sum.total)  || 0;
    const weekTxns = weekSales._count || 0;

    res.json({
      today:         { revenue: todayRev, transactions: todaySales._count || 0 },
      week:          { revenue: weekRev,  transactions: weekTxns },
      avgOrderValue: weekTxns > 0 ? (weekRev / weekTxns).toFixed(2) : 0,
      totalProducts,
      lowStockCount: parseInt(lowStockCount[0]?.count || 0),
    });
  } catch (e) { console.error("Summary error:", e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/reports/daily?days=7
router.get("/daily", async (req, res) => {
  try {
    const days = +req.query.days || 7;
    const since = new Date(); since.setDate(since.getDate() - days); since.setHours(0,0,0,0);

    const rows = await req.prisma.$queryRaw`
      SELECT DATE(created_at) AS date,
        COUNT(*)::int AS transactions,
        ROUND(SUM(total)::numeric, 2) AS revenue,
        ROUND(AVG(total)::numeric, 2) AS avg_order
      FROM orders WHERE created_at >= ${since} AND status = 'completed'
      GROUP BY DATE(created_at) ORDER BY date ASC
    `;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reports/top-products?limit=10
router.get("/top-products", async (req, res) => {
  try {
    const limit = +req.query.limit || 10;
    const rows  = await req.prisma.$queryRaw`
      SELECT p.id, p.name, p.emoji, p.sku, c.name AS category,
        SUM(oi.quantity)::int AS total_sold,
        ROUND(SUM(oi.subtotal)::numeric, 2) AS total_revenue,
        ROUND((SUM(oi.subtotal) - SUM(oi.quantity * p.cost_price))::numeric, 2) AS gross_profit
      FROM order_items oi
      JOIN products p ON p.id = oi.product_id
      JOIN orders o   ON o.id = oi.order_id AND o.status = 'completed'
      JOIN categories c ON c.id = p.category_id
      GROUP BY p.id, p.name, p.emoji, p.sku, c.name
      ORDER BY total_revenue DESC LIMIT ${limit}
    `;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reports/category-sales
router.get("/category-sales", async (req, res) => {
  try {
    const rows = await req.prisma.$queryRaw`
      SELECT c.name AS category,
        SUM(oi.subtotal)::numeric AS revenue,
        SUM(oi.quantity)::int AS units_sold
      FROM order_items oi
      JOIN products p   ON p.id = oi.product_id
      JOIN categories c ON c.id = p.category_id
      JOIN orders o     ON o.id = oi.order_id AND o.status = 'completed'
      GROUP BY c.name ORDER BY revenue DESC
    `;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/reports/export  — admin only CSV
// GET /api/reports/monthly?months=6
// Monthly revenue + order count for the last N months
router.get("/monthly", async (req, res) => {
  try {
    const months = Math.min(parseInt(req.query.months) || 6, 24);
    // Build the cutoff date in JS — avoids Prisma parameterisation issues with INTERVAL
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    const rows = await req.prisma.$queryRaw`
      SELECT
        EXTRACT(YEAR  FROM created_at)::int  AS year,
        EXTRACT(MONTH FROM created_at)::int  AS month,
        COUNT(*)::int                         AS transactions,
        COALESCE(SUM(total), 0)::float        AS revenue
      FROM orders
      WHERE status = 'completed'
        AND created_at >= ${since}
      GROUP BY year, month
      ORDER BY year ASC, month ASC
    `;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/export", requireRole("admin"), async (req, res) => {
  try {
    const { from, to } = req.query;
    const where = { status: "completed" };
    if (from) where.createdAt = { ...where.createdAt, gte: new Date(from) };
    if (to)   where.createdAt = { ...where.createdAt, lte: new Date(to)   };

    const orders = await req.prisma.order.findMany({
      where,
      include: { orderItems: { include: { product: { select: { name: true, sku: true } } } }, customer: { select: { name: true } }, user: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });

    const rows = [];
    orders.forEach((o) => {
      o.orderItems.forEach((item) => {
        rows.push([o.orderNumber, o.createdAt.toISOString(), o.user.name, o.customer?.name || "Walk-in",
          item.product.sku, item.product.name, item.quantity, item.unitPrice, item.subtotal,
          o.discount, o.tax, o.total, o.paymentMethod].join(","));
      });
    });

    const header = "Order#,Date,Staff,Customer,SKU,Product,Qty,UnitPrice,Subtotal,Discount,Tax,Total,Payment";
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=starmart_export_${Date.now()}.csv`);
    res.send([header, ...rows].join("\n"));
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── Staff Performance ─────────────────────────────────────────────────────────
// GET /api/reports/staff-performance?period=daily|weekly|monthly&branchId=N
router.get("/staff-performance", requireRole(["admin","manager"]), async (req, res) => {
  try {
    const period   = req.query.period || "daily";   // daily | weekly | monthly
    const branchId = req.query.branchId ? parseInt(req.query.branchId) : null;

    // Build date windows
    const now   = new Date();
    const today = new Date(now); today.setHours(0,0,0,0);

    let since;
    if (period === "daily") {
      since = today;
    } else if (period === "weekly") {
      since = new Date(today);
      since.setDate(since.getDate() - 6);
    } else { // monthly
      since = new Date(today);
      since.setDate(since.getDate() - 29);
    }

    const branchFilter = branchId ? { branchId } : {};

    // Fetch all completed orders in window, grouped by user
    const orders = await req.prisma.order.findMany({
      where: {
        status:    "completed",
        createdAt: { gte: since },
        user:      { isNot: null },
        ...branchFilter,
      },
      select: {
        id: true, total: true, createdAt: true,
        user: { select: { id: true, name: true, role: true, email: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Group by user
    const staffMap = {};
    for (const o of orders) {
      if (!o.user) continue;
      const uid = o.user.id;
      if (!staffMap[uid]) {
        staffMap[uid] = {
          id:         uid,
          name:       o.user.name,
          role:       o.user.role,
          email:      o.user.email,
          orders:     0,
          revenue:    0,
          avgOrder:   0,
          // For sparkline — last 7 or 30 days as daily buckets
          daily:      {},
        };
      }
      staffMap[uid].orders++;
      staffMap[uid].revenue += Number(o.total);

      // bucket by LOCAL date (toISOString is UTC — use local year/month/day instead)
      const d = o.createdAt;
      const dateKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
      staffMap[uid].daily[dateKey] = (staffMap[uid].daily[dateKey] || 0) + Number(o.total);
    }

    // Compute avgOrder and convert daily to sorted array
    const staff = Object.values(staffMap).map(s => {
      s.avgOrder = s.orders > 0 ? s.revenue / s.orders : 0;
      // Build timeline
      const buckets = {};
      const days = period === "monthly" ? 30 : period === "weekly" ? 7 : 1;
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        // Use local date parts — NOT toISOString (which is UTC and can be off by a day)
        const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
        buckets[k] = s.daily[k] || 0;
      }
      s.timeline = Object.entries(buckets).map(([day, sales]) => ({ day: day.slice(5), sales }));
      delete s.daily;
      return s;
    });

    // Sort by revenue desc
    staff.sort((a, b) => b.revenue - a.revenue);

    // Overall totals for context
    const totals = {
      orders:  orders.length,
      revenue: orders.reduce((s, o) => s + Number(o.total), 0),
      staff:   staff.length,
    };

    res.json({ staff, totals, period, since: since.toISOString() });
  } catch (e) {
    console.error("[staff-performance]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;


