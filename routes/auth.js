// backend/routes/auth.js
// Email (password reset) via Brevo (formerly Sendinblue) — free 300 emails/day
//   Sign up: https://brevo.com → SMTP & API → API Keys → Generate API Key
//   ENV: BREVO_API_KEY=your-brevo-api-key
//        BREVO_FROM_EMAIL=jmkimunya95@gmail.com  (your verified sender email)
//        BREVO_FROM_NAME=STARMART POS            (optional display name)
//
// SMS (2FA login codes) via Africa's Talking
//   ENV: AT_API_KEY=your-key  AT_USERNAME=your-username  AT_SENDER_ID=STARMART (optional)

const express = require("express");
const bcrypt  = require("bcryptjs");
const { authenticate, requireRole, generateToken, generateRefreshToken, verifyRefreshToken, setRefreshCookie, clearRefreshCookie } = require("../middleware/auth");

const router = express.Router();

// ── Brevo email helper ────────────────────────────────────────────────────────
async function sendEmail({ to, subject, html }) {
  const apiKey   = process.env.BREVO_API_KEY;
  const fromEmail = process.env.BREVO_FROM_EMAIL || "jmkimunya95@gmail.com";
  const fromName  = process.env.BREVO_FROM_NAME  || "STARMART POS";

  // Dev mode: no API key — just log to console and show code on screen
  if (!apiKey) {
    console.log("\n[EMAIL DEV MODE — BREVO_API_KEY not set]");
    console.log(`  To: ${to} | Subject: ${subject}`);
    console.log("  Set BREVO_API_KEY in .env to send real emails.\n");
    return { devMode: true };
  }

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method:  "POST",
    headers: {
      "api-key":      apiKey,
      "Content-Type": "application/json",
      "Accept":       "application/json",
    },
    body: JSON.stringify({
      sender:     { name: fromName, email: fromEmail },
      to:         [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Brevo error ${res.status}: ${err.message || JSON.stringify(err)}`);
  }

  const data = await res.json();
  console.log("[EMAIL] Brevo sent, messageId:", data.messageId);
  return data;
}

function resetEmailHtml(name, code) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0B0F19;color:#E5E7EB;border-radius:12px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:linear-gradient(135deg,#f5a623,#c47e0e);color:#000;font-weight:900;font-size:28px;padding:10px 18px;border-radius:10px;letter-spacing:0.05em;">⭐</div>
        <div style="font-weight:800;font-size:20px;margin-top:10px;color:#F5A623;">STARMART POS</div>
      </div>
      <h2 style="font-size:22px;font-weight:800;margin-bottom:8px;color:#fff;">Password Reset Request</h2>
      <p style="color:#9CA3AF;margin-bottom:24px;">Hi ${name}, use the code below to reset your password. It expires in <strong style="color:#fff;">15 minutes</strong>.</p>
      <div style="background:#111827;border:2px solid #F59E0B44;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
        <div style="font-size:11px;color:#F59E0B;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:10px;"> Your Reset Code</div>
        <div style="font-family:'Courier New',monospace;font-size:44px;font-weight:900;color:#F59E0B;letter-spacing:0.25em;">${code}</div>
        <div style="font-size:11px;color:#4B5563;margin-top:10px;">Valid for 15 minutes  Do not share this code</div>
      </div>
      <p style="color:#4B5563;font-size:12px;text-align:center;">If you did not request a password reset, ignore this email. Your account is safe.</p>
    </div>`;
}


function twoFaEmailHtml(name, code, purpose = "login") {
  const titles = {
    login:  "Login Verification Code",
    setup:  "Enable Two-Factor Authentication",
    resend: "New Login Verification Code",
  };
  const subtitles = {
    login:  "Use the code below to complete your sign-in. Valid for <strong style=\"color:#fff;\">10 minutes</strong>.",
    setup:  "Enter this code to enable 2FA on your account. Valid for <strong style=\"color:#fff;\">10 minutes</strong>.",
    resend: "Here is your new verification code. Valid for <strong style=\"color:#fff;\">10 minutes</strong>.",
  };
  return `
    <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#0B0F19;color:#E5E7EB;border-radius:12px;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;background:linear-gradient(135deg,#f5a623,#c47e0e);color:#000;font-weight:900;font-size:28px;padding:10px 18px;border-radius:10px;letter-spacing:0.05em;">⭐</div>
        <div style="font-weight:800;font-size:20px;margin-top:10px;color:#F5A623;">STARMART POS</div>
      </div>
      <h2 style="font-size:22px;font-weight:800;margin-bottom:8px;color:#fff;">${titles[purpose] || titles.login}</h2>
      <p style="color:#9CA3AF;margin-bottom:24px;">Hi ${name}, ${subtitles[purpose] || subtitles.login}</p>
      <div style="background:#111827;border:2px solid #6366F144;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
        <div style="font-size:11px;color:#818CF8;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;margin-bottom:10px;">🔐 Your Verification Code</div>
        <div style="font-family:'Courier New',monospace;font-size:44px;font-weight:900;color:#818CF8;letter-spacing:0.25em;">${code}</div>
        <div style="font-size:11px;color:#4B5563;margin-top:10px;">Valid for 10 minutes · Do not share this code</div>
      </div>
      <p style="color:#4B5563;font-size:12px;text-align:center;">If you did not request this code, someone may be trying to access your account. Contact your admin immediately.</p>
    </div>`;
}

function makeCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}


// GET /api/auth/setup-status
router.get("/setup-status", async (req, res) => {
  try {
    const adminCount = await req.prisma.user.count({ where: { role: "admin", isActive: true } });
    res.json({ needsSetup: adminCount === 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/setup   first-time admin (locks after first use)
router.post("/setup", async (req, res) => {
  try {
    const adminCount = await req.prisma.user.count({ where: { role: "admin", isActive: true } });
    if (adminCount > 0)
      return res.status(403).json({ error: "Setup already complete. An admin account already exists." });

    const { name, email, password, phone } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "Name, email and password are required" });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters" });

    const existing = await req.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await req.prisma.user.create({
      data: { name: name.trim(), email: email.toLowerCase().trim(), passwordHash, role: "admin", phone: phone?.trim() || null },
    });

    await req.prisma.auditLog.create({
      data: { userId: user.id, action: "INITIAL_SETUP", tableName: "users", recordId: user.id, ipAddress: req.ip },
    });
    const accessToken  = generateToken(user);
    const refreshToken = generateRefreshToken(user);
    setRefreshCookie(res, refreshToken);
    res.status(201).json({ token: accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, branchId: user.branchId ?? null } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/login
// Returns { requires2FA: true, pendingToken, maskedPhone } if 2FA is on,
// or { token, user } if not.
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });

    const user = await req.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user) return res.status(401).json({ error: "Invalid email or password" });
    if (!user.isActive) {
      // Check if it's a pending account (never logged in) vs deactivated
      const neverLoggedIn = !user.lastLoginAt;
      return res.status(403).json({
        error: neverLoggedIn
          ? "Your account is pending admin approval. Please wait for an admin to approve your account."
          : "Your account has been deactivated. Contact your admin.",
        pending: neverLoggedIn,
      });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      req.prisma.auditLog.create({
        data: { userId: user.id, action: "LOGIN_FAILED", tableName: "users", recordId: user.id,
                newValues: { reason: "Wrong password" }, ipAddress: req.ip },
      }).catch(() => {});
      return res.status(401).json({ error: "Invalid email or password" });
    }

    await req.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await req.prisma.auditLog.create({
      data: { userId: user.id, action: "LOGIN", tableName: "users", recordId: user.id, ipAddress: req.ip },
    });

    // ── 2FA branch — admin only, code sent via EMAIL ─────────────────────────
    if (user.twoFaEnabled && user.role === "admin") {
      const code    = makeCode();
      const expires = new Date(Date.now() + 10 * 60 * 1000);

      await req.prisma.user.update({ where: { id: user.id }, data: { twoFaCode: code, twoFaExpires: expires } });

      let devCode = null;
      try {
        await sendEmail({
          to:      user.email,
          subject: `${code} is your STARMART login code`,
          html:    twoFaEmailHtml(user.name, code, "login"),
        });
      } catch (err) { console.error("2FA email error:", err.message); }
      // In dev mode (no BREVO_API_KEY) expose code on screen
      if (!process.env.BREVO_API_KEY) devCode = code;

      const jwt = require("jsonwebtoken");
      const pendingToken = jwt.sign({ id: user.id, role: user.role, pending2FA: true }, process.env.JWT_SECRET, { expiresIn: "10m" });
      const maskedEmail  = user.email.replace(/(.{1,3}).*(@.*)/, "$1***$2");
      return res.json({ requires2FA: true, pendingToken, maskedEmail, devCode });
    }
    const accessToken  = generateToken(user);
    const refreshToken = generateRefreshToken(user);
    setRefreshCookie(res, refreshToken);
    res.json({ token: accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, branchId: user.branchId ?? null } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/verify-2fa
// Body: { pendingToken, code }
router.post("/verify-2fa", async (req, res) => {
  try {
    const { pendingToken, code } = req.body;
    if (!pendingToken || !code) return res.status(400).json({ error: "Token and code required" });

    const jwt = require("jsonwebtoken");
    let decoded;
    try { decoded = jwt.verify(pendingToken, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: "Session expired. Please log in again." }); }

    if (!decoded.pending2FA) return res.status(401).json({ error: "Invalid token" });

    const user = await req.prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user || !user.isActive) return res.status(401).json({ error: "Account not found" });
    if (!user.twoFaCode || user.twoFaCode !== code.trim())
      return res.status(401).json({ error: "Incorrect verification code" });
    if (!user.twoFaExpires || new Date() > user.twoFaExpires)
      return res.status(401).json({ error: "Code has expired. Please log in again." });

    await req.prisma.user.update({ where: { id: user.id }, data: { twoFaCode: null, twoFaExpires: null } });
    const accessToken  = generateToken(user);
    const refreshToken = generateRefreshToken(user);
    setRefreshCookie(res, refreshToken);
    res.json({ token: accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, branchId: user.branchId ?? null } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/resend-2fa   resend login 2FA code using pendingToken
router.post("/resend-2fa", async (req, res) => {
  try {
    const { pendingToken } = req.body;
    if (!pendingToken) return res.status(400).json({ error: "Token required" });

    const jwt = require("jsonwebtoken");
    let decoded;
    try { decoded = jwt.verify(pendingToken, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: "Session expired. Please log in again." }); }
    if (!decoded.pending2FA) return res.status(401).json({ error: "Invalid token" });

    const user = await req.prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user || !user.isActive || !user.phone)
      return res.status(400).json({ error: "Cannot resend code." });

    const code    = makeCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000);
    await req.prisma.user.update({ where: { id: user.id }, data: { twoFaCode: code, twoFaExpires: expires } });

    let devCode = null;
    try {
      await sendEmail({
        to:      user.email,
        subject: `${code} is your new STARMART login code`,
        html:    twoFaEmailHtml(user.name, code, "resend"),
      });
    } catch (err) { console.error("Resend 2FA email error:", err.message); }
    if (!process.env.BREVO_API_KEY) devCode = code;

    const maskedEmail = user.email.replace(/(.{1,3}).*(@.*)/, "$1***$2");
    res.json({ message: "Code resent to your email", maskedEmail, devCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  try {
    const { name, email, password, role = "cashier", phone, branchId } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: "Name, email and password required" });
    if (!["cashier", "manager", "admin"].includes(role))
      return res.status(400).json({ error: "Invalid role" });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters" });

    if (role === "manager" || role === "admin") {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer "))
        return res.status(403).json({ error: "Admin authentication required" });
      try {
        const jwt = require("jsonwebtoken");
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        if (decoded.role !== "admin")
          return res.status(403).json({ error: "Only admins can create manager or admin accounts" });
      } catch { return res.status(403).json({ error: "Invalid or expired token" }); }
    }

    const existing = await req.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (existing) return res.status(409).json({ error: "An account with this email already exists" });

    const passwordHash = await bcrypt.hash(password, 12);

    // Determine if this is a self-signup (no valid admin token) or admin-created
    let isAdminCreated = false;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const jwt = require("jsonwebtoken");
        const decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
        if (decoded.role === "admin" || decoded.role === "manager") isAdminCreated = true;
      } catch {}
    }
    // Self-registered cashiers start as PENDING — admin/manager-created are immediately active
    const isActive = isAdminCreated;

    const user = await req.prisma.user.create({
      data: {
        name: name.trim(),
        email: email.toLowerCase().trim(),
        passwordHash,
        role,
        phone: phone?.trim() || null,
        branchId: branchId ? +branchId : null,
        isActive,
      },
    });

    await req.prisma.auditLog.create({
      data: { userId: user.id, action: "SIGNUP", tableName: "users", recordId: user.id, newValues: { role, status: isActive ? "active" : "pending" } },
    });

    if (!isAdminCreated) {
      return res.status(201).json({
        pending: true,
        message: "Account created. Waiting for admin approval before you can log in.",
      });
    }

    const accessToken  = generateToken(user);
    const refreshToken = generateRefreshToken(user);
    setRefreshCookie(res, refreshToken);
    res.status(201).json({ token: accessToken, user: { id: user.id, name: user.name, email: user.email, role: user.role, branchId: user.branchId ?? null } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/forgot-password   sends reset code via EMAIL (Resend)
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email required" });

    const user = await req.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });

    if (!user || !user.isActive)
      return res.json({ message: "If that email is registered, a reset code has been sent.", sentTo: "email" });

    const code    = makeCode();
    const expires = new Date(Date.now() + 15 * 60 * 1000);

    await req.prisma.user.update({ where: { id: user.id }, data: { resetToken: code, resetTokenExpires: expires } });
    await req.prisma.auditLog.create({
      data: { action: "PASSWORD_RESET_REQUESTED", tableName: "users", recordId: user.id, ipAddress: req.ip },
    }).catch(()=>{});

    // - Always log the code to the server console so you can see it even if email fails
    console.log(`\n-`);
    console.log(` PASSWORD RESET CODE for ${user.email}`);
    console.log(`   CODE: ${code}  (valid 15 min)`);
    console.log(`-\n`);

    let emailSent = false;
    let emailError = null;

    try {
      const result = await sendEmail({
        to:      user.email,
        subject: `${code} is your STARMART password reset code`,
        html:    resetEmailHtml(user.name, code),
      });
      emailSent = !result.devMode;
      if (result.devMode) {
        emailError = "No email credentials set. Code shown on screen (dev mode).";
      }
    } catch (err) {
      emailError = err.message;
      console.error("[EMAIL] Failed:", err.message);
    }

    // Mask the email: j***@gmail.com
    const [localPart, domain] = user.email.split("@");
    const maskedEmail = localPart[0] + "***@" + domain;

    // Always return devCode so the screen shows it as a fallback when email fails
    res.json({
      message:    emailSent ? "Reset code sent to your email" : "Reset code generated (check server console if email failed)",
      sentTo:     "email",
      maskedEmail,
      emailSent,
      emailError: emailError || null,
      devCode:    code,   //  always returned so screen always shows it as backup
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/reset-password
router.post("/reset-password", async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body;
    if (!email || !resetToken || !newPassword)
      return res.status(400).json({ error: "Email, code and new password required" });
    if (newPassword.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters" });

    const user = await req.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.isActive) return res.status(400).json({ error: "Invalid code or email" });
    if (!user.resetToken || user.resetToken !== resetToken.trim())
      return res.status(400).json({ error: "Invalid reset code" });
    if (!user.resetTokenExpires || new Date() > user.resetTokenExpires)
      return res.status(400).json({ error: "Reset code has expired. Please request a new one." });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await req.prisma.user.update({ where: { id: user.id }, data: { passwordHash, resetToken: null, resetTokenExpires: null } });
    await req.prisma.auditLog.create({
      data: { userId: user.id, action: "PASSWORD_RESET", tableName: "users", recordId: user.id, ipAddress: req.ip },
    });

    res.json({ message: "Password reset successfully. You can now log in." });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/auth/me
router.get("/me", authenticate, async (req, res) => {
  try {
    const user = await req.prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { id: true, name: true, email: true, role: true, phone: true, twoFaEnabled: true, lastLoginAt: true, createdAt: true, branchId: true },
    });
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/change-password
router.post("/change-password", authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Both passwords required" });
    if (newPassword.length < 8) return res.status(400).json({ error: "Must be at least 8 characters" });
    const user = await req.prisma.user.findUnique({ where: { id: req.user.id } });
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Current password is incorrect" });
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await req.prisma.user.update({ where: { id: req.user.id }, data: { passwordHash } });
    res.json({ message: "Password changed successfully" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/update-phone
router.post("/update-phone", authenticate, async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: "Phone number required" });
    await req.prisma.user.update({ where: { id: req.user.id }, data: { phone: phone.trim() } });
    res.json({ message: "Phone number updated" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/setup-2fa   sends verification SMS
router.post("/setup-2fa", authenticate, requireRole(["admin"]), async (req, res) => {
  try {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "2FA is only available for Admin accounts." });
    const user = await req.prisma.user.findUnique({ where: { id: req.user.id } });

    const code    = makeCode();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await req.prisma.user.update({ where: { id: req.user.id }, data: { twoFaCode: code, twoFaExpires: expires } });

    let devCode = null;
    try {
      await sendEmail({
        to:      user.email,
        subject: `${code} — Enable 2FA on your STARMART account`,
        html:    twoFaEmailHtml(user.name, code, "setup"),
      });
    } catch (err) { console.error("2FA setup email error:", err.message); }
    if (!process.env.BREVO_API_KEY) devCode = code;

    const maskedEmail = user.email.replace(/(.{1,3}).*(@.*)/, "$1***$2");
    res.json({ message: "Verification code sent to your email", maskedEmail, devCode });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/confirm-2fa   verify code, enable 2FA
router.post("/confirm-2fa", authenticate, async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Verification code required" });
    const user = await req.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user.twoFaCode || user.twoFaCode !== code.trim())
      return res.status(401).json({ error: "Incorrect code" });
    if (!user.twoFaExpires || new Date() > user.twoFaExpires)
      return res.status(401).json({ error: "Code expired. Request a new one." });
    await req.prisma.user.update({ where: { id: req.user.id }, data: { twoFaEnabled: true, twoFaCode: null, twoFaExpires: null } });
    res.json({ message: "Two-factor authentication enabled" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/disable-2fa   requires current password
router.post("/disable-2fa", authenticate, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: "Current password required" });
    const user = await req.prisma.user.findUnique({ where: { id: req.user.id } });
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Incorrect password" });
    await req.prisma.user.update({ where: { id: req.user.id }, data: { twoFaEnabled: false, twoFaCode: null, twoFaExpires: null } });
    res.json({ message: "Two-factor authentication disabled" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// POST /api/auth/refresh  ── issue new access token using httpOnly refresh cookie
router.post("/refresh", async (req, res) => {
  try {
    const token = req.cookies?.refresh_token;
    if (!token) return res.status(401).json({ error: "No refresh token", code: "NO_REFRESH" });

    let decoded;
    try { decoded = verifyRefreshToken(token); }
    catch { return res.status(401).json({ error: "Refresh token expired or invalid", code: "REFRESH_EXPIRED" }); }

    // Load user and validate token version (invalidates old tokens after logout)
    const user = await req.prisma.user.findUnique({ where: { id: decoded.id } });
    if (!user || !user.isActive) return res.status(401).json({ error: "User not found" });
    if ((user.tokenVersion ?? 0) !== (decoded.version ?? 0))
      return res.status(401).json({ error: "Token has been revoked", code: "REVOKED" });

    // Rotate: issue new access token + new refresh token
    const accessToken  = generateToken(user);
    const refreshToken = generateRefreshToken(user);
    setRefreshCookie(res, refreshToken);
    res.json({ token: accessToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/auth/logout  ── revoke refresh token
router.post("/logout", authenticate, async (req, res) => {
  try {
    // Bump tokenVersion so all existing refresh tokens are invalid
    await req.prisma.user.update({
      where: { id: req.user.id },
      data:  { tokenVersion: { increment: 1 } },
    }).catch(() => {});
    clearRefreshCookie(res);
    res.json({ message: "Logged out" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;