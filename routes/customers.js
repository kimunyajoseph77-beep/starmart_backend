// backend/routes/customers.js
const exC = require("express");
const { authenticate: aC, requireRole: rC } = require("../middleware/auth");
const routerC = exC.Router();
routerC.use(aC, rC(["manager", "admin"]));

// GET / — list all customers with optional search + phone
routerC.get("/", async (req, res) => {
  try {
    const { search } = req.query;
    const where = search ? {
      OR: [
        { name:  { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { phone: { contains: search } },
        { tags:  { contains: search, mode: "insensitive" } },
      ],
    } : {};
    const customers = await req.prisma.customer.findMany({
      where,
      orderBy: [{ totalSpent: "desc" }, { name: "asc" }],
    });
    res.json(customers);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id — full customer profile with order history
routerC.get("/:id", async (req, res) => {
  try {
    const customer = await req.prisma.customer.findUnique({
      where: { id: +req.params.id },
      include: {
        orders: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: {
            orderItems: { include: { product: { select: { name: true, emoji: true, price: true } } } },
            refunds: { select: { amount: true, status: true, refundMethod: true } },
          },
        },
      },
    });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    // Compute extra stats
    const avgOrder  = customer.totalOrders > 0
      ? parseFloat(customer.totalSpent) / customer.totalOrders
      : 0;
    const lastOrder = customer.orders[0]?.createdAt || null;
    const tier      = parseFloat(customer.totalSpent) >= 100000 ? "VIP"
                    : parseFloat(customer.totalSpent) >= 20000  ? "Gold"
                    : parseFloat(customer.totalSpent) >= 5000   ? "Silver"
                    : "Regular";

    res.json({ ...customer, avgOrder, lastOrder, tier });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — create customer
routerC.post("/", async (req, res) => {
  try {
    const { name, email, phone, notes, birthday, tags } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });
    const cleanEmail = email?.trim() || null;
    // Check for duplicate email explicitly — gives a better error message
    if (cleanEmail) {
      const existing = await req.prisma.customer.findUnique({ where: { email: cleanEmail } });
      if (existing) return res.status(409).json({ error: `Email already used by ${existing.name}. Leave email blank if unsure.` });
    }
    const customer = await req.prisma.customer.create({
      data: {
        name:     name.trim(),
        email:    cleanEmail,
        phone:    phone?.trim() || null,
        notes:    notes?.trim() || null,
        birthday: birthday ? new Date(birthday) : null,
        tags:     tags?.trim() || null,
      },
    });
    res.status(201).json(customer);
  } catch (e) {
    if (e.code === "P2002") return res.status(409).json({ error: "Email already registered" });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /:id — edit customer
routerC.patch("/:id", async (req, res) => {
  try {
    const { name, email, phone, notes, birthday, tags, points } = req.body;
    const data = {};
    if (name     !== undefined) data.name     = name.trim();
    if (email    !== undefined) data.email    = email?.trim() || null;
    if (phone    !== undefined) data.phone    = phone?.trim() || null;
    if (notes    !== undefined) data.notes    = notes?.trim() || null;
    if (tags     !== undefined) data.tags     = tags?.trim()  || null;
    if (birthday !== undefined) data.birthday = birthday ? new Date(birthday) : null;
    if (points   !== undefined) data.points   = parseInt(points);
    const customer = await req.prisma.customer.update({ where: { id: +req.params.id }, data });
    res.json(customer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — admin only
routerC.delete("/:id", rC("admin"), async (req, res) => {
  try {
    await req.prisma.customer.delete({ where: { id: +req.params.id } });
    res.json({ message: "Customer deleted" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/points — add or redeem points
routerC.post("/:id/points", async (req, res) => {
  try {
    const { delta, reason } = req.body; // delta: +50 to add, -50 to redeem
    if (delta == null) return res.status(400).json({ error: "delta required" });
    const customer = await req.prisma.customer.findUnique({ where: { id: +req.params.id } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    const newPoints = Math.max(0, customer.points + parseInt(delta));
    const updated   = await req.prisma.customer.update({
      where: { id: +req.params.id },
      data:  { points: newPoints },
    });
    res.json({ ...updated, delta: parseInt(delta), reason });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// One-time cleanup: set email=NULL for customers with empty string email
// GET /api/customers/fix-empty-emails (admin only, run once)
routerC.get("/fix-empty-emails", async (req, res) => {
  try {
    const result = await req.prisma.$executeRaw`
      UPDATE customers SET email = NULL WHERE email = ''
    `;
    res.json({ message: `Fixed ${result} customer(s) with empty email strings.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = routerC;