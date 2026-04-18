// backend/routes/settings.js
// Shop settings — stored in DB so ALL users share the same config
// GET  /api/settings       — any authenticated user can read
// PUT  /api/settings       — admin only can write

const express = require("express");
const { authenticate, requireRole } = require("../middleware/auth");
const router = express.Router();

const SETTINGS_KEY = "shop_settings";

// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get("/", authenticate, async (req, res) => {
  try {
    // We store settings as a single JSON row in a simple key-value approach
    // using the AuditLog table's notes field OR a dedicated table.
    // Since we don't have a settings table, we use a workaround:
    // store as a special "system" record. Simpler: use a JSON file on disk.
    // Best approach for this stack: store in DB via raw query to a settings table.
    // We'll create the table if it doesn't exist, then read/write to it.

    await req.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS shop_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    const rows = await req.prisma.$queryRawUnsafe(
      `SELECT value FROM shop_settings WHERE key = $1`,
      SETTINGS_KEY
    );

    if (rows.length === 0) {
      return res.json({});  // no settings saved yet
    }

    try {
      res.json(JSON.parse(rows[0].value));
    } catch {
      res.json({});
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/settings ─────────────────────────────────────────────────────────
router.put("/", authenticate, requireRole("admin"), async (req, res) => {
  try {
    const settings = req.body;
    if (typeof settings !== "object" || Array.isArray(settings))
      return res.status(400).json({ error: "Settings must be a JSON object." });

    await req.prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS shop_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await req.prisma.$executeRawUnsafe(
      `INSERT INTO shop_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      SETTINGS_KEY,
      JSON.stringify(settings)
    );

    res.json({ message: "Settings saved.", settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
