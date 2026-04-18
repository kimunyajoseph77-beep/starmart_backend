// backend/server.js
// STARMART POS — Express + Prisma API Server

require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const helmet     = require("helmet");
const morgan     = require("morgan");
const rateLimit  = require("express-rate-limit");
const { PrismaClient } = require("@prisma/client");

const authRoutes      = require("./routes/auth");
const productRoutes   = require("./routes/products");
const customerRoutes  = require("./routes/customers");
const orderRoutes     = require("./routes/orders");
const reportRoutes    = require("./routes/reports");
const couponRoutes    = require("./routes/coupons");
const userRoutes      = require("./routes/users");
const mpesaRoutes     = require("./routes/mpesa");
const branchRoutes    = require("./routes/branches");
const refundRoutes    = require("./routes/refunds");
const securityRoutes  = require("./routes/security");
const settingsRoutes  = require("./routes/settings");

const app    = express();
const prisma = new PrismaClient();
const PORT   = process.env.PORT || 4000;

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────

// Helmet — relax CSP so Vite's dev bundler (which uses eval for source maps) works.
// In production (NODE_ENV=production) eval is blocked for real security.
const isDev = process.env.NODE_ENV !== "production";
app.use(helmet({
  contentSecurityPolicy: isDev
    ? false          // disable CSP entirely in dev — Vite HMR + eval work fine
    : {              // strict policy in production
        directives: {
          defaultSrc:  ["'self'"],
          scriptSrc:   ["'self'"],
          styleSrc:    ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc:     ["'self'", "https://fonts.gstatic.com"],
          imgSrc:      ["'self'", "data:", "blob:"],
          connectSrc:  ["'self'"],
          frameSrc:    ["'none'"],
          objectSrc:   ["'none'"],
          upgradeInsecureRequests: [],
        },
      },
  crossOriginEmbedderPolicy: false, // needed for some browser APIs
}));
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || "http://localhost:5173,http://localhost:3000").split(",").map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));
app.use(express.json({ limit: "10mb" }));        // base64 product images need room
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(morgan("dev"));

// Rate limiting — tighten on auth routes
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500 });
const authLimiter   = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: "Too many login attempts. Try again later." });

app.use(globalLimiter);

// Attach prisma to every request
app.use((req, _res, next) => { req.prisma = prisma; next(); });

// ── ROUTES ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ status: "ok", version: "2.0", time: new Date() }));

app.use("/api/auth",      authLimiter, authRoutes);
app.use("/api/products",  productRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/orders",    orderRoutes);
app.use("/api/reports",   reportRoutes);
app.use("/api/coupons",   couponRoutes);
app.use("/api/users",     userRoutes);
app.use("/api/branches",  branchRoutes);
app.use("/api/refunds",   refundRoutes);
app.use("/api/security",  securityRoutes);
app.use("/api/settings",  settingsRoutes);
app.use("/api/mpesa",     mpesaRoutes);

// ── 404 & ERROR HANDLERS ─────────────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ error: "Route not found" }));

app.use((err, _req, res, _next) => {
  console.error(err.stack);
  const status = err.status || 500;
  res.status(status).json({
    error:   err.message || "Internal server error",
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
});

// ── START ─────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  try {
    await prisma.$connect();
    console.log(`✅ Database connected`);
    console.log(`🚀 STARMART API running on http://localhost:${PORT}`);
    console.log(`📚 Environment: ${process.env.NODE_ENV || "development"}`);
  } catch (e) {
    console.error("❌ Database connection failed:", e.message);
    process.exit(1);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Fix: npx kill-port ${PORT} && node server.js\n`);
    process.exit(1);
  } else {
    throw err;
  }
});

module.exports = app;
