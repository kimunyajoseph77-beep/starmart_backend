/**
 * routes/credit.js  —  Credit Sales & Debt Management
 *
 * GET    /api/credit                         list all credit accounts  (manager+)
 * GET    /api/credit/summary                 dashboard totals (manager+)
 * GET    /api/credit/customer/:customerId    get/auto-create account for a customer
 * POST   /api/credit/customer/:customerId    update account notes (manager+)
 * POST   /api/credit/:accountId/payment      record a repayment (manager+)
 * POST   /api/credit/:accountId/adjust       manual balance adjustment (admin)
 * POST   /api/credit/:accountId/writeoff     write off bad debt (admin)
 * GET    /api/credit/:accountId/ledger       full transaction history
 *
 * NOTE: No credit limit is enforced. Royal customers can owe any amount.
 *       creditLimit is stored as 99999999 internally (effectively unlimited).
 */

const express = require("express");
const router  = express.Router();
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate);

// ── Helper: ensure a credit account exists for a customer ─────────────────────
async function ensureAccount(prisma, customerId) {
  const cid = parseInt(customerId);
  let account = await prisma.creditAccount.findUnique({ where: { customerId: cid } });
  if (!account) {
    account = await prisma.creditAccount.create({
      data: { customerId: cid, creditLimit: 99999999, balance: 0, status: "open" },
    });
  }
  return account;
}

// ── GET /api/credit  — list all accounts ──────────────────────────────────────
router.get("/", requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const { status, search } = req.query;

    const where = {};
    if (status) where.status = status;
    if (search) {
      where.customer = {
        OR: [
          { name:  { contains: search, mode: "insensitive" } },
          { phone: { contains: search } },
        ],
      };
    }

    const accounts = await req.prisma.creditAccount.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, phone: true, email: true } },
        transactions: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { createdAt: true, type: true, amount: true },
        },
      },
      orderBy: { balance: "desc" },
    });

    res.json(accounts);
  } catch (e) {
    console.error("[credit GET /]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/credit/summary — KPI dashboard totals ────────────────────────────
// MUST be defined before /:accountId routes so Express doesn't treat
// "summary" as an accountId param.
router.get("/summary", requireRole(["manager", "admin"]), async (req, res) => {
  try {
    // Fetch all accounts that have any balance > 0
    const debtorAccounts = await req.prisma.creditAccount.findMany({
      where:  { balance: { gt: 0 } },
      select: { id: true, balance: true, status: true },
    });

    const totalDebtors     = debtorAccounts.length;
    const totalOutstanding = debtorAccounts.reduce(
      (sum, a) => sum + parseFloat(a.balance || 0), 0
    );
    const atRiskAccounts = debtorAccounts.filter(a => a.status !== "paid").length;

    // Overdue: has a debit older than 30 days and still has a balance
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const overdueResult = await req.prisma.$queryRaw`
      SELECT COUNT(DISTINCT ca.id)::int AS cnt
      FROM   credit_accounts ca
      JOIN   credit_transactions ct ON ct.account_id = ca.id
      WHERE  ca.balance > 0
        AND  ct.type = 'debit'
        AND  ct.created_at < ${thirtyDaysAgo}
    `;

    res.json({
      totalDebtors,
      totalOutstanding:  Math.round(totalOutstanding * 100) / 100,
      atRiskAccounts,
      overdueAccounts:   parseInt(overdueResult[0]?.cnt ?? 0),
    });
  } catch (e) {
    console.error("[credit GET /summary]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/credit/customer/:customerId ──────────────────────────────────────
router.get("/customer/:customerId", async (req, res) => {
  try {
    const cid      = parseInt(req.params.customerId);
    const customer = await req.prisma.customer.findUnique({ where: { id: cid } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const account = await ensureAccount(req.prisma, cid);
    res.json({ ...account, customer });
  } catch (e) {
    console.error("[credit GET /customer/:id]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/credit/customer/:customerId — update notes ──────────────────────
router.post("/customer/:customerId", requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const cid      = parseInt(req.params.customerId);
    const { notes } = req.body;

    const customer = await req.prisma.customer.findUnique({ where: { id: cid } });
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const account = await req.prisma.creditAccount.upsert({
      where:  { customerId: cid },
      update: { ...(notes != null && { notes: notes.trim() }) },
      create: { customerId: cid, creditLimit: 99999999, balance: 0, notes: notes?.trim() || null },
    });

    res.json(account);
  } catch (e) {
    console.error("[credit POST /customer/:id]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/credit/:accountId/payment — record a repayment ──────────────────
router.post("/:accountId/payment", requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId);
    const { amount, note, paymentMethod } = req.body;

    if (!amount || parseFloat(amount) <= 0)
      return res.status(400).json({ error: "Payment amount must be greater than 0" });

    const result = await req.prisma.$transaction(async (tx) => {
      const account = await tx.creditAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new Error("Credit account not found");

      const pay       = parseFloat(amount);
      const newBal    = Math.max(0, parseFloat(account.balance) - pay);
      const newStatus = newBal === 0 ? "paid" : "partial";

      await tx.creditAccount.update({
        where: { id: accountId },
        data:  { balance: newBal, status: newStatus },
      });

      const txn = await tx.creditTransaction.create({
        data: {
          accountId,
          userId:       req.user.id,
          type:         "payment",
          amount:       pay,
          balanceAfter: newBal,
          note: note?.trim() || (paymentMethod ? `Payment via ${paymentMethod}` : "Manual payment"),
        },
      });

      const customer = await tx.customer.findUnique({
        where: { id: account.customerId }, select: { name: true },
      });

      await tx.auditLog.create({
        data: {
          userId:    req.user.id,
          action:    "CREDIT_PAYMENT",
          tableName: "credit_accounts",
          recordId:  accountId,
          newValues: { amount: pay, newBalance: newBal, status: newStatus, customerName: customer?.name },
          ipAddress: req.ip,
        },
      });

      return { updated: { ...account, balance: newBal, status: newStatus }, txn };
    });

    res.json({ message: "Payment recorded successfully", ...result });
  } catch (e) {
    console.error("[credit POST /:id/payment]", e.message);
    res.status(e.message.includes("not found") ? 404 : 500).json({ error: e.message });
  }
});

// ── POST /api/credit/:accountId/adjust — manual balance adjustment (admin) ─────
router.post("/:accountId/adjust", requireRole("admin"), async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId);
    const { delta, note } = req.body;
    if (delta == null)
      return res.status(400).json({ error: "delta required (positive = charge, negative = credit)" });

    const result = await req.prisma.$transaction(async (tx) => {
      const account = await tx.creditAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new Error("Credit account not found");

      const newBal    = Math.max(0, parseFloat(account.balance) + parseFloat(delta));
      const newStatus = newBal === 0 ? "paid" : "open";

      await tx.creditAccount.update({
        where: { id: accountId },
        data:  { balance: newBal, status: newStatus },
      });

      const txn = await tx.creditTransaction.create({
        data: {
          accountId,
          userId:       req.user.id,
          type:         "adjustment",
          amount:       Math.abs(parseFloat(delta)),
          balanceAfter: newBal,
          note: note?.trim() || `Manual adjustment (${parseFloat(delta) >= 0 ? "+" : ""}${delta})`,
        },
      });

      await tx.auditLog.create({
        data: {
          userId:    req.user.id,
          action:    "CREDIT_ADJUSTMENT",
          tableName: "credit_accounts",
          recordId:  accountId,
          newValues: { delta: parseFloat(delta), newBalance: newBal },
          ipAddress: req.ip,
        },
      });

      return txn;
    });

    res.json({ message: "Adjustment applied", transaction: result });
  } catch (e) {
    console.error("[credit POST /:id/adjust]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/credit/:accountId/writeoff — write off bad debt (admin) ──────────
router.post("/:accountId/writeoff", requireRole("admin"), async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId);
    const { note }  = req.body;

    const result = await req.prisma.$transaction(async (tx) => {
      const account = await tx.creditAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new Error("Credit account not found");
      if (parseFloat(account.balance) === 0)
        throw new Error("Balance is already zero — nothing to write off");

      const oldBalance = parseFloat(account.balance);
      await tx.creditAccount.update({
        where: { id: accountId },
        data:  { balance: 0, status: "written_off" },
      });

      const txn = await tx.creditTransaction.create({
        data: {
          accountId,
          userId:       req.user.id,
          type:         "writeoff",
          amount:       oldBalance,
          balanceAfter: 0,
          note: note?.trim() || "Bad debt written off by admin",
        },
      });

      await tx.auditLog.create({
        data: {
          userId:    req.user.id,
          action:    "CREDIT_WRITEOFF",
          tableName: "credit_accounts",
          recordId:  accountId,
          newValues: { amount: oldBalance },
          ipAddress: req.ip,
        },
      });

      return { txn, amountWrittenOff: oldBalance };
    });

    res.json({ message: `KSh ${result.amountWrittenOff.toFixed(2)} written off`, ...result });
  } catch (e) {
    console.error("[credit POST /:id/writeoff]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/credit/:accountId/ledger — full transaction history ───────────────
router.get("/:accountId/ledger", requireRole(["manager", "admin"]), async (req, res) => {
  try {
    const accountId = parseInt(req.params.accountId);
    const limit     = Math.min(parseInt(req.query.limit) || 50, 200);

    const [account, transactions] = await Promise.all([
      req.prisma.creditAccount.findUnique({
        where:   { id: accountId },
        include: { customer: { select: { id: true, name: true, phone: true, email: true } } },
      }),
      req.prisma.creditTransaction.findMany({
        where:   { accountId },
        orderBy: { createdAt: "desc" },
        take:    limit,
        include: {
          order: { select: { orderNumber: true, total: true } },
          user:  { select: { name: true, role: true } },
        },
      }),
    ]);

    if (!account) return res.status(404).json({ error: "Credit account not found" });
    res.json({ account, transactions });
  } catch (e) {
    console.error("[credit GET /:id/ledger]", e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;