const {
  apiCredential,
  configuredModes,
  verifySession,
  fetchPurchase,
  validatePurchase,
  grantAndDeliver
} = require("./_lib/vatar");

function send(res, status, payload) {
  return res.status(status).json(payload);
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "Method not allowed." });
  }

  if (configuredModes().length === 0 || !process.env.POSTGRES_URL) {
    return send(res, 503, {
      ok: false,
      error: "Purchase verification is not configured."
    });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return send(res, 400, { ok: false, error: "Invalid JSON body." });
      }
    }

    const session = body && typeof body.session === "string" ? body.session : "";
    const purchaseId = body && typeof body.purchaseId === "string" ? body.purchaseId : "";

    if (
      !session ||
      session.length > 10000 ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(purchaseId)
    ) {
      return send(res, 400, {
        ok: false,
        error: "A valid session and purchase ID are required."
      });
    }

    // Determine mode by verifying the signed session with configured server secrets.
    // Never trust a mode value supplied by the browser.
    const verified = await verifySession(session);
    if (!verified) {
      return send(res, 401, {
        ok: false,
        error: "Vatar session verification failed."
      });
    }

    const { player, mode, secret } = verified;
    const { response, purchase } = await fetchPurchase(purchaseId, secret);

    if (!response.ok) {
      return send(res, response.status === 404 ? 404 : 409, {
        ok: false,
        error: "Purchase could not be verified."
      });
    }

    const validationError = validatePurchase(
      purchase,
      purchaseId,
      player.playerId,
      mode
    );
    if (validationError) {
      return send(res, 409, { ok: false, error: validationError });
    }

    const result = await grantAndDeliver(purchase, player.playerId, secret);
    if (!result.ok) {
      return send(res, result.http || 503, {
        ok: false,
        error: result.error,
        retryable: !!result.retryable
      });
    }

    return send(res, 200, {
      ...result,
      mode
    });
  } catch {
    // Never expose internal errors, database URLs, or credentials.
    return send(res, 503, {
      ok: false,
      error: "Purchase claim could not be completed. Please retry.",
      retryable: true
    });
  }
};
