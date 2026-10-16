# Mission 07 Preview validation runbook

Status: draft implementation; do not merge or enable live purchases until every required check passes.

## Safety boundaries
- Work only on the `mission-07-server-wallet` branch and Preview deployment.
- Do not run SQL against Production.
- Do not create another Vatar purchase to test reconciliation. The existing starter-pack purchase already granted 1,000 CFC.
- Do not set a wallet to `active` using a browser-reported balance.
- Keep pull request #1 in draft until the checklist is complete.

## 1. Environment checks
- Confirm the Preview deployment is built from `mission-07-server-wallet`.
- Confirm Preview has `POSTGRES_URL` and the test-only `VATAR_SECRET`; never print either value.
- Confirm Production environment variables and deployment remain unchanged.
- Verify `/api/wallet` accepts POST only and rejects GET, and that all responses include `Cache-Control: no-store`.

## 2. Database migration (Preview only)
- Review `db/mission-07-cfc-wallet.sql` and take a Preview backup/export before applying.
- Apply the schema only to the verified Preview database.
- Confirm `cfc_wallets` and `cfc_transactions` exist and the daily-job counter constraint is enforced.
- Confirm no existing player balance was automatically copied from localStorage.
- Leave all new wallets in `migration_required` until a separately reviewed migration is approved.

## 3. Wallet API checks
Use a valid Vatar test session obtained from the game; never paste session tokens into logs or URLs.
- POST `/api/wallet` with a valid session: a new/unmigrated player should receive `migrationRequired: true`, not an invented balance.
- Invalid/expired session: expect 401.
- Live-mode session: expect 403.
- GET `/api/wallet`: expect 405.
- Ensure responses never expose SQL errors, secrets, or database URLs.

## 4. Economy API checks (only with an explicitly activated disposable test wallet)
- Job rewards must be server-defined: walk +45, clean +35, delivery +55, pet shop +65 CFC.
- A wallet must never go negative.
- Three jobs in one database-local calendar day may succeed; the fourth must fail, including concurrent requests.
- Repeat the same action with the same idempotency key: it must return the original transaction without changing the balance again.
- Reuse that key for a different action: expect 409.
- Insufficient balance: expect 409 and no ledger entry.
- Retry a transient failure with the same key; never mint a new key just because the response timed out.
- Verify ledger rows and wallet balance agree after each test.

## 5. Purchase reconciliation
- Inspect the existing `vatar_cfc_grants` and `vatar_cfc_wallets` records for the already-delivered starter pack.
- Confirm the unique purchase ID and 1,000 CFC grant match the verified Vatar purchase.
- Do not mirror the old aggregate purchased-CFC total into the new wallet until a transactionally safe, one-time reconciliation procedure exists.
- A purchase reported as delivered without a matching internal grant is a manual-review case.
- Test refunds and delivery retries using documented sandbox fixtures only; do not initiate a real or additional purchase.

## 6. Save migration and UI rollout
- Keep `canineFarmingSaveV1` untouched as a backup; do not overwrite it during wallet migration.
- Map the save to the verified Vatar player ID only through a reviewed process.
- Treat browser CFC and browser dog/kennel data as untrusted claims, not proof of value or ownership.
- Do not connect the gameplay UI until server-side dog ownership, kennel capacity, purchase prerequisites, and transaction/idempotency rules are implemented.
- After each UI change, verify old saves still load and the preview supports setup, care, jobs, dog purchase, kennel upgrade, and CFC purchase status without duplicate awards.

## Merge gate
Keep PR #1 draft until schema validation, API tests, purchase reconciliation, legacy-save handling, and end-to-end Preview tests are all documented as passing. Production stays untouched until the user explicitly approves a release after review.
