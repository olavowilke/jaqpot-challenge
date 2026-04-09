# Jaqpot — Casino & Game Provider Integration

A single Node.js + TypeScript service that simulates **both** sides of an
online casino ↔ game provider integration. Casino and Provider live in the
same process and same Postgres database, but are logically separated:

| Concern        | Casino                | Provider              |
| -------------- | --------------------- | --------------------- |
| Routes         | `/casino/*`           | `/provider/*`         |
| Tables         | `casino_*`            | `provider_*`          |
| HMAC header    | `x-casino-signature`  | `x-provider-signature`|
| HMAC secret    | `CASINO_SECRET`       | `PROVIDER_SECRET`     |

The Casino is the source of truth for wallet balances. The Provider runs
game rounds and calls back into the Casino to debit, credit, and rollback.
The Provider resolves each casino's API endpoint and HMAC secret from its
own `provider_casinos` directory table — there is no env-level coupling
between provider and casino.

## Stack
- Node 18+, TypeScript, Express
- PostgreSQL via **TypeORM** (entities + migrations, `EntityManager.transaction` with `pessimistic_write` locks)
- HMAC-SHA256 signing over the **raw request bytes**
- `vitest` + **Testcontainers** for tests (each test run gets a throwaway Postgres container)

## Setup

```bash
# 1. Postgres for manual / Postman use (tests don't need this — they spin
#    up their own throwaway container via Testcontainers)
docker compose up -d

# 2. Env
cp .env.example .env
# Edit CASINO_SECRET / PROVIDER_SECRET if you want — the seed step below
# will align provider_casinos.casino_secret with whatever you set.

# 3. Install + migrate (creates schema + seeds + aligns provider_casinos
#    to your current .env)
npm install
npm run migrate

# 4. Run
npm run dev
```

After this, the DB is fully populated for manual testing — no CRUD UI is
needed to create casinos / games / users / wallets. See **Seed data** below
for the IDs.

If you later edit `CASINO_SECRET` or `CASINO_BASE_URL` in `.env`, re-align
the directory row (migrations only run once):

```bash
npm run seed
```

## Run a full simulated round

The endpoint accepts an empty body — every field has a default
(`casinoCode → JAQPOT`, then `launchGame` defaults `userId`, `gameId`,
`currency` to the seeded values).

**bash/zsh:**
```bash
curl -s -X POST http://localhost:3000/casino/simulateRound \
  -H 'content-type: application/json' -d '{}' | jq
```

**PowerShell**
```powershell
curl.exe -s -X POST http://localhost:3000/casino/simulateRound `
  -H "content-type: application/json" -d "{}"
```

This single call:
1. `/casino/launchGame` → creates a casino session, calls `/provider/launch`.
2. `/provider/simulate` looks up `JAQPOT` in `provider_casinos`, signs every
   callback with the row's `casino_secret`, and runs the scripted demo flow:
   - balance check
   - debit #1 (bet)
   - debit #2 (bet)
   - credit (win, linked to debit #1)
   - rollback (of debit #2)
   - final balance check
3. Returns a trace with `initialBalance`, `finalBalance`, `expectedBalance`, and `consistent: true`.

Expected math (with seed wallet of 100000):
`final = initial − bet1 − bet2 + win + bet2(rollback) = initial − bet1 + win`
= `100000 − 500 + 1200 = 100700`.

You can also pass an explicit `casinoCode` (defaults to `JAQPOT`):

```bash
# bash
curl -s -X POST http://localhost:3000/casino/simulateRound \
  -H 'content-type: application/json' \
  -d '{"casinoCode":"JAQPOT"}' | jq
```

```powershell
# PowerShell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/casino/simulateRound `
  -ContentType 'application/json' -Body '{"casinoCode":"JAQPOT"}'
```

## Postman

A ready-to-use collection lives at `postman_collection.json`. Import it
into Postman, then:

1. Open the collection's **Variables** tab and confirm `casinoBaseUrl`,
   `providerBaseUrl`, `casinoSecret` (= your `.env CASINO_SECRET`), and
   `providerSecret` (= your `.env PROVIDER_SECRET`) match your running app.
2. Run **Casino - launchGame** first — its test script auto-saves
   `sessionToken`, `providerSessionId`, `customerId`, and
   `providerInternalGameId` into collection variables.
3. Run any of the HMAC-protected requests — a pre-request script signs the
   raw body with the matching secret and sets the right header for you.

The simplest end-to-end smoke test is just **Casino - simulateRound**,
which doesn't require HMAC and exercises the whole flow in one shot.

## Seed data

`npm run migrate` (and `npm run seed`) populate the following well-known
rows so you can hit the endpoints immediately:

| Table                   | UUID                                   | Notes                                                  |
| ----------------------- | -------------------------------------- | ------------------------------------------------------ |
| `casino_users`          | `11111111-1111-1111-1111-111111111111` | demo_user                                              |
| `casino_wallets`        | `22222222-2222-2222-2222-222222222222` | USD, balance 100000                                    |
| `casino_game_providers` | `33333333-3333-3333-3333-333333333333` | code `JAQPOT`                                          |
| `casino_games`          | `44444444-4444-4444-4444-444444444444` | `slot-001`, min 100 / max 50000                        |
| `provider_games`        | `55555555-5555-5555-5555-555555555555` | `slot-001`                                             |
| `provider_casinos`      | `66666666-6666-6666-6666-666666666666` | `JAQPOT`, `casino_secret` aligned to your `.env`       |

## Idempotency

All money-moving casino callbacks (`/casino/debit`, `/casino/credit`,
`/casino/rollback`) require a unique `transactionId`. Each handler runs
inside `AppDataSource.transaction(...)`:

- Looks up `casino_transactions.external_transaction_id` first; if found,
  returns the cached `response_cache` envelope **but with the wallet's
  current `playable_balance`** so a replay reflects intervening state.
- Loads the wallet with `lock: { mode: 'pessimistic_write' }` (TypeORM
  emits `SELECT ... FOR UPDATE` under the hood).
- Inserts the ledger row in the **same** transaction as the balance
  update. The `UNIQUE` constraint on `external_transaction_id` is the
  final guard against concurrent retries — unique-violation errors are
  caught and converted into a cached-response replay.

Failed debits (insufficient funds) are also cached, so a retry of the
same request returns the same `INSUFFICIENT_FUNDS` envelope rather than
newly succeeding under a race.

## Rollback rules

- Only `DEBIT` rows can be rolled back.
- A rollback is rejected if a `CREDIT` already exists with
  `related_external_transaction_id = originalTransactionId`.
- **Tombstone:** if the original transaction is not found, the rollback
  inserts a `ROLLBACK_TOMBSTONE` ledger row, returns success, and changes
  no balances. This makes the operation idempotent and auditable even
  when the original bet never reached the casino.

## Provider casino directory

`/provider/launch` and `/provider/simulate` both look up the calling
casino in `provider_casinos` by `casino_code`:

| Column                | Notes                                                              |
| --------------------- | ------------------------------------------------------------------ |
| `id`                  | UUID                                                               |
| `casino_code`         | unique business code (e.g. `JAQPOT`)                               |
| `name`                | display name                                                       |
| `casino_api_endpoint` | base URL the provider POSTs callbacks to                           |
| `casino_secret`       | HMAC secret used to sign provider→casino callbacks                 |
| `is_active`           | inactive casinos cause `409 CASINO_INACTIVE`                       |
| `created_at`          | timestamp                                                          |

Unknown codes return `404 CASINO_NOT_FOUND`. `provider_customers` is keyed
on this row's UUID via the `casino_id` FK (the old free-text `casino_code`
column was dropped in migration `1700000000002-ProviderCasinos`).

## Security model

`shared/hmac.ts` exposes `signString`, `signBuffer`, `verifySignature`
(constant-time compare). Express captures the raw body buffer in
`express.json({ verify })` so verification operates on the exact bytes
the sender signed — no JSON re-stringification.

Direction of calls:

| Direction          | URL family    | Header sent            | Secret source                                    |
| ------------------ | ------------- | ---------------------- | ------------------------------------------------ |
| Provider → Casino  | `/casino/*`   | `x-casino-signature`   | `provider_casinos.casino_secret` (per casino)    |
| Casino → Provider  | `/provider/*` | `x-provider-signature` | `PROVIDER_SECRET` env var                        |

Client-facing endpoints (`/casino/launchGame`, `/casino/simulateRound`)
do not require an HMAC header — they represent the trusted frontend
surface.

When `/provider/simulate` receives a non-2xx from a casino callback, it
bubbles the upstream error in the message — e.g. `"BALANCE_CHECK_FAILED:
getBalance failed — casino returned 404 SESSION_NOT_FOUND: Session not
found"` — so failures are self-diagnosing.

## Tests

```bash
npm test
```

The test runner spins up a throwaway Postgres container via Testcontainers,
runs the real migrations against it, boots the app on an ephemeral port,
runs the suite, then tears it all down. **A running Docker daemon is the
only prerequisite** — your dev `docker compose` Postgres is never touched
by tests.

Coverage:
- end-to-end `simulateRound` balance arithmetic
- debit/credit idempotency replays (including the "live balance on replay"
  guarantee — replaying a tx after intervening state returns the *current*
  balance, not a stale snapshot)
- insufficient-funds caching and 402 replay
- concurrent-retry race (8 parallel debits → 1 ledger row, 1 balance move)
- rollback rules: refund, tombstone, rollback-of-credit rejection,
  rollback-after-payout rejection
- HMAC negative cases on both directions (missing, tampered, wrong-secret)
- `provider_casinos` directory: unknown casino → 404, inactive → 409,
  `provider_customers.casino_id` is correctly populated via the FK

## Project layout

```
src/
  index.ts              express bootstrap + DataSource init
  config.ts             env validation (zod)
  db/
    data-source.ts      TypeORM DataSource (entities + migrations registered)
    migrations/
      1700000000000-Init.ts             schema
      1700000000001-Seed.ts             casino-side seed rows
      1700000000002-ProviderCasinos.ts  provider_casinos table + customer FK
      1700000000003-DevSeedAlign.ts     env-driven alignment of provider_casinos
  entities/
    casino.ts           CasinoUser, CasinoWallet, CasinoGameProvider,
                        CasinoGame, CasinoGameSession, CasinoTransaction
    provider.ts         ProviderGame, ProviderCasino, ProviderCustomer,
                        ProviderGameRound, ProviderBet
    transformers.ts     bigint <-> number transformer
  shared/
    hmac.ts             sign/verify + middleware
    http.ts             signedPost
    errors.ts           AppError + middleware
  casino/
    routes.ts           launchGame, getBalance, debit, credit, rollback, simulateRound
  provider/
    routes.ts           launch, simulate
scripts/
  migrate.ts            runs AppDataSource.runMigrations()
  seed.ts               idempotent re-seed + provider_casinos re-alignment
  test.ts               delegates to vitest (Testcontainers handles Postgres)
tests/
  hmac.test.ts
  simulate.e2e.test.ts
postman_collection.json runnable Postman collection for manual testing
```

## Notes / out of scope
- No frontend / no real auth on the client-facing launch endpoint.
- Single currency (USD) and single seeded user/game for the demo.
- No real retry worker — provider retries are exercised by the
  idempotency tests, not a background loop.
- No CRUD endpoints for managing casinos / games / wallets — those are
  populated entirely by migrations + the `npm run seed` script.
