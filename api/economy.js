const { neon } = require("@neondatabase/serverless");
const VATAR_API = "https://lagoslife.app/api/games/v1";

// Only server-defined actions are accepted. Clients never submit a balance,
// reward amount, price, or resulting balance.
const ACTIONS = Object.freeze({
  job_walk: { type: "earn", amount: 45, dailyLimit: 3 },
  job_clean: { type: "earn", amount: 35, dailyLimit: 3 },
  job_delivery: { type: "earn", amount: 55, dailyLimit: 3 },
  job_pet_shop: { type: "earn", amount: 65, dailyLimit: 3 },
  feed_dog: { type: "spend", amount: 25 },
  vet_check: { type: "spend", amount: 30 },
  buy_dog: { type: "spend", amount: 500 },
  upgrade_kennel: { type: "spend", amount: 300 }
});

function send(res, status, body) {
  return res.status(status).json(body);
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { ok: false, error: "Method not allowed." });
  }

  const secret = process.env.VATAR_SECRET;
  const databaseUrl = process.env.POSTGRES_URL;
  if (!secret || !databaseUrl) {
    return send(res, 503, { ok: false, error: "Economy service is not configured." });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return send(res, 400, { ok: false, error: "Invalid JSON body." }); }
    }
    const session = typeof body?.session === "string" ? body.session : "";
    const action = typeof body?.action === "string" ? body.action : "";
    const key = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : "";
    if (!session || session.length > 10000 ||
        !/^[a-zA-Z0-9_-]{8,128}$/.test(key) ||
        !Object.prototype.hasOwnProperty.call(ACTIONS, action)) {
      return send(res, 400, { ok: false, error: "Valid session, action, and idempotency key are required." });
    }

    const verified = await fetch(`${VATAR_API}/session/verify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session })
    });
    if (!verified.ok) return send(res, 401, { ok: false, error: "Vatar session verification failed." });
    const player = await verified.json();
    if (player.mode !== "test" || typeof player.playerId !== "string" || !player.playerId ||
        typeof player.gameId !== "string" || !player.gameId) {
      return send(res, 403, { ok: false, error: "Valid Vatar test session required." });
    }

    const sql = neon(databaseUrl);
    const config = ACTIONS[action];
    // This route intentionally refuses to mutate un-migrated wallets.
    // No browser balance is trusted or imported here.
    const existing = await sql`
      SELECT balance, purchased_balance, status
      FROM public.cfc_wallets WHERE player_id = ${player.playerId} LIMIT 1
    `;
    if (!existing[0] || existing[0].status !== "active") {
      return send(res, 409, {
        ok: false,
        migrationRequired: true,
        error: "This wallet needs a reviewed legacy-save migration before economy actions can run."
      });
    }

    // Idempotent replay returns the original transaction, never pays twice.
    const replay = await sql`
      SELECT action, amount, balance_after
      FROM public.cfc_transactions
      WHERE player_id = ${player.playerId} AND idempotency_key = ${key}
      LIMIT 1
    `;
    if (replay[0]) {
      if (replay[0].action !== action) {
        return send(res, 409, { ok: false, error: "Idempotency key was already used for another action." });
      }
      return send(res, 200, {
        ok: true, replayed: true, action,
        amount: Number(replay[0].amount),
        balance: Number(replay[0].balance_after)
      });
    }

    // The balance lock and transaction record are handled by a single SQL
    // statement so concurrent requests cannot overspend or double-credit.
    const delta = config.type === "earn" ? config.amount : -config.amount;
    const rows = await sql`
      WITH locked AS (
        SELECT player_id, balance
        FROM public.cfc_wallets
        WHERE player_id = ${player.playerId} AND status = 'active'
        FOR UPDATE
      ),
      applied AS (
        UPDATE public.cfc_wallets w
        SET balance = w.balance + ${delta}, updated_at = NOW(), version = version + 1
        FROM locked l
        WHERE w.player_id = l.player_id
          AND ( ${delta} > 0 OR w.balance >= ${config.amount} )
          AND (
            ${config.type !== "earn"} OR
            (
              SELECT COUNT(*)
              FROM public.cfc_transactions t
              WHERE t.player_id = w.player_id
                AND t.action LIKE 'job_%'
                AND t.created_at >= date_trunc('day', NOW())
            ) < ${config.dailyLimit || 999999}
          )
        RETURNING w.player_id, w.balance
      ),
      recorded AS (
        INSERT INTO public.cfc_transactions
          (player_id, idempotency_key, action, amount, balance_after, metadata)
        SELECT player_id, ${key}, ${action}, ${delta}, balance,
               jsonb_build_object('mode', 'test')
        FROM applied
        RETURNING amount, balance_after
      )
      SELECT amount, balance_after FROM recorded
    `;
    if (!rows[0]) {
      return send(res, 409, { ok: false, error: "Insufficient CFC or wallet changed. Refresh and retry." });
    }
    return send(res, 200, {
      ok: true, replayed: false, action,
      amount: Number(rows[0].amount),
      balance: Number(rows[0].balance_after)
    });
  } catch {
    return send(res, 503, { ok: false, error: "Economy transaction failed. Retry with the same idempotency key." });
  }
};
