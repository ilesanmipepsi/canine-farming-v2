const { neon } = require("@neondatabase/serverless");
const VATAR_API = "https://lagoslife.app/api/games/v1";

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
    const existing = await sql`
      SELECT status FROM public.cfc_wallets
      WHERE player_id = ${player.playerId} LIMIT 1
    `;
    if (!existing[0] || existing[0].status !== "active") {
      return send(res, 409, {
        ok: false,
        migrationRequired: true,
        error: "This wallet needs a reviewed legacy-save migration before economy actions can run."
      });
    }

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

    const isJob = config.dailyLimit !== undefined;
    const delta = config.type === "earn" ? config.amount : -config.amount;

    // The wallet row itself stores the daily job counter. Its conditional
    // UPDATE is atomic, so parallel job requests cannot exceed the daily cap.
    // A unique ledger key prevents duplicate credits; concurrent retries that
    // race on that key should retry using the same key after a transient error.
    const rows = await sql`
      WITH applied AS (
        UPDATE public.cfc_wallets w
        SET balance = w.balance + ${delta},
            daily_jobs_count = CASE
              WHEN ${isJob} THEN
                CASE WHEN w.daily_jobs_date = CURRENT_DATE
                     THEN w.daily_jobs_count + 1 ELSE 1 END
              ELSE w.daily_jobs_count
            END,
            daily_jobs_date = CASE
              WHEN ${isJob} THEN CURRENT_DATE ELSE w.daily_jobs_date
            END,
            updated_at = NOW(),
            version = w.version + 1
        WHERE w.player_id = ${player.playerId}
          AND w.status = 'active'
          AND (${delta} > 0 OR w.balance >= ${config.amount})
          AND (
            NOT ${isJob} OR
            (CASE WHEN w.daily_jobs_date = CURRENT_DATE
                  THEN w.daily_jobs_count ELSE 0 END) < ${config.dailyLimit || 999999}
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
      return send(res, 409, {
        ok: false,
        error: isJob
          ? "Daily job limit reached or wallet unavailable. Refresh and retry."
          : "Insufficient CFC or wallet changed. Refresh and retry."
      });
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
