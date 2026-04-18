// backend/middleware/auth.js
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "change_this_in_production";

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer "))
    return res.status(401).json({ error: "No token provided" });

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email, role, name, branchId }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
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

function generateToken(user) {
  return jwt.sign(
    {
      id:       user.id,
      email:    user.email,
      role:     user.role,
      name:     user.name,
      branchId: user.branchId ?? null,  // ← included in every token
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

module.exports = { authenticate, requireRole, generateToken };
