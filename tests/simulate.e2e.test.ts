/**
 * End-to-end test for /casino/simulateRound + idempotency.
 *
 * Requires a running Postgres reachable at DATABASE_URL with migrations applied.
 * Skipped automatically when DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { DataSource } from 'typeorm';

const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? describe : describe.skip;

d('simulateRound e2e', () => {
  let server: Server;
  let baseUrl: string;
  let dataSource: DataSource;

  beforeAll(async () => {
    process.env.PORT = '0';
    process.env.CASINO_SECRET ||= 'test-casino-secret';
    process.env.PROVIDER_SECRET ||= 'test-provider-secret';
    process.env.CASINO_BASE_URL ||= 'http://localhost:0';
    process.env.PROVIDER_BASE_URL ||= 'http://localhost:0';

    const { bootstrap } = await import('../src/index.js');
    const app = await bootstrap();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://localhost:${port}`;

    // Override base URLs in the loaded config.
    const cfgMod = await import('../src/config.js');
    (cfgMod.config as { CASINO_BASE_URL: string }).CASINO_BASE_URL = baseUrl;
    (cfgMod.config as { PROVIDER_BASE_URL: string }).PROVIDER_BASE_URL = baseUrl;

    const dsMod = await import('../src/db/data-source.js');
    dataSource = dsMod.AppDataSource;

    // Reset the seed wallet so the test is deterministic.
    await dataSource.query(
      "UPDATE casino_wallets SET playable_balance = 100000 WHERE id = '22222222-2222-2222-2222-222222222222'",
    );
    await dataSource.query(
      "DELETE FROM casino_transactions WHERE wallet_id = '22222222-2222-2222-2222-222222222222'",
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('runs a full round and returns a consistent balance', async () => {
    const res = await fetch(`${baseUrl}/casino/simulateRound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      provider: {
        initialBalance: number;
        finalBalance: number;
        expectedBalance: number;
        consistent: boolean;
        trace: unknown[];
      };
    };
    expect(json.provider.consistent).toBe(true);
    expect(json.provider.finalBalance).toBe(json.provider.initialBalance + 700);
    expect(json.provider.trace.length).toBeGreaterThanOrEqual(6);
  });

  it('idempotent debit: replaying the same transactionId does not double-charge', async () => {
    const launch = await fetch(`${baseUrl}/casino/launchGame`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => r.json() as Promise<{ sessionToken: string }>);

    const txId = `dup-${Date.now()}`;
    const payload = {
      transactionId: txId,
      sessionToken: launch.sessionToken,
      amount: 250,
    };

    const { signString } = await import('../src/shared/hmac.js');
    const body = JSON.stringify(payload);
    const sig = signString(body, process.env.CASINO_SECRET!);

    const headers = {
      'content-type': 'application/json',
      'x-casino-signature': sig,
    };
    const r1 = await fetch(`${baseUrl}/casino/debit`, { method: 'POST', headers, body });
    const j1 = await r1.json();
    const r2 = await fetch(`${baseUrl}/casino/debit`, { method: 'POST', headers, body });
    const j2 = await r2.json();

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(j1).toEqual(j2);

    const ledger = await dataSource.query(
      'SELECT COUNT(*)::int AS n FROM casino_transactions WHERE external_transaction_id = $1',
      [txId],
    );
    expect(ledger[0].n).toBe(1);
  });

  it('rejects bad HMAC signatures', async () => {
    const res = await fetch(`${baseUrl}/casino/getBalance`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-casino-signature': 'deadbeef',
      },
      body: JSON.stringify({ sessionToken: 'whatever' }),
    });
    expect(res.status).toBe(401);
  });

  it('rollback tombstone returns success when original is unknown', async () => {
    const launch = await fetch(`${baseUrl}/casino/launchGame`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).then((r) => r.json() as Promise<{ sessionToken: string }>);

    const payload = {
      transactionId: `rb-${Date.now()}`,
      originalTransactionId: 'never-existed',
      sessionToken: launch.sessionToken,
    };
    const { signString } = await import('../src/shared/hmac.js');
    const body = JSON.stringify(payload);
    const sig = signString(body, process.env.CASINO_SECRET!);
    const res = await fetch(`${baseUrl}/casino/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-casino-signature': sig },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { tombstone: boolean };
    expect(json.tombstone).toBe(true);
  });
});
