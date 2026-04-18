// backend/routes/coupons.js
const express = require("express");
const { authenticate, requireRole } = require("../middleware/auth");
const router = express.Router();
router.use(authenticate);

// GET /api/coupons
router.get("/", requireRole(["admin","manager"]), async (req, res) => {
  try {
    const coupons = await req.prisma.coupon.findMany({ orderBy: { createdAt: "desc" } });
    res.json(coupons);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
