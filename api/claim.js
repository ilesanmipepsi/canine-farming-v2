const { neon } = require("@neondatabase/serverless");

const VATAR_API = "https://lagoslife.app/api/games/v1";
const PRODUCT_ID = "cfc_starter_pack";
const PRICE_NAIRA = 100;
const CFC_REWARD = 1000;

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  const secret = process.env.VATAR_SECRET;
  const databaseUrl = process.env.POSTGRES_URL;

  if (!secret || !databaseUrl) {
    return res.status(503).json({
      ok: false,
      error: "Server configuration incomplete"
    });
  }

  try {
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          ok: false,
          error: "Invalid JSON body"
        });
      }
    }

    const session =
      body && typeof body.session === "string"
        ? body.session
        : "";

    const purchaseId =
      body && typeof body.purchaseId === "string"
        ? body.purchaseId
        : "";

    if (
      !session ||
      session.length > 10000 ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(purchaseId)
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid request"
      });
    }

    const headers = {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json"
    };

    // Step 1: Verify the Vatar session.
    const sessionResponse = await fetch(
      `${VATAR_API}/session/verify`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ session })
      }
    );

    if (!sessionResponse.ok) {
      return res.status(401).json({
        ok: false,
        error: "Session verification failed"
      });
    }

    const player = await sessionResponse.json();

    if (
      player.mode !== "test" ||
      typeof player.playerId !== "string" ||
      !player.playerId ||
      typeof player.gameId !== "string" ||
      !player.gameId
    ) {
      return res.status(403).json({
        ok: false,
        error: "A valid test session is required"
      });
    }

    // Step 2: Verify the purchase directly with Vatar.
    const purchaseResponse = await fetch(
      `${VATAR_API}/purchases/${encodeURIComponent(purchaseId)}`,
      { headers }
    );

    if (!purchaseResponse.ok) {
      return res.status(409).json({
        ok: false,
        error: "Purchase could not be verified"
      });
    }

    const purchase = await purchaseResponse.json();

    if (
      purchase.id !== purchaseId ||
      purchase.playerId !== player.playerId ||
      purchase.productId !== PRODUCT_ID ||
      purchase.amount !== PRICE_NAIRA ||
      purchase.currency !== "NGN" ||
      purchase.mode !== "test" ||
      !["paid", "delivered"].includes(purchase.status)
    ) {
      return res.status(409).json({
        ok: false,
        error: "Purchase does not match this test reward"
      });
    }

    const sql = neon(databaseUrl);

    // Step 3: Atomically create a unique grant and credit
    // the server-side wallet only when that grant is new.
    const grantResult = await sql`
      WITH new_grant AS (
        INSERT INTO public.vatar_cfc_grants (
          vatar_purchase_id,
          player_id,
          product_id,
          cfc_amount,
          status
        )
        VALUES (
          ${purchaseId},
          ${player.playerId},
          ${PRODUCT_ID},
          ${CFC_REWARD},
          'verified'
        )
        ON CONFLICT (vatar_purchase_id) DO NOTHING
        RETURNING player_id, cfc_amount
      ),
      wallet_credit AS (
        INSERT INTO public.vatar_cfc_wallets (
          player_id,
          purchased_cfc,
          updated_at
        )
        SELECT
          player_id,
          cfc_amount,
          NOW()
        FROM new_grant
        ON CONFLICT (player_id)
        DO UPDATE SET
          purchased_cfc =
            public.vatar_cfc_wallets.purchased_cfc
            + EXCLUDED.purchased_cfc,
          updated_at = NOW()
        RETURNING player_id
      )
      SELECT EXISTS (
        SELECT 1 FROM new_grant
      ) AS newly_granted
    `;

    const newlyGranted =
      grantResult[0]?.newly_granted === true;

    // Step 4: Confirm that any existing grant belongs
    // to this exact player and product.
    const existing = await sql`
      SELECT player_id, product_id, cfc_amount, status
      FROM public.vatar_cfc_grants
      WHERE vatar_purchase_id = ${purchaseId}
      LIMIT 1
    `;

    const grant = existing[0];

    if (
      !grant ||
      grant.player_id !== player.playerId ||
      grant.product_id !== PRODUCT_ID ||
      Number(grant.cfc_amount) !== CFC_REWARD ||
      grant.status === "rejected"
    ) {
      return res.status(409).json({
        ok: false,
        error: "Purchase grant conflict"
      });
    }

    // Step 5: Ask Vatar to mark the purchase delivered.
    // A retry cannot credit the same purchase a second time.
    if (purchase.status === "paid") {
      const deliveryResponse = await fetch(
        `${VATAR_API}/purchases/${encodeURIComponent(purchaseId)}/deliver`,
        {
          method: "POST",
          headers
        }
      );

      if (!deliveryResponse.ok) {
        return res.status(503).json({
          ok: false,
          error: "Reward recorded; delivery confirmation pending"
        });
      }

      await sql`
        UPDATE public.vatar_cfc_grants
        SET status = 'delivered',
            delivered_at = COALESCE(delivered_at, NOW())
        WHERE vatar_purchase_id = ${purchaseId}
          AND player_id = ${player.playerId}
          AND product_id = ${PRODUCT_ID}
      `;
    } else if (grant.status !== "delivered") {
      // Vatar already reports delivery, so synchronize our
      // record without issuing another wallet credit.
      await sql`
        UPDATE public.vatar_cfc_grants
        SET status = 'delivered',
            delivered_at = COALESCE(delivered_at, NOW())
        WHERE vatar_purchase_id = ${purchaseId}
          AND player_id = ${player.playerId}
          AND product_id = ${PRODUCT_ID}
      `;
    }

    // Step 6: Return the server-side purchased balance.
    const wallet = await sql`
      SELECT purchased_cfc
      FROM public.vatar_cfc_wallets
      WHERE player_id = ${player.playerId}
      LIMIT 1
    `;

    return res.status(200).json({
      ok: true,
      newlyGranted,
      rewardCfc: CFC_REWARD,
      purchasedCfc: Number(wallet[0]?.purchased_cfc ?? 0),
      productId: PRODUCT_ID
    });
  } catch {
    return res.status(503).json({
      ok: false,
      error: "Purchase claim could not be completed"
    });
  }
};
