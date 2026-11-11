# Canine Farming — Vatar Live Migration

This branch contains the Live/Test purchase migration. It is not approved for production until the sandbox checklist below passes.

## Vercel environment variables

Keep all credentials server-side. Never add them to `index.html`, commit them, or send their values in chat.

| Variable | Vercel environment | Purpose |
|---|---|---|
| `POSTGRES_URL` | Production and Preview | Existing Neon database connection |
| `VATAR_TEST_SECRET` | Preview | Test-mode session and purchase API |
| `VATAR_TEST_WEBHOOK_SECRET` | Preview | Test webhook HMAC verification |
| `VATAR_LIVE_SECRET` | Production | Live-mode session and purchase API |
| `VATAR_LIVE_WEBHOOK_SECRET` | Production | Live webhook HMAC verification |

The old `VATAR_SECRET` and `VATAR_WEBHOOK_SECRET` names are accepted only as non-production Test fallbacks. In Production, the code does not use those legacy variables for Test mode.

## Endpoints

- `POST /api/claim` — verifies a player's signed session, checks the purchase with Vatar, grants CFC once, and marks the purchase delivered.
- `POST /api/wallet` — verifies the signed session and returns the server-side purchased-CFC total for wallet reconciliation.
- `POST /api/vatar-webhook` — verifies the raw-body `X-Vatar-Signature` HMAC-SHA256 signature, fetches the purchase independently, grants/delivers it, and records the webhook delivery ID.

The webhook endpoint creates `public.vatar_webhook_events` if it does not already exist. Existing `vatar_cfc_grants` and `vatar_cfc_wallets` tables remain in use.

## Purchase configuration

The server currently validates the existing product:
- Product ID: `cfc_starter_pack`
- Price: NGN 100
- Reward: 1,000 CFC

Vatar should have this configured as a one-off product if the intended rule is one purchase per player. The platform enforces one-off ownership; the server independently validates product ID, amount, currency, player and mode.

## Sandbox test checklist

1. Add Test credentials to Vercel Preview only.
2. Confirm the preview initializes in Vatar sandbox mode.
3. Confirm a Test purchase grants exactly 1,000 CFC.
4. Retry the same purchase claim and confirm no duplicate credit.
5. Confirm the purchased-CFC balance reconciles after a reload.
6. Confirm a different player's session cannot claim the purchase.
7. Use Vatar's Send test webhook button and confirm a signed Test event is accepted.
8. Confirm a modified/invalid webhook signature is rejected.
9. Confirm the Vatar delivery status becomes delivered.

## Production activation

Only after Preview passes:
1. Add the Live API secret and Live webhook signing secret to Vercel Production.
2. Deploy the reviewed code to Production.
3. Register the public HTTPS webhook URL `/api/vatar-webhook` in Vatar.
4. Verify the Live webhook using Vatar's dashboard test facility where supported.
5. Run a real-money purchase only with explicit approval and a planned test account.

Do not change the existing production `VATAR_SECRET` value as a substitute for adding `VATAR_LIVE_SECRET`. Do not merge this branch until sandbox testing is complete.
