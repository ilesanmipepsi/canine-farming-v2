const { neon } = require("@neondatabase/serverless");
const VATAR_API = "https://lagoslife.app/api/games/v1";

function send(res, status, body) {
  return res.status(status).json(body);
}

async function verifySession(session, secret) {
  const response = await fetch(`${VATAR_API}/session/verify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ session })
  });
  if (!response.ok) return null;
  const player = await response.json();
  if (
    player.mode !== "test" ||
    typeof player.playerId !== "string" ||
    !player.playerId ||
    typeof player.gameId !== "string" ||
    !player.gameId
  ) return null;
  return player;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // POST keeps the short-lived Vatar session out of URLs, browser history,
  // analytics, and proxy access logs. This endpoint is not wired into the UI yet.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "Method not allowed." });
  }

  const secret = process.env.VATAR_SECRET;
  const databaseUrl = process.env.POSTGRES_URL;
  if (!secret || !databaseUrl) {
    return send(res, 503, { ok: false, error: "Wallet service is not configured." });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return send(res, 400, { ok: false, error: "Invalid JSON body." }); }
    }
    const session = typeof body?.session === "string" ? body.session : "";
    if (!session || session.length > 10000) {
      return send(res, 400, { ok: false, error: "A valid Vatar session is required." });
    }

    const player = await verifySession(session, secret);
    if (!player) return send(res, 401, { ok: false, error: "Valid Vatar test session required." });

    const sql = neon(databaseUrl);
    const rows = await sql`
      SELECT balance, purchased_balance, status, version, updated_at
      FROM public.cfc_wallets WHERE player_id = ${player.playerId} LIMIT 1
    `;
    if (!rows[0]) {
      return send(res, 200, {
        ok: true,
        initialized: false,
        migrationRequired: true,
        mode: "test",
        message: "Wallet schema is ready, but this player's legacy balance has not been migrated."
      });
    }
    return send(res, 200, {
      ok: true,
      initialized: true,
      migrationRequired: rows[0].status === "migration_required",
      status: rows[0].status,
      balance: Number(rows[0].balance),
      purchasedBalance: Number(rows[0].purchased_balance),
      version: Number(rows[0].version),
      updatedAt: rows[0].updated_at
    });
  } catch {
    return send(res, 503, { ok: false, error: "Wallet lookup failed. Retry later." });
  }
};
