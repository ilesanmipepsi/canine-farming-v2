const { neon } = require("@neondatabase/serverless");

const VATAR_API = "https://lagoslife.app/api/games/v1";
const PRODUCT_ID = "cfc_starter_pack";
const PRICE_NAIRA = 100;
const CFC_REWARD = 1000;

function send(res, status, payload) {
  return res.status(status).json(payload);
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, {
      ok: false,
      error: "Method not allowed."
    });
  }

  const secret = process.env.VATAR_SECRET;
  const databaseUrl = process.env.POSTGRES_URL;

  if (!secret || !databaseUrl) {
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
        return send(res, 400, {
          ok: false,
          error: "Invalid JSON body."
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
      return send(res, 400, {
        ok: false,
        error: "A valid session and purchase ID are required."
      });
    }

    const headers = {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json"
    };

    // Verify the player's session with Vatar.
    const sessionResponse = await fetch(
      `${VATAR_API}/session/verify`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ session })
      }
    );

    if (!sessionResponse.ok) {
      return send(res, 401, {
        ok: false,
        error: "Vatar session verification failed."
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
      return send(res, 403, {
        ok: false,
        error: "This session is not a valid test-game session."
      });
    }

    // Ask Vatar to verify the purchase.
    const purchaseResponse = await fetch(
      `${VATAR_API}/purchases/${encodeURIComponent(purchaseId)}`,
      { headers }
    );

    if (!purchaseResponse.ok) {
      return send(res, 409, {
        ok: false,
        error: "Purchase could not be verified."
      });
    }

    const purchase = await purchaseResponse.json();

    if (
      purchase.id !== purchaseId ||
      purchase.playerId !== player.playerId ||
      purchase.productId !== PRODUCT_ID ||
      Number(purchase.amount) !== PRICE_NAIRA ||
      purchase.currency !== "NGN" ||
      purchase.mode !== "test"
    ) {
      return send(res, 409, {
        ok: false,
        error: "Purchase details do not match this offer and player."
      });
    }

    if (purchase.status === "refunded") {
      return send(res, 409, {
        ok: false,
        error: "Refunded purchases cannot receive CFC."
      });
    }

    if (!["paid", "delivered"].includes(purchase.status)) {
      return send(res, 409, {
        ok: false,
        error: "Purchase is not paid."
      });
    }

    const sql = neon(databaseUrl);

    // A delivered purchase must already have our grant record.
    const existingRows = await sql`
      SELECT player_id, product_id, cfc_amount, status
      FROM public.vatar_cfc_grants
      WHERE vatar_purchase_id = ${purchaseId}
      LIMIT 1
    `;

    let grant = existingRows[0];
    let newlyGranted = false;

    if (purchase.status === "delivered" && !grant) {
      return send(res, 409, {
        ok: false,
        error:
          "Purchase is already delivered but no matching grant record exists. Manual review is required."
      });
    }

    if (grant) {
      if (
        grant.player_id !== player.playerId ||
        grant.product_id !== PRODUCT_ID ||
        Number(grant.cfc_amount) !== CFC_REWARD ||
        grant.status === "rejected"
      ) {
        return send(res, 409, {
          ok: false,
          error: "Purchase conflicts with the existing grant record."
        });
      }
    } else {
      // The unique purchase ID prevents duplicate wallet credits.
      const grantResult = await sql`
        WITH new_grant AS (
          INSERT INTO public.vatar_cfc_grants
            (vatar_purchase_id, player_id, product_id, cfc_amount, status)
          VALUES
            (${purchaseId}, ${player.playerId}, ${PRODUCT_ID},
             ${CFC_REWARD}, 'verified')
          ON CONFLICT (vatar_purchase_id) DO NOTHING
          RETURNING player_id, cfc_amount
        ),
        wallet_credit AS (
          INSERT INTO public.vatar_cfc_wallets
            (player_id, purchased_cfc, updated_at)
          SELECT player_id, cfc_amount, NOW()
          FROM new_grant
          ON CONFLICT (player_id) DO UPDATE
          SET purchased_cfc =
                public.vatar_cfc_wallets.purchased_cfc
                + EXCLUDED.purchased_cfc,
              updated_at = NOW()
          RETURNING player_id
        )
        SELECT EXISTS (
          SELECT 1 FROM new_grant
        ) AS newly_granted
      `;

      const confirmedRows = await sql`
        SELECT player_id, product_id, cfc_amount, status
        FROM public.vatar_cfc_grants
        WHERE vatar_purchase_id = ${purchaseId}
        LIMIT 1
      `;

      grant = confirmedRows[0];

      if (
        !grant ||
        grant.player_id !== player.playerId ||
        grant.product_id !== PRODUCT_ID ||
        Number(grant.cfc_amount) !== CFC_REWARD ||
        grant.status === "rejected"
      ) {
        return send(res, 409, {
          ok: false,
          error: "Purchase conflicts with an existing grant record."
        });
      }

      newlyGranted =
        grantResult[0]?.newly_granted === true;
    }

    // Retry delivery safely if Vatar still reports "paid".
    if (purchase.status === "paid") {
      const deliveryResponse = await fetch(
        `${VATAR_API}/purchases/${encodeURIComponent(purchaseId)}/deliver`,
        {
          method: "POST",
          headers
        }
      );

      if (!deliveryResponse.ok) {
        return send(res, 503, {
          ok: false,
          error:
            "CFC grant is recorded, but Vatar delivery is pending. Retry this claim.",
          retryable: true
        });
      }
    }

    await sql`
      UPDATE public.vatar_cfc_grants
      SET status = 'delivered',
          delivered_at = COALESCE(delivered_at, NOW())
      WHERE vatar_purchase_id = ${purchaseId}
        AND player_id = ${player.playerId}
        AND product_id = ${PRODUCT_ID}
        AND status <> 'rejected'
    `;

    const walletRows = await sql`
      SELECT purchased_cfc
      FROM public.vatar_cfc_wallets
      WHERE player_id = ${player.playerId}
      LIMIT 1
    `;

    return send(res, 200, {
      ok: true,
      newlyGranted,
      rewardCfc: CFC_REWARD,
      purchasedCfc: Number(
        walletRows[0]?.purchased_cfc ?? 0
      ),
      productId: PRODUCT_ID
    });
  } catch {
    // Never expose internal errors, database URLs, or secrets.
    return send(res, 503, {
      ok: false,
      error:
        "Purchase claim could not be completed. Please retry."
    });
  }
};
