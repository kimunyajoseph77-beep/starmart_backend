// backend/routes/users.js
// Staff management  Admin only
// Mounted at: /api/users  (see server.js)

const express = require("express");
const { authenticate, requireRole } = require("../middleware/auth");

const router = express.Router();

// ── GET /api/users/pending — list accounts awaiting approval ─────────────────
router.get("/pending", authenticate, requireRole(["admin"]), async (req, res) => {
  try {
    const pending = await req.prisma.user.findMany({
      where: { isActive: false, lastLoginAt: null },
      select: { id: true, name: true, email: true, role: true, phone: true, createdAt: true, branchId: true },
      orderBy: { createdAt: "desc" },
    });
    res.json(pending);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/users/:id/approve — approve a pending account ──────────────────
router.post("/:id/approve", authenticate, requireRole(["admin"]), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const user = await req.prisma.user.findUnique({ where: { id: targetId } });
    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.isActive) return res.status(400).json({ error: "Account is already active." });
    await req.prisma.user.update({ where: { id: targetId }, data: { isActive: true } });
    await req.prisma.auditLog.create({
      data: { userId: req.user.id, action: "USER_APPROVED", tableName: "users", recordId: targetId,
              newValues: { approvedBy: req.user.name }, ipAddress: req.ip },
    });
    res.json({ message: `${user.name}'s account has been approved.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/users/:id/reject — reject & delete a pending account ────────────
router.post("/:id/reject", authenticate, requireRole(["admin"]), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const user = await req.prisma.user.findUnique({ where: { id: targetId } });
    if (!user) return res.status(404).json({ error: "User not found." });
    await req.prisma.user.delete({ where: { id: targetId } });
    res.json({ message: `${user.name}'s registration has been rejected.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/users/:id/delete-otp — send OTP to admin before deleting admin ──
router.post("/:id/delete-otp", authenticate, requireRole(["admin"]), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    const target = await req.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) return res.status(404).json({ error: "User not found." });
    if (target.role !== "admin") return res.status(400).json({ error: "OTP only required for admin accounts." });

    const requester = await req.prisma.user.findUnique({ where: { id: req.user.id } });

    const otp     = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 5 * 60 * 1000);
    await req.prisma.user.update({ where: { id: targetId }, data: { twoFaCode: otp, twoFaExpires: expires } });

    let devOtp = null;
    try {
      const apiKey    = process.env.BREVO_API_KEY;
      const fromEmail = process.env.BREVO_FROM_EMAIL || "jmkimunya95@gmail.com";
      const fromName  = process.env.BREVO_FROM_NAME  || "STARMART POS";
      if (!apiKey) {
        console.log(`[OTP DEV] Admin deletion code for ${requester.email}: ${otp}`);
        devOtp = otp;
      } else {
        await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: { "api-key": apiKey, "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            sender:      { name: fromName, email: fromEmail },
            to:          [{ email: requester.email }],
            subject:     `${otp} — STARMART Admin Deletion Code`,
            htmlContent: `
              <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0B0F19;color:#E5E7EB;border-radius:12px;">
                <div style="text-align:center;margin-bottom:24px;">
                  <div style="display:inline-block;background:linear-gradient(135deg,#f5a623,#c47e0e);color:#000;font-weight:900;font-size:28px;padding:10px 18px;border-radius:10px;">⭐</div>
                  <div style="font-weight:800;font-size:20px;margin-top:10px;color:#F5A623;">STARMART POS</div>
                </div>
                <h2 style="font-size:22px;font-weight:800;color:#fff;margin-bottom:8px;">⚠️ Admin Account Deletion</h2>
                <p style="color:#9CA3AF;margin-bottom:24px;">Hi ${requester.name}, someone is attempting to delete the admin account <strong style="color:#fff;">${target.name}</strong>. Enter this code to confirm.</p>
                <div style="background:#111827;border:2px solid #EF444444;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
                  <div style="font-size:11px;color:#F87171;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:10px;">🗑 Deletion Code — Valid 5 minutes</div>
                  <div style="font-family:'Courier New',monospace;font-size:44px;font-weight:900;color:#F87171;letter-spacing:0.25em;">${otp}</div>
                </div>
                <p style="color:#4B5563;font-size:12px;text-align:center;">If you did not request this, ignore this email. No action will be taken without the code.</p>
              </div>`,
          }),
        });
      }
    } catch (e) { console.error("[OTP] Email failed:", e.message); }

    const maskedEmail = requester.email.replace(/(.{1,3}).*(@.*)/, "$1***$2");
    res.json({ message: `Verification code sent to ${maskedEmail}`, maskedEmail, devOtp });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// All routes below require a valid JWT + admin role
router.use(authenticate, requireRole("admin"));

// -
// GET /api/users
// -
router.get("/", authenticate, requireRole(["admin","manager"]), async (req, res) => {
  try {
    const users = await req.prisma.user.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id:           true,
        name:         true,
        email:        true,
        role:         true,
        isActive:     true,
        twoFaEnabled: true,
        createdAt:    true,
        lastLoginAt:  true,
      },
    });
    res.json(users);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -
// PATCH /api/users/:id/role
// -
router.patch("/:id/role", async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (isNaN(targetId)) return res.status(400).json({ error: "Invalid user ID." });

    const { role } = req.body;
    const VALID = ["cashier", "manager", "admin"];
    if (!VALID.includes(role))
      return res.status(400).json({ error: "Invalid role. Must be cashier, manager or admin." });

    if (targetId === req.user.id)
      return res.status(400).json({ error: "You cannot change your own role." });

    const target = await req.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    if (target.role === "admin" && role !== "admin") {
      const adminCount = await req.prisma.user.count({ where: { role: "admin" } });
      if (adminCount <= 1)
        return res.status(400).json({
          error: "Cannot demote the last Admin. Promote another user to Admin first.",
        });
    }

    const updated = await req.prisma.user.update({
      where: { id: targetId },
      data:  { role },
      select: { id: true, name: true, email: true, role: true },
    });

    res.json({ message: `${updated.name} is now a ${role}`, user: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -
// DELETE /api/users/:id
// Permanently deletes the staff account from the database.
// - Detaches their orders (preserves order history, nulls the user_id FK)
// - Clears audit logs referencing this user (sets user_id = NULL)
// - Hard-deletes the user row
// - Returns wasSelf:true if the caller deleted their own account
// -
router.delete("/:id", authenticate, requireRole(["admin"]), async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (isNaN(targetId)) return res.status(400).json({ error: "Invalid user ID." });

    const target = await req.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    // Admin deleting another admin requires OTP verification
    if (target.role === "admin") {
      const { otp } = req.body;
      if (!otp) return res.status(400).json({ error: "OTP required to delete an admin account.", requiresOtp: true });
      if (!target.twoFaCode || target.twoFaCode !== otp.trim())
        return res.status(401).json({ error: "Incorrect OTP code." });
      if (!target.twoFaExpires || new Date() > target.twoFaExpires)
        return res.status(401).json({ error: "OTP has expired. Request a new one." });
    }

    const isSelf = targetId === req.user.id;

    // 1. Detach orders  keep history, just null the user FK
    await req.prisma.$executeRawUnsafe(
      `UPDATE orders SET user_id = NULL WHERE user_id = $1`,
      targetId
    );

    // 2. Null out audit_logs.user_id so FK constraint doesn't block delete
    await req.prisma.$executeRawUnsafe(
      `UPDATE audit_logs SET user_id = NULL WHERE user_id = $1`,
      targetId
    );

    // 3. Null out stock_transfers created_by / approved_by
    await req.prisma.$executeRawUnsafe(
      `UPDATE stock_transfers SET created_by_id = NULL WHERE created_by_id = $1`,
      targetId
    );
    await req.prisma.$executeRawUnsafe(
      `UPDATE stock_transfers SET approved_by_id = NULL WHERE approved_by_id = $1`,
      targetId
    );

    // 4. Null out refunds processed_by
    await req.prisma.$executeRawUnsafe(
      `UPDATE refunds SET processed_by_id = NULL WHERE processed_by_id = $1`,
      targetId
    );

    // 5. Hard-delete the user row
    await req.prisma.user.delete({ where: { id: targetId } });

    res.json({
      message: `"${target.name}" has been permanently deleted.`,
      wasSelf:  isSelf,
    });
  } catch (e) {
    console.error("Delete user error:", e);
    res.status(500).json({ error: e.message });
  }
});

// -
// PATCH /api/users/:id/activate   toggle isActive on/off
// -
router.patch("/:id/activate", async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (isNaN(targetId)) return res.status(400).json({ error: "Invalid user ID." });
    if (targetId === req.user.id)
      return res.status(400).json({ error: "You cannot deactivate your own account." });

    const target = await req.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    const updated = await req.prisma.user.update({
      where: { id: targetId },
      data:  { isActive: !target.isActive },
      select: { id: true, name: true, isActive: true },
    });

    res.json({
      message: `${updated.name} has been ${updated.isActive ? "activated" : "deactivated"}.`,
      user: updated,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -
// PATCH /api/users/:id/branch   assign or remove a user's branch
// -
router.patch("/:id/branch", async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (isNaN(targetId)) return res.status(400).json({ error: "Invalid user ID." });

    const { branchId } = req.body;

    const target = await req.prisma.user.findUnique({ where: { id: targetId } });
    if (!target) return res.status(404).json({ error: "User not found." });

    // Validate branch exists if provided
    if (branchId) {
      const branch = await req.prisma.branch.findUnique({ where: { id: parseInt(branchId) } });
      if (!branch) return res.status(400).json({ error: "Branch not found." });
    }

    const updated = await req.prisma.user.update({
      where: { id: targetId },
      data:  { branchId: branchId ? parseInt(branchId) : null },
      select: { id: true, name: true, email: true, role: true, branchId: true },
    });

    res.json({ message: `${updated.name} assigned successfully.`, user: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
