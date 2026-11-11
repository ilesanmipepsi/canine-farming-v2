const crypto = require("node:crypto");
const { neon } = require("@neondatabase/serverless");
const {
  apiCredential,
  webhookCredential,
  fetchPurchase,
  validatePurchase,
  grantAndDeliver
} = require("../lib/vatar");

function send(res, status, payload) {
  return res.status(status).json(payload);
}

function readRawBody(req, maxBytes = 262144) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Webhook body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function signatureMatches(raw, header, secret) {
  if (typeof header !== "string" || !header.startsWith("sha256=")) {
    return false;
  }
  const suppliedHex = header.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(raw)
    .digest();
  const supplied = Buffer.from(suppliedHex, "hex");

  return supplied.length === expected.length &&
    crypto.timingSafeEqual(supplied, expected);
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "Method not allowed." });
  }

  if (!process.env.POSTGRES_URL) {
    return send(res, 503, { ok: false, error: "Database is not configured." });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    return send(res, 400, { ok: false, error: "Invalid webhook body." });
  }

  const signature = req.headers["x-vatar-signature"];
  const deliveryId = req.headers["x-vatar-delivery"];
  const eventHeader = req.headers["x-vatar-event"];

  if (
    typeof deliveryId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(deliveryId) ||
    typeof signature !== "string"
  ) {
    return send(res, 401, { ok: false, error: "Missing or invalid webhook headers." });
  }

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    return send(res, 400, { ok: false, error: "Invalid webhook JSON." });
  }

  if (
    !event ||
    event.type !== "purchase.paid" ||
    eventHeader !== "purchase.paid" ||
    event.id !== deliveryId ||
    !event.data ||
    typeof event.data.purchaseId !== "string" ||
    typeof event.data.playerId !== "string" ||
    typeof event.mode !== "string"
  ) {
    return send(res, 400, { ok: false, error: "Unsupported or malformed webhook event." });
  }

  const mode = event.mode;
  const whsec = webhookCredential(mode);
  const secret = apiCredential(mode);

  if (!["live", "test"].includes(mode) || !whsec || !secret) {
    return send(res, 503, {
      ok: false,
      error: "Webhook credentials for this mode are not configured."
    });
  }

  if (!signatureMatches(raw, signature, whsec)) {
    return send(res, 401, { ok: false, error: "Invalid webhook signature." });
  }

  try {
    const sql = neon(process.env.POSTGRES_URL);

    // Record only after successful processing so Vatar retries transient failures.
    await sql`
      CREATE TABLE IF NOT EXISTS public.vatar_webhook_events (
        delivery_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        mode TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;

    const seen = await sql`
      SELECT delivery_id
      FROM public.vatar_webhook_events
      WHERE delivery_id = ${deliveryId}
      LIMIT 1
    `;
    if (seen.length) {
      return send(res, 200, { ok: true, duplicate: true });
    }

    const { response, purchase } = await fetchPurchase(event.data.purchaseId, secret);
    if (!response.ok) {
      return send(res, 503, {
        ok: false,
        error: "Vatar purchase lookup failed; webhook may be retried."
      });
    }

    const validationError = validatePurchase(
      purchase,
      event.data.purchaseId,
      event.data.playerId,
      mode
    );
    if (
      validationError ||
      purchase.productId !== event.data.productId ||
      Number(purchase.amount) !== Number(event.data.amount) ||
      purchase.currency !== event.data.currency
    ) {
      return send(res, 409, {
        ok: false,
        error: validationError || "Webhook data does not match Vatar's purchase record."
      });
    }

    const result = await grantAndDeliver(purchase, purchase.playerId, secret);
    if (!result.ok) {
      return send(res, result.http || 503, {
        ok: false,
        error: result.error,
        retryable: !!result.retryable
      });
    }

    await sql`
      INSERT INTO public.vatar_webhook_events
        (delivery_id, event_type, mode)
      VALUES
        (${deliveryId}, 'purchase.paid', ${mode})
      ON CONFLICT (delivery_id) DO NOTHING
    `;

    return send(res, 200, { ok: true, processed: true });
  } catch {
    // A non-2xx response asks Vatar to retry the delivery.
    return send(res, 503, {
      ok: false,
      error: "Webhook processing failed; retry is safe."
    });
  }
};

// Vercel must preserve the exact raw body for HMAC verification.
module.exports.config = {
  api: { bodyParser: false }
};
