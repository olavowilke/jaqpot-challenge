/**
 * End-to-end test suite covering the technical assessment requirements:
 *  - HMAC authentication on both directions
 *  - Casino as the source of truth for wallet balances
 *  - Atomic + idempotent debit / credit / rollback callbacks
 *  - Rollback rules (DEBIT-only, no rollback after payout, tombstone)
 *  - Read-only /casino/getBalance
 *  - Full /casino/simulateRound flow
 *
 * The suite is fully self-contained: it boots a throwaway Postgres container
 * via Testcontainers, points the app at it, runs the real migrations, and
 * tears it all down at the end. No shared state with any dev DB.
 */
import {describe, it, expect, beforeAll, afterAll} from 'vitest';
import type {AddressInfo} from 'node:net';
import type {Server} from 'node:http';
import type {DataSource} from 'typeorm';
import {PostgreSqlContainer, type StartedPostgreSqlContainer} from '@testcontainers/postgresql';

const SEED_WALLET_ID = '22222222-2222-2222-2222-222222222222';

describe('jaqpot casino+provider e2e', () => {
    let pgContainer: StartedPostgreSqlContainer;
    let server: Server;
    let baseUrl: string;
    let dataSource: DataSource;
    let signString: (body: string, secret: string) => string;
    let CASINO_SECRET: string;
    let PROVIDER_SECRET: string;

    // ---------- helpers ----------

    const post = async (
        path: string,
        payload: unknown,
        opts: { secret?: string; header?: 'x-casino-signature' | 'x-provider-signature' } = {},
    ) => {
        const body = JSON.stringify(payload);
        const headers: Record<string, string> = {'content-type': 'application/json'};
        if (opts.secret && opts.header) {
            headers[opts.header] = signString(body, opts.secret);
        }
        const res = await fetch(`${baseUrl}${path}`, {method: 'POST', headers, body});
        const text = await res.text();
        let json: unknown = null;
        if (text) {
            try {
                json = JSON.parse(text);
            } catch {
                json = text;
            }
        }
        return {status: res.status, body: json};
    };

    const casinoCall = (path: string, payload: unknown) =>
        post(path, payload, {secret: CASINO_SECRET, header: 'x-casino-signature'});
    const providerCall = (path: string, payload: unknown) =>
        post(path, payload, {secret: PROVIDER_SECRET, header: 'x-provider-signature'});

    const launchFreshSession = async () => {
        const r = await post('/casino/launchGame', {});
        expect(r.status).toBe(200);
        return (r.body as { sessionToken: string }).sessionToken;
    };

    const resetWallet = async (balance = 100000) => {
        await dataSource.query(
            `UPDATE casino_wallets
             SET playable_balance = $1
             WHERE id = $2`,
            [balance, SEED_WALLET_ID],
        );
        await dataSource.query(
            `DELETE
             FROM casino_transactions
             WHERE wallet_id = $1`,
            [SEED_WALLET_ID],
        );
    };

    // ---------- bootstrap ----------

    beforeAll(async () => {
        pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
            .withDatabase('jaqpot_test')
            .withUsername('jaqpot')
            .withPassword('jaqpot')
            .start();

        process.env.DATABASE_URL = pgContainer.getConnectionUri();
        process.env.PORT = '0';
        process.env.CASINO_SECRET ||= 'test-casino-secret';
        process.env.PROVIDER_SECRET ||= 'test-provider-secret';
        process.env.CASINO_BASE_URL ||= 'http://localhost:0';
        process.env.PROVIDER_BASE_URL ||= 'http://localhost:0';
        CASINO_SECRET = process.env.CASINO_SECRET!;
        PROVIDER_SECRET = process.env.PROVIDER_SECRET!;

        const dsModEarly = await import('../src/db/data-source.js');
        if (!dsModEarly.AppDataSource.isInitialized) {
            await dsModEarly.AppDataSource.initialize();
        }
        await dsModEarly.AppDataSource.runMigrations({transaction: 'each'});

        const {bootstrap} = await import('../src/index.js');
        const app = await bootstrap();
        await new Promise<void>((resolve) => {
            server = app.listen(0, () => resolve());
        });
        const port = (server.address() as AddressInfo).port;
        baseUrl = `http://localhost:${port}`;

        const cfgMod = await import('../src/config.js');
        (cfgMod.config as { CASINO_BASE_URL: string }).CASINO_BASE_URL = baseUrl;
        (cfgMod.config as { PROVIDER_BASE_URL: string }).PROVIDER_BASE_URL = baseUrl;

        const dsMod = await import('../src/db/data-source.js');
        dataSource = dsMod.AppDataSource;

        const hmac = await import('../src/shared/hmac.js');
        signString = hmac.signString;

        await dataSource.query(
            `UPDATE provider_casinos
             SET casino_api_endpoint = $1,
                 casino_secret = $2,
                 is_active = TRUE
             WHERE casino_code = 'JAQPOT'`,
            [baseUrl, CASINO_SECRET],
        );

        await resetWallet();
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (dataSource?.isInitialized) await dataSource.destroy();
        if (pgContainer) await pgContainer.stop();
    });

    // ============================================================
    // /casino/simulateRound — full end-to-end flow
    // ============================================================

    describe('/casino/simulateRound', () => {
        it('runs balance → debit → debit → credit → rollback → balance with consistent math', async () => {
            await resetWallet();
            const r = await post('/casino/simulateRound', {});
            expect(r.status).toBe(200);
            const json = r.body as {
                provider: {
                    initialBalance: number;
                    finalBalance: number;
                    expectedBalance: number;
                    consistent: boolean;
                    trace: Array<{ step: string }>;
                };
            };
            expect(json.provider.consistent).toBe(true);
            expect(json.provider.finalBalance).toBe(json.provider.initialBalance + 700);

            const steps = json.provider.trace.map((t) => t.step);
            expect(steps).toEqual([
                'getBalance',
                'debit#1',
                'debit#2',
                'credit',
                'rollback',
                'getBalance',
            ]);
        });

        it('is safe to re-run: fresh transactionIds compound predictably', async () => {
            await resetWallet();
            const r1 = await post('/casino/simulateRound', {});
            const r2 = await post('/casino/simulateRound', {});
            expect(r1.status).toBe(200);
            expect(r2.status).toBe(200);
            const j1 = (r1.body as { provider: { finalBalance: number } }).provider;
            const j2 = (r2.body as { provider: { finalBalance: number } }).provider;
            expect(j2.finalBalance).toBe(j1.finalBalance + 700);
        });
    });

    // ============================================================
    // /casino/getBalance — read-only callback
    // ============================================================

    describe('/casino/getBalance', () => {
        it('returns the authoritative balance and does not mutate state', async () => {
            await resetWallet();
            const session = await launchFreshSession();

            const ledgerBefore = await dataSource.query(
                `SELECT COUNT(*) ::int AS n
                 FROM casino_transactions
                 WHERE wallet_id = $1`,
                [SEED_WALLET_ID],
            );
            const balBefore = await dataSource.query(
                `SELECT playable_balance::bigint AS b
                 FROM casino_wallets
                 WHERE id = $1`,
                [SEED_WALLET_ID],
            );

            const r1 = await casinoCall('/casino/getBalance', {sessionToken: session});
            const r2 = await casinoCall('/casino/getBalance', {sessionToken: session});
            expect(r1.status).toBe(200);
            expect(r2.status).toBe(200);
            expect((r1.body as { balance: number }).balance).toBe(
                (r2.body as { balance: number }).balance,
            );

            const ledgerAfter = await dataSource.query(
                `SELECT COUNT(*) ::int AS n
                 FROM casino_transactions
                 WHERE wallet_id = $1`,
                [SEED_WALLET_ID],
            );
            const balAfter = await dataSource.query(
                `SELECT playable_balance::bigint AS b
                 FROM casino_wallets
                 WHERE id = $1`,
                [SEED_WALLET_ID],
            );
            expect(ledgerAfter[0].n).toBe(ledgerBefore[0].n);
            expect(Number(balAfter[0].b)).toBe(Number(balBefore[0].b));
        });
    });

    // ============================================================
    // /casino/debit — atomic, idempotent, validates funds
    // ============================================================

    describe('/casino/debit', () => {
        it('debits the wallet by exactly the requested amount', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const r = await casinoCall('/casino/debit', {
                transactionId: `dbt-${Date.now()}-${Math.random()}`,
                sessionToken: session,
                amount: 1234,
            });
            expect(r.status).toBe(200);
            expect((r.body as { balance: number }).balance).toBe(10_000 - 1234);
        });

        it('idempotent: replaying the same transactionId returns the cached result and inserts no extra ledger row', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const txId = `dup-${Date.now()}`;
            const payload = {transactionId: txId, sessionToken: session, amount: 250};

            const r1 = await casinoCall('/casino/debit', payload);
            const r2 = await casinoCall('/casino/debit', payload);
            expect(r1.status).toBe(200);
            expect(r2.status).toBe(200);
            expect(r1.body).toEqual(r2.body);

            const ledger = await dataSource.query(
                `SELECT COUNT(*) ::int AS n
                 FROM casino_transactions
                 WHERE external_transaction_id = $1`,
                [txId],
            );
            expect(ledger[0].n).toBe(1);

            const bal = await dataSource.query(
                `SELECT playable_balance::bigint AS b
                 FROM casino_wallets
                 WHERE id = $1`,
                [SEED_WALLET_ID],
            );
            expect(Number(bal[0].b)).toBe(10_000 - 250);
        });

        it('rejects insufficient funds with 402 and caches the failure for deterministic replay', async () => {
            await resetWallet(100);
            const session = await launchFreshSession();
            const txId = `nofunds-${Date.now()}`;
            const payload = {transactionId: txId, sessionToken: session, amount: 999_999};

            const r1 = await casinoCall('/casino/debit', payload);
            expect(r1.status).toBe(402);

            const r2 = await casinoCall('/casino/debit', payload);
            expect(r2.status).toBe(402);
            expect(r2.body).toEqual(r1.body);
            expect((r2.body as { status: string }).status).toBe('INSUFFICIENT_FUNDS');

            const ledger = await dataSource.query(
                `SELECT COUNT(*) ::int AS n
                 FROM casino_transactions
                 WHERE external_transaction_id = $1`,
                [txId],
            );
            expect(ledger[0].n).toBe(1);

            const bal = await dataSource.query(
                `SELECT playable_balance::bigint AS b
                 FROM casino_wallets
                 WHERE id = $1`,
                [SEED_WALLET_ID],
            );
            expect(Number(bal[0].b)).toBe(100);
        });

        it('replaying a debit returns the *current* wallet balance, not the snapshot from when it first committed', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const txA = `dbt-a-${Date.now()}-${Math.random()}`;
            const txB = `dbt-b-${Date.now()}-${Math.random()}`;

            const a1 = await casinoCall('/casino/debit', {
                transactionId: txA,
                sessionToken: session,
                amount: 1000,
            });
            expect(a1.status).toBe(200);
            expect((a1.body as { balance: number }).balance).toBe(9_000);

            const b = await casinoCall('/casino/debit', {
                transactionId: txB,
                sessionToken: session,
                amount: 500,
            });
            expect((b.body as { balance: number }).balance).toBe(8_500);

            const a2 = await casinoCall('/casino/debit', {
                transactionId: txA,
                sessionToken: session,
                amount: 1000,
            });
            expect(a2.status).toBe(200);
            const a2body = a2.body as { status: string; transactionId: string; balance: number };
            expect(a2body.status).toBe('OK');
            expect(a2body.transactionId).toBe(txA);
            expect(a2body.balance).toBe(8_500);

            const ledger = await dataSource.query(
                `SELECT COUNT(*) ::int AS n
                 FROM casino_transactions
                 WHERE external_transaction_id = $1`,
                [txA],
            );
            expect(ledger[0].n).toBe(1);
        });

        it('replaying a credit returns the *current* wallet balance, not the snapshot from when it first committed', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const crd = `crd-${Date.now()}-${Math.random()}`;
            const dbt = `dbt-${Date.now()}-${Math.random()}`;

            const c1 = await casinoCall('/casino/credit', {
                transactionId: crd,
                sessionToken: session,
                amount: 2000,
            });
            expect((c1.body as { balance: number }).balance).toBe(12_000);

            const d = await casinoCall('/casino/debit', {
                transactionId: dbt,
                sessionToken: session,
                amount: 700,
            });
            expect((d.body as { balance: number }).balance).toBe(11_300);

            const c2 = await casinoCall('/casino/credit', {
                transactionId: crd,
                sessionToken: session,
                amount: 2000,
            });
            expect(c2.status).toBe(200);
            const c2body = c2.body as { status: string; transactionId: string; balance: number };
            expect(c2body.status).toBe('OK');
            expect(c2body.transactionId).toBe(crd);
            expect(c2body.balance).toBe(11_300);

            const ledger = await dataSource.query(
                `SELECT COUNT(*) ::int AS n
                 FROM casino_transactions
                 WHERE external_transaction_id = $1`,
                [crd],
            );
            expect(ledger[0].n).toBe(1);
        });

        it('handles concurrent retries of the same transactionId atomically (one ledger row, one balance movement)', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const txId = `race-${Date.now()}`;
            const payload = {transactionId: txId, sessionToken: session, amount: 400};

            const results = await Promise.all(
                Array.from({length: 8}, () => casinoCall('/casino/debit', payload)),
            );
            const oks = results.filter((r) => r.status === 200);
            expect(oks.length).toBeGreaterThan(0);
            const first = oks[0].body;
            for (const ok of oks) expect(ok.body).toEqual(first);

            const ledger = await dataSource.query(
                `SELECT COUNT(*) ::int AS n
                 FROM casino_transactions
                 WHERE external_transaction_id = $1`,
                [txId],
            );
            expect(ledger[0].n).toBe(1);
            const bal = await dataSource.query(
                `SELECT playable_balance::bigint AS b
                 FROM casino_wallets
                 WHERE id = $1`,
                [SEED_WALLET_ID],
            );
            expect(Number(bal[0].b)).toBe(10_000 - 400);
        });
    });

    // ============================================================
    // /casino/credit — atomic, idempotent
    // ============================================================

    describe('/casino/credit', () => {
        it('credits the wallet and is idempotent on replay', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const txId = `crd-${Date.now()}`;
            const payload = {transactionId: txId, sessionToken: session, amount: 750};

            const r1 = await casinoCall('/casino/credit', payload);
            const r2 = await casinoCall('/casino/credit', payload);
            expect(r1.status).toBe(200);
            expect(r2.status).toBe(200);
            expect(r1.body).toEqual(r2.body);
            expect((r1.body as { balance: number }).balance).toBe(10_750);

            const ledger = await dataSource.query(
                `SELECT COUNT(*) ::int AS n
                 FROM casino_transactions
                 WHERE external_transaction_id = $1`,
                [txId],
            );
            expect(ledger[0].n).toBe(1);
            const bal = await dataSource.query(
                `SELECT playable_balance::bigint AS b
                 FROM casino_wallets
                 WHERE id = $1`,
                [SEED_WALLET_ID],
            );
            expect(Number(bal[0].b)).toBe(10_750);
        });
    });

    // ============================================================
    // /casino/rollback — rollback rules
    // ============================================================

    describe('/casino/rollback', () => {
        it('refunds a previously accepted bet and is idempotent', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const betTxId = `bet-${Date.now()}`;
            const rbTxId = `rb-${Date.now()}`;

            const debit = await casinoCall('/casino/debit', {
                transactionId: betTxId,
                sessionToken: session,
                amount: 800,
            });
            expect(debit.status).toBe(200);

            const rb1 = await casinoCall('/casino/rollback', {
                transactionId: rbTxId,
                originalTransactionId: betTxId,
                sessionToken: session,
            });
            const rb2 = await casinoCall('/casino/rollback', {
                transactionId: rbTxId,
                originalTransactionId: betTxId,
                sessionToken: session,
            });
            expect(rb1.status).toBe(200);
            expect(rb2.status).toBe(200);
            expect(rb1.body).toEqual(rb2.body);
            expect((rb1.body as { balance: number }).balance).toBe(10_000);

            const rbCount = await dataSource.query(
                `SELECT COUNT(*) ::int AS n
                 FROM casino_transactions
                 WHERE external_transaction_id = $1`,
                [rbTxId],
            );
            expect(rbCount[0].n).toBe(1);
        });

        it('tombstones unknown originals: returns 200 + tombstone:true with no balance change', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const r = await casinoCall('/casino/rollback', {
                transactionId: `tomb-${Date.now()}`,
                originalTransactionId: 'never-existed',
                sessionToken: session,
            });
            expect(r.status).toBe(200);
            expect((r.body as { tombstone: boolean }).tombstone).toBe(true);

            const bal = await dataSource.query(
                `SELECT playable_balance::bigint AS b
                 FROM casino_wallets
                 WHERE id = $1`,
                [SEED_WALLET_ID],
            );
            expect(Number(bal[0].b)).toBe(10_000);
        });

        it('rejects rollback when the original is a CREDIT (only DEBIT can be rolled back)', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const creditTxId = `crd-${Date.now()}`;
            await casinoCall('/casino/credit', {
                transactionId: creditTxId,
                sessionToken: session,
                amount: 500,
            });

            const r = await casinoCall('/casino/rollback', {
                transactionId: `rb-of-credit-${Date.now()}`,
                originalTransactionId: creditTxId,
                sessionToken: session,
            });
            expect(r.status).toBe(409);
            expect((r.body as { error: { code: string } }).error.code).toBe('ROLLBACK_NOT_ALLOWED');
        });

        it('rejects rollback of a bet that already has a payout', async () => {
            await resetWallet(10_000);
            const session = await launchFreshSession();
            const betTxId = `bet-paid-${Date.now()}`;
            await casinoCall('/casino/debit', {
                transactionId: betTxId,
                sessionToken: session,
                amount: 500,
            });
            await casinoCall('/casino/credit', {
                transactionId: `win-${Date.now()}`,
                sessionToken: session,
                amount: 1500,
                relatedTransactionId: betTxId,
            });

            const r = await casinoCall('/casino/rollback', {
                transactionId: `rb-after-payout-${Date.now()}`,
                originalTransactionId: betTxId,
                sessionToken: session,
            });
            expect(r.status).toBe(409);
            expect((r.body as { error: { code: string } }).error.code).toBe('ROLLBACK_AFTER_PAYOUT');
        });
    });

    // ============================================================
    // HMAC enforcement on both directions
    // ============================================================

    describe('HMAC enforcement', () => {
        it('rejects /casino/getBalance without a signature', async () => {
            const res = await fetch(`${baseUrl}/casino/getBalance`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({sessionToken: 'whatever'}),
            });
            expect(res.status).toBe(401);
        });

        it('rejects /casino/getBalance with a tampered signature', async () => {
            const res = await fetch(`${baseUrl}/casino/getBalance`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-casino-signature': 'deadbeef',
                },
                body: JSON.stringify({sessionToken: 'whatever'}),
            });
            expect(res.status).toBe(401);
        });

        it('rejects /casino/debit without a signature', async () => {
            const res = await fetch(`${baseUrl}/casino/debit`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({transactionId: 'x', sessionToken: 'y', amount: 1}),
            });
            expect(res.status).toBe(401);
        });

        it('rejects /casino/credit signed with the wrong (provider) secret', async () => {
            const r = await post(
                '/casino/credit',
                {transactionId: 'x', sessionToken: 'y', amount: 1},
                {secret: PROVIDER_SECRET, header: 'x-casino-signature'},
            );
            expect(r.status).toBe(401);
        });

        it('rejects /provider/launch without a signature', async () => {
            const res = await fetch(`${baseUrl}/provider/launch`, {
                method: 'POST',
                headers: {'content-type': 'application/json'},
                body: JSON.stringify({
                    casinoSessionToken: 'x',
                    userId: 'y',
                    casinoCode: 'JAQPOT',
                    providerGameId: 'slot-001',
                    currency: 'USD',
                }),
            });
            expect(res.status).toBe(401);
        });

        it('rejects /provider/simulate signed with the wrong (casino) secret', async () => {
            const r = await post(
                '/provider/simulate',
                {
                    casinoCode: 'JAQPOT',
                    casinoSessionToken: 'x',
                    providerSessionId: 'y',
                    customerId: '00000000-0000-0000-0000-000000000000',
                    providerInternalGameId: '00000000-0000-0000-0000-000000000000',
                    currency: 'USD',
                },
                {secret: CASINO_SECRET, header: 'x-provider-signature'},
            );
            expect(r.status).toBe(401);
        });
    });

    // ============================================================
    // provider_casinos directory: lookup, inactive, missing
    // ============================================================

    describe('provider_casinos directory', () => {
        it('/provider/simulate rejects an unknown casino code with 404 CASINO_NOT_FOUND', async () => {
            const r = await providerCall('/provider/simulate', {
                casinoCode: 'DOES_NOT_EXIST',
                casinoSessionToken: 'x',
                providerSessionId: 'y',
                customerId: '00000000-0000-0000-0000-000000000000',
                providerInternalGameId: '00000000-0000-0000-0000-000000000000',
                currency: 'USD',
            });
            expect(r.status).toBe(404);
            expect((r.body as { error: { code: string } }).error.code).toBe('CASINO_NOT_FOUND');
        });

        it('/provider/simulate rejects an inactive casino with 409 CASINO_INACTIVE', async () => {
            await dataSource.query(
                `UPDATE provider_casinos
                 SET is_active = FALSE
                 WHERE casino_code = 'JAQPOT'`,
            );
            try {
                const r = await providerCall('/provider/simulate', {
                    casinoCode: 'JAQPOT',
                    casinoSessionToken: 'x',
                    providerSessionId: 'y',
                    customerId: '00000000-0000-0000-0000-000000000000',
                    providerInternalGameId: '00000000-0000-0000-0000-000000000000',
                    currency: 'USD',
                });
                expect(r.status).toBe(409);
                expect((r.body as { error: { code: string } }).error.code).toBe('CASINO_INACTIVE');
            } finally {
                await dataSource.query(
                    `UPDATE provider_casinos
                     SET is_active = TRUE
                     WHERE casino_code = 'JAQPOT'`,
                );
            }
        });

        it('/casino/simulateRound fails fast when the directory row is disabled', async () => {
            await resetWallet();
            await dataSource.query(
                `UPDATE provider_casinos
                 SET is_active = FALSE
                 WHERE casino_code = 'JAQPOT'`,
            );
            try {
                const r = await post('/casino/simulateRound', {casinoCode: 'JAQPOT'});
                expect(r.status).toBeGreaterThanOrEqual(400);
            } finally {
                await dataSource.query(
                    `UPDATE provider_casinos
                     SET is_active = TRUE
                     WHERE casino_code = 'JAQPOT'`,
                );
            }
        });

        it('/provider/launch (via /casino/launchGame) writes provider_customers.casino_id matching provider_casinos.id', async () => {
            await resetWallet();
            const session = await launchFreshSession();
            expect(session).toBeTruthy();

            const rows = await dataSource.query(
                `SELECT pc.casino_id, pcas.casino_code
                 FROM provider_customers pc
                          JOIN provider_casinos pcas ON pcas.id = pc.casino_id
                 WHERE pc.player_id = 'JAQPOT:11111111-1111-1111-1111-111111111111'`,
            );
            expect(rows.length).toBe(1);
            expect(rows[0].casino_code).toBe('JAQPOT');
            expect(rows[0].casino_id).toBeTruthy();
        });
    });
});
