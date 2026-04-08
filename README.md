# Jaqpot — Casino & Game Provider Integration

A single Node.js + TypeScript service that simulates **both** sides of an
online casino ↔ game provider integration. Casino and Provider live in the
same process and same Postgres database, but are logically separated:

| Concern        | Casino                | Provider              |
| -------------- | --------------------- | --------------------- |
| Routes         | `/casino/*`           | `/provider/*`         |
| Tables         | `CASINO_*`            | `PROVIDER_*`          |
| HMAC header    | `x-casino-signature`  | `x-provider-signature`|
| HMAC secret    | `CASINO_SECRET`       | `PROVIDER_SECRET`     |

The Casino is the source of truth for wallet balances. The Provider runs
game rounds and calls back into the Casino to debit, credit, and rollback.

## Stack
- Node 18+, TypeScript, Express
- PostgreSQL via **TypeORM** (entities + migrations, `EntityManager.transaction` with `pessimistic_write` locks)
- HMAC-SHA256 signing over the **raw request bytes**
- `vitest` for tests

## Setup

```bash
# 1. Postgres (docker)
docker compose up -d

# 2. Env
cp .env.example .env

# 3. Install + migrate (creates schema + seed)
npm install
npm run migrate

# 4. Run
npm run dev
```

## Run a full simulated round

```bash
curl -s -X POST http://localhost:3000/casino/simulateRound \
  -H 'content-type: application/json' -d '{}' | jq
```

This single call:
1. `/casino/launchGame` → creates a casino session, calls `/provider/launch`.
2. `/provider/simulate` runs the scripted demo flow, calling back into the casino:
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

## Idempotency

All money-moving casino callbacks (`/casino/debit`, `/casino/credit`,
`/casino/rollback`) require a unique `transactionId`. Each handler runs
inside `AppDataSource.transaction(...)`:

- Looks up `casino_transactions.external_transaction_id` first; if found,
  returns the cached `response_cache` verbatim with no balance change.
- Loads the wallet with `lock: { mode: 'pessimistic_write' }` (TypeORM
  emits `SELECT ... FOR UPDATE` under the hood).
- Inserts the ledger row in the **same** transaction as the balance
  update. The `UNIQUE` constraint on `external_transaction_id` is the
  final guard against concurrent retries — unique-violation errors are
  caught and converted into a cached-response replay.

Failed debits (insufficient funds) are also cached, so a retry of the
same request returns the same error rather than newly succeeding under a
race.

## Rollback rules

- Only `DEBIT` rows can be rolled back.
- A rollback is rejected if a `CREDIT` already exists with
  `related_external_transaction_id = originalTransactionId`.
- **Tombstone:** if the original transaction is not found, the rollback
  inserts a `ROLLBACK_TOMBSTONE` ledger row, returns success, and changes
  no balances. This makes the operation idempotent and auditable even
  when the original bet never reached the casino.

## Security model

`shared/hmac.ts` exposes `signString`, `signBuffer`, `verifySignature`
(constant-time compare). Express captures the raw body buffer in
`express.json({ verify })` so verification operates on the exact bytes
the sender signed — no JSON re-stringification.

Direction of calls:

| Direction          | URL family    | Header sent          | Secret           |
| ------------------ | ------------- | -------------------- | ---------------- |
| Provider → Casino  | `/casino/*`   | `x-casino-signature` | `CASINO_SECRET`  |
| Casino → Provider  | `/provider/*` | `x-provider-signature` | `PROVIDER_SECRET` |

Client-facing endpoints (`/casino/launchGame`, `/casino/simulateRound`)
do not require an HMAC header — they represent the trusted frontend
surface.

## Tests

```bash
npm test
```

Covers:
- end-to-end `simulateRound` balance arithmetic
- debit/credit/rollback idempotency replays
- rollback tombstone path
- HMAC negative case (bad signature → 401)

## Project layout

```
src/
  index.ts              express bootstrap + DataSource init
  config.ts             env validation (zod)
  db/
    data-source.ts      TypeORM DataSource (entities + migrations registered)
    migrations/
      1700000000000-Init.ts
      1700000000001-Seed.ts
  entities/
    casino.ts           CasinoUser, CasinoWallet, CasinoGameProvider,
                        CasinoGame, CasinoGameSession, CasinoTransaction
    provider.ts         ProviderGame, ProviderCustomer,
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
tests/
  *.test.ts
```

## Notes / out of scope
- No frontend / no real auth on the client-facing launch endpoint.
- Single currency (USD) and single seeded user/game for the demo.
- No real retry worker — provider retries are exercised by the
  idempotency tests, not a background loop.
