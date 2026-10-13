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
    const body = req.body;
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
      !/^[a-fA-F0-9]{16,128}$/.test(purchaseId)
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

    // Verify the player's current Vatar session.
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
      !player.gameId
    ) {
      return res.status(403).json({
        ok: false,
        error: "Test session required"
      });
    }

    // Retrieve the purchase directly from Vatar.
    const purchaseResponse = await fetch(
      `${VATAR_API}/purchases/${purchaseId}`,
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
        error: "Purchase does not match this reward"
      });
    }

    const sql = neon(databaseUrl);

    // One atomic statement:
    // a new purchase creates one grant and credits one wallet.
    // A repeated purchase ID cannot credit the wallet again.
    const result = await sql`
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
      credit AS (
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
      SELECT
        EXISTS (SELECT 1 FROM new_grant) AS newly_granted,
        EXISTS (SELECT 1 FROM credit) AS wallet_credited
    `;

    const newlyGranted = result[0]?.newly_granted === true;

    // Confirm the existing record belongs to this same player/product.
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
      Number(grant.cfc_amount) !== CFC_REWARD
    ) {
      return res.status(409).json({
        ok: false,
        error: "Purchase grant conflict"
      });
    }

    // Tell Vatar the purchase has been delivered.
    // If this call fails, the grant remains recorded.
    // A retry won't credit the same purchase twice.
    if (purchase.status === "paid") {
      const deliveryResponse = await fetch(
        `${VATAR_API}/purchases/${purchaseId}/deliver`,
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
    }

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
