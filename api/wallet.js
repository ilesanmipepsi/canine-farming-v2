const { neon } = require("@neondatabase/serverless");
const {
  configuredModes,
  verifySession
} = require("../lib/vatar");

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
    return send(res, 503, { ok: false, error: "Wallet sync is not configured." });
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
    if (!session || session.length > 10000) {
      return send(res, 400, { ok: false, error: "A valid Vatar session is required." });
    }

    const verified = await verifySession(session);
    if (!verified) {
      return send(res, 401, { ok: false, error: "Vatar session verification failed." });
    }

    const sql = neon(process.env.POSTGRES_URL);
    const rows = await sql`
      SELECT purchased_cfc
      FROM public.vatar_cfc_wallets
      WHERE player_id = ${verified.player.playerId}
      LIMIT 1
    `;

    return send(res, 200, {
      ok: true,
      mode: verified.mode,
      purchasedCfc: Number(rows[0]?.purchased_cfc ?? 0)
    });
  } catch {
    return send(res, 503, {
      ok: false,
      error: "Wallet sync could not be completed. Please retry."
    });
  }
};
