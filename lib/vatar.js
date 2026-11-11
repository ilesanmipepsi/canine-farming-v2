const { neon } = require("@neondatabase/serverless");

const VATAR_API = "https://lagoslife.app/api/games/v1";
const PRODUCT_ID = "cfc_starter_pack";
const PRICE_NAIRA = 100;
const CFC_REWARD = 1000;

function apiCredential(mode) {
  if (mode === "live") {
    return process.env.VATAR_LIVE_SECRET || null;
  }
  if (mode === "test") {
    return process.env.VATAR_TEST_SECRET ||
      (process.env.VERCEL_ENV === "production" ? null : process.env.VATAR_SECRET) ||
      null;
  }
  return null;
}

function webhookCredential(mode) {
  if (mode === "live") {
    return process.env.VATAR_LIVE_WEBHOOK_SECRET || null;
  }
  if (mode === "test") {
    return process.env.VATAR_TEST_WEBHOOK_SECRET ||
      (process.env.VERCEL_ENV === "production" ? null : process.env.VATAR_WEBHOOK_SECRET) ||
      null;
  }
  return null;
}

function configuredModes() {
  return ["live", "test"].filter(mode => !!apiCredential(mode));
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function verifySession(session) {
  for (const mode of configuredModes()) {
    const secret = apiCredential(mode);
    const response = await fetch(VATAR_API + "/session/verify", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ session })
    });

    if (!response.ok) {
      if (response.status >= 500) {
        throw new Error("Vatar session service unavailable.");
      }
      continue;
    }

    const player = await readJson(response);
    if (
      player &&
      player.mode === mode &&
      typeof player.playerId === "string" &&
      player.playerId &&
      typeof player.gameId === "string" &&
      player.gameId
    ) {
      return { player, mode, secret };
    }
  }

  return null;
}

async function fetchPurchase(purchaseId, secret) {
  const response = await fetch(
    VATAR_API + "/purchases/" + encodeURIComponent(purchaseId),
    { headers: { Authorization: `Bearer ${secret}` } }
  );
  const purchase = await readJson(response);
  return { response, purchase };
}

function validatePurchase(purchase, purchaseId, playerId, mode) {
  if (!purchase || purchase.id !== purchaseId) {
    return "Purchase could not be verified.";
  }
  if (purchase.status === "refunded") {
    return "Refunded purchases cannot receive CFC.";
  }
  if (
    purchase.playerId !== playerId ||
    purchase.productId !== PRODUCT_ID ||
    Number(purchase.amount) !== PRICE_NAIRA ||
    purchase.currency !== "NGN" ||
    purchase.mode !== mode
  ) {
    return "Purchase details do not match this offer, player and mode.";
  }
  if (!["paid", "delivered"].includes(purchase.status)) {
    return "Purchase is not paid.";
  }
  return null;
}

async function grantAndDeliver(purchase, playerId, secret) {
  const databaseUrl = process.env.POSTGRES_URL;
  if (!databaseUrl) {
    return { ok: false, http: 503, error: "Database connection is not configured." };
  }

  const sql = neon(databaseUrl);
  const purchaseId = purchase.id;
  const existingRows = await sql`
    SELECT player_id, product_id, cfc_amount, status
    FROM public.vatar_cfc_grants
    WHERE vatar_purchase_id = ${purchaseId}
    LIMIT 1
  `;

  let grant = existingRows[0];
  let newlyGranted = false;

  if (purchase.status === "delivered" && !grant) {
    return {
      ok: false,
      http: 409,
      error: "Vatar reports this purchase delivered but no grant record exists. Manual review is required."
    };
  }

  if (grant) {
    if (
      grant.player_id !== playerId ||
      grant.product_id !== PRODUCT_ID ||
      Number(grant.cfc_amount) !== CFC_REWARD ||
      grant.status === "rejected"
    ) {
      return { ok: false, http: 409, error: "Purchase conflicts with its existing grant record." };
    }
  } else {
    const grantResult = await sql`
      WITH new_grant AS (
        INSERT INTO public.vatar_cfc_grants
          (vatar_purchase_id, player_id, product_id, cfc_amount, status)
        VALUES
          (${purchaseId}, ${playerId}, ${PRODUCT_ID}, ${CFC_REWARD}, 'verified')
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
              public.vatar_cfc_wallets.purchased_cfc + EXCLUDED.purchased_cfc,
            updated_at = NOW()
        RETURNING player_id
      )
      SELECT EXISTS (SELECT 1 FROM new_grant) AS newly_granted
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
      grant.player_id !== playerId ||
      grant.product_id !== PRODUCT_ID ||
      Number(grant.cfc_amount) !== CFC_REWARD ||
      grant.status === "rejected"
    ) {
      return { ok: false, http: 409, error: "Purchase conflicts with an existing grant record." };
    }
    newlyGranted = grantResult[0]?.newly_granted === true;
  }

  if (purchase.status === "paid") {
    const deliveryResponse = await fetch(
      VATAR_API + "/purchases/" + encodeURIComponent(purchaseId) + "/deliver",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` }
      }
    );

    if (!deliveryResponse.ok) {
      return {
        ok: false,
        http: 503,
        retryable: true,
        error: "The CFC grant is recorded, but Vatar delivery is pending. Retry safely."
      };
    }
  }

  await sql`
    UPDATE public.vatar_cfc_grants
    SET status = 'delivered',
        delivered_at = COALESCE(delivered_at, NOW())
    WHERE vatar_purchase_id = ${purchaseId}
      AND player_id = ${playerId}
      AND product_id = ${PRODUCT_ID}
      AND status <> 'rejected'
  `;

  const walletRows = await sql`
    SELECT purchased_cfc
    FROM public.vatar_cfc_wallets
    WHERE player_id = ${playerId}
    LIMIT 1
  `;

  return {
    ok: true,
    newlyGranted,
    rewardCfc: CFC_REWARD,
    purchasedCfc: Number(walletRows[0]?.purchased_cfc ?? 0),
    productId: PRODUCT_ID
  };
}

module.exports = {
  apiCredential,
  webhookCredential,
  configuredModes,
  verifySession,
  fetchPurchase,
  validatePurchase,
  grantAndDeliver
};
