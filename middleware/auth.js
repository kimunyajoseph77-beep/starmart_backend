// backend/middleware/auth.js
const jwt = require("jsonwebtoken");

const JWT_SECRET         = process.env.JWT_SECRET         || "change_this_in_production";
const REFRESH_SECRET     = process.env.REFRESH_SECRET      || "refresh_secret_change_this";
const ACCESS_TOKEN_TTL   = "15m";   // short-lived access token
const REFRESH_TOKEN_TTL  = "7d";    // refresh token

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer "))
    return res.status(401).json({ error: "No token provided" });

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    // Give the client a specific error so it knows to try refreshing
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    return res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Not authenticated" });
    if (!allowed.includes(req.user.role))
      return res.status(403).json({
        error: `Access denied. Required role: ${allowed.join(" or ")}`,
        yourRole: req.user.role,
      });
    next();
  };
}

// Short-lived access token (15 min)
function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name, branchId: user.branchId ?? null },
    JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL }
  );
}

// Long-lived refresh token (7 days) — stored in httpOnly cookie
function generateRefreshToken(user) {
  return jwt.sign(
    { id: user.id, version: user.tokenVersion ?? 0 },
    REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_TTL }
  );
}

function verifyRefreshToken(token) {
  return jwt.verify(token, REFRESH_SECRET);
}

// Set httpOnly cookie for refresh token
function setRefreshCookie(res, token) {
  res.cookie("refresh_token", token, {
    httpOnly:  true,
    secure:    process.env.NODE_ENV === "production",
    sameSite:  "Strict",
    maxAge:    7 * 24 * 60 * 60 * 1000, // 7 days ms
    path:      "/api/auth/refresh",       // only sent to refresh endpoint
  });
}

function clearRefreshCookie(res) {
  res.clearCookie("refresh_token", { path: "/api/auth/refresh" });
}

module.exports = {
  authenticate, requireRole,
  generateToken, generateRefreshToken,
  verifyRefreshToken, setRefreshCookie, clearRefreshCookie,
};