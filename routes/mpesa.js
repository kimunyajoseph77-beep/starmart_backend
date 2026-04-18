/**
 * routes/mpesa.js — Safaricom Daraja: STK Push + C2B (Paybill & Buy Goods)
 *
 * ENV vars needed (.env):
 *   MPESA_ENV=sandbox
 *   MPESA_CONSUMER_KEY=...
 *   MPESA_CONSUMER_SECRET=...
 *   MPESA_SHORTCODE=174379
 *   MPESA_PASSKEY=...
 *   MPESA_CALLBACK_URL=https://yourdomain.com/api/mpesa/callback
 */

const express = require("express");
const router  = express.Router();
const { authenticate } = require("../middleware/auth");

// Trim all M-Pesa env vars on load — .env values sometimes have trailing newlines
["MPESA_CALLBACK_URL","MPESA_CONSUMER_KEY","MPESA_CONSUMER_SECRET",
 "MPESA_SHORTCODE","MPESA_PASSKEY"].forEach(k => {
  if (process.env[k]) process.env[k] = process.env[k].trim();
});

// ── In-memory stores ──────────────────────────────────────────────────────────
const stkResults  = {}; // STK Push: keyed by CheckoutRequestID
const c2bSessions = {}; // C2B:      keyed by sessionId

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } catch (e) {
    if (e.name === "AbortError")
      throw new Error(`M-Pesa request timed out after ${timeoutMs / 1000}s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function mpesaBaseUrl() {
  return process.env.MPESA_ENV === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

let _tokenCache = null;

async function getAccessToken() {
  const key    = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    console.error("[M-Pesa] MPESA_CONSUMER_KEY or MPESA_CONSUMER_SECRET missing from .env");
    throw new Error("M-Pesa credentials not configured in .env");
  }

  if (_tokenCache && _tokenCache.expiresAt > Date.now() + 60000) {
    return _tokenCache.token;
  }

  const url   = `${mpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`;
  const creds = Buffer.from(`${key}:${secret}`).toString("base64");
  console.log("[M-Pesa] Fetching access token from:", url);

  const res = await fetchWithTimeout(url, { headers: { Authorization: `Basic ${creds}` } }, 15000);
  console.log("[M-Pesa] Token response status:", res.status, res.statusText);

  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    console.error("[M-Pesa] Token error body:", body.slice(0, 300));
    throw new Error(`Failed to get M-Pesa access token (HTTP ${res.status})`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const body = await res.text().catch(() => "(unreadable)");
    console.error("[M-Pesa] Non-JSON token response:", body.slice(0, 300));
    throw new Error("M-Pesa auth returned non-JSON — check Consumer Key/Secret in .env");
  }

  const data = await res.json();
  if (!data.access_token) {
    console.error("[M-Pesa] Token response missing access_token:", JSON.stringify(data));
    throw new Error("M-Pesa token response missing access_token");
  }

  const expiresIn = parseInt(data.expires_in) || 3599;
  _tokenCache = { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
  console.log("[M-Pesa] Token cached, expires in", expiresIn, "seconds");
  return _tokenCache.token;
}

function formatPhone(raw) {
  let p = raw.replace(/\s+/g, "").replace(/^\+/, "");
  if (p.startsWith("0")) p = "254" + p.slice(1);
  return p;
}

function getTimestamp() {
  return new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
}

function getPassword(ts) {
  return Buffer.from(
    `${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${ts}`
  ).toString("base64");
}

function makeSessionId() {
  return `c2b_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── STK PUSH ──────────────────────────────────────────────────────────────────

router.post("/stk-push", authenticate, async (req, res) => {
  try {
    const { phone, amount, transactionType, shortcode, accountReference } = req.body;
    if (!phone || !amount)
      return res.status(400).json({ error: "phone and amount required" });

    console.log(
      "[STK Push] Config — SHORTCODE:", process.env.MPESA_SHORTCODE,
      "| ENV:", process.env.MPESA_ENV,
      "| PASSKEY set:", !!process.env.MPESA_PASSKEY,
      "| KEY set:", !!process.env.MPESA_CONSUMER_KEY,
      "| SECRET set:", !!process.env.MPESA_CONSUMER_SECRET,
      "| CALLBACK:", process.env.MPESA_CALLBACK_URL
    );

    const token = await getAccessToken();
    const ts    = getTimestamp();

    const ownShortcode  = process.env.MPESA_SHORTCODE;
    const partyB        = shortcode || ownShortcode;
    const effectiveType = process.env.MPESA_ENV === "production"
      ? (transactionType || "CustomerPayBillOnline")
      : "CustomerPayBillOnline";

    function isPhoneLike(val) {
      return val && /^(\+?254|0)[17]\d{8}$/.test(val.replace(/\s+/g, ""));
    }
    const rawRef       = accountReference || "STARMART POS";
    const effectiveRef = isPhoneLike(rawRef) ? formatPhone(rawRef) : rawRef;
    const callbackUrl  = (process.env.MPESA_CALLBACK_URL || "").trim();

    const stkRes = await fetchWithTimeout(
      `${mpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`,
      {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: ownShortcode,
          Password:          getPassword(ts),
          Timestamp:         ts,
          TransactionType:   effectiveType,
          Amount:            Math.ceil(amount),
          PartyA:            formatPhone(phone),
          PartyB:            partyB,
          PhoneNumber:       formatPhone(phone),
          CallBackURL:       callbackUrl,
          AccountReference:  effectiveRef,
          TransactionDesc:   "POS Payment",
        }),
      },
      30000  // 30s — Safaricom sandbox can take 10-20s to respond
    );

    console.log("[STK Push] Daraja response status:", stkRes.status);
    const data = await stkRes.json();
    console.log("[STK Push] Daraja response:", JSON.stringify(data));

    if (data.ResponseCode !== "0") {
      return res.status(400).json({
        error:  data.errorMessage || data.ResponseDescription || "STK Push failed",
        daraja: data,
      });
    }

    stkResults[data.CheckoutRequestID] = { status: "pending" };
    res.json({ CheckoutRequestID: data.CheckoutRequestID });

  } catch (e) {
    console.error("[STK Push] Error:", e.message);
    _tokenCache = null;
    res.status(500).json({ error: e.message });
  }
});

// ── STK Callback ──────────────────────────────────────────────────────────────
router.post("/callback", (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback;
    if (!cb) return res.json({ ResultCode: 0, ResultDesc: "OK" });
    const id = cb.CheckoutRequestID;
    if (cb.ResultCode === 0) {
      const items  = cb.CallbackMetadata?.Item || [];
      const getVal = (n) => items.find(i => i.Name === n)?.Value;
      stkResults[id] = {
        status:    "confirmed",
        mpesaCode: getVal("MpesaReceiptNumber"),
        amount:    getVal("Amount"),
        phone:     getVal("PhoneNumber"),
      };
    } else {
      stkResults[id] = { status: "failed", message: cb.ResultDesc || "Payment failed" };
    }
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (e) {
    console.error("STK callback error:", e.message);
    res.json({ ResultCode: 0, ResultDesc: "OK" });
  }
});

// ── STK Status polling ────────────────────────────────────────────────────────
router.get("/status/:id", authenticate, (req, res) => {
  res.json(stkResults[req.params.id] || { status: "pending" });
});

// ── STK Query (direct Daraja check) ──────────────────────────────────────────
router.get("/stk-query/:checkoutRequestId", authenticate, async (req, res) => {
  try {
    const { checkoutRequestId } = req.params;

    const cached = stkResults[checkoutRequestId];
    if (cached && cached.status !== "pending") return res.json(cached);

    const token = await getAccessToken();
    const ts    = getTimestamp();

    const qRes = await fetchWithTimeout(
      `${mpesaBaseUrl()}/mpesa/stkpushquery/v1/query`,
      {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: process.env.MPESA_SHORTCODE,
          Password:          getPassword(ts),
          Timestamp:         ts,
          CheckoutRequestID: checkoutRequestId,
        }),
      },
      15000
    );

    const data = await qRes.json();
    console.log("[STK Query]", checkoutRequestId, data.ResultCode, data.ResultDesc);

    // Safaricom Result Codes:
    // 0     = Success
    // 1     = Insufficient balance (keep polling — Fuliza may complete it)
    // 1032  = Cancelled by user
    // 1037  = Not found yet — keep polling
    // 4999  = Still processing — keep polling
    // 2001  = Wrong PIN
    // other = definitive failure

    const KEEP_POLLING = new Set(["1037", "4999"]);
    const code = data.ResultCode !== undefined ? String(data.ResultCode) : null;

    if (code === "0") {
      const result = {
        status:    "confirmed",
        mpesaCode: data.MpesaReceiptNumber || "CONFIRMED",
        amount:    data.Amount,
        phone:     data.PhoneNumber,
      };
      stkResults[checkoutRequestId] = result;
      return res.json(result);
    }

    if (KEEP_POLLING.has(code)) {
      return res.json({ status: "pending", resultDesc: data.ResultDesc });
    }

    if (code === "1032") {
      const result = { status: "failed", message: "Transaction cancelled by customer." };
      stkResults[checkoutRequestId] = result;
      return res.json(result);
    }

    if (code === "1") {
      return res.json({
        status:  "fuliza",
        message: "Insufficient balance — customer can accept Fuliza to complete payment.",
      });
    }

    if (code === "2001") {
      const result = { status: "failed", message: "Wrong M-Pesa PIN entered." };
      stkResults[checkoutRequestId] = result;
      return res.json(result);
    }

    if (code !== null && code !== "") {
      const result = { status: "failed", message: data.ResultDesc || `Payment failed (code ${code}).` };
      stkResults[checkoutRequestId] = result;
      return res.json(result);
    }

    // No ResultCode — query too early, keep polling
    if (data.errorCode || data.errorMessage) {
      console.log("[STK Query] Daraja error:", data.errorCode, data.errorMessage);
    }
    res.json({ status: "pending" });

  } catch (e) {
    console.error("[STK Query] Error:", e.message);
    res.json({ status: "error", message: e.message });
  }
});

// ── C2B — Paybill / Buy Goods ─────────────────────────────────────────────────

router.post("/c2b/register", authenticate, async (req, res) => {
  try {
    const token   = await getAccessToken();
    const baseUrl = (process.env.MPESA_CALLBACK_URL || "").trim()
      .replace(/\/api\/mpesa\/callback.*$/, "");
    const result  = await fetchWithTimeout(
      `${mpesaBaseUrl()}/mpesa/c2b/v1/registerurl`,
      {
        method:  "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          ShortCode:       process.env.MPESA_SHORTCODE,
          ResponseType:    "Completed",
          ConfirmationURL: `${baseUrl}/api/mpesa/c2b/confirm`,
          ValidationURL:   `${baseUrl}/api/mpesa/c2b/validate`,
        }),
      },
      15000
    );
    res.json(await result.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/c2b/session", authenticate, (req, res) => {
  const { amount } = req.body;
  if (!amount) return res.status(400).json({ error: "amount required" });
  const sessionId = makeSessionId();
  const amountInt = Math.ceil(amount);
  c2bSessions[sessionId] = {
    amount: amountInt, status: "pending",
    mpesaCode: null, phone: null, paidAt: null, createdAt: Date.now(),
  };
  setTimeout(() => {
    if (c2bSessions[sessionId]?.status === "pending")
      c2bSessions[sessionId].status = "expired";
  }, 10 * 60 * 1000);
  res.json({ sessionId, amount: amountInt });
});

router.post("/c2b/validate", (req, res) => {
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

router.post("/c2b/confirm", (req, res) => {
  try {
    const { TransID, TransAmount, MSISDN, BillRefNumber } = req.body;
    const paidAmount = Math.ceil(parseFloat(TransAmount));
    console.log(`[C2B] ${TransID} | KSh ${paidAmount} | ${MSISDN} | ref: ${BillRefNumber}`);
    const sessionId = Object.keys(c2bSessions).find(id => {
      const s = c2bSessions[id];
      return s.status === "pending" && s.amount === paidAmount;
    });
    if (sessionId) {
      c2bSessions[sessionId] = {
        ...c2bSessions[sessionId],
        status: "confirmed", mpesaCode: TransID,
        phone: MSISDN, paidAt: new Date().toISOString(),
      };
      console.log(`[C2B] Matched to session ${sessionId}`);
    } else {
      c2bSessions[`unmatched_${TransID}`] = {
        status: "unmatched", amount: paidAmount, mpesaCode: TransID,
        phone: MSISDN, billRef: BillRefNumber, paidAt: new Date().toISOString(),
      };
      console.warn(`[C2B] Unmatched payment KSh ${paidAmount} from ${MSISDN}`);
    }
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (e) {
    console.error("C2B confirm error:", e.message);
    res.json({ ResultCode: 0, ResultDesc: "OK" });
  }
});

router.get("/c2b/status/:sessionId", authenticate, (req, res) => {
  res.json(c2bSessions[req.params.sessionId] || { status: "pending" });
});

router.get("/c2b/unmatched", authenticate, (req, res) => {
  const unmatched = Object.values(c2bSessions)
    .filter(s => s.status === "unmatched")
    .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
  res.json(unmatched);
});

module.exports = router;
