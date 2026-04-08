import type { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1700000000000 implements MigrationInterface {
  name = 'Init1700000000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

    // ===== CASINO =====
    await q.query(`
      CREATE TABLE casino_users (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username    VARCHAR(64) NOT NULL UNIQUE,
        email       VARCHAR(255) NOT NULL UNIQUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE casino_wallets (
        id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id            UUID NOT NULL REFERENCES casino_users(id),
        currency_code      VARCHAR(8) NOT NULL,
        playable_balance   BIGINT NOT NULL DEFAULT 0 CHECK (playable_balance >= 0),
        redeemable_balance BIGINT NOT NULL DEFAULT 0 CHECK (redeemable_balance >= 0),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (user_id, currency_code)
      )
    `);

    await q.query(`
      CREATE TABLE casino_game_providers (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code         VARCHAR(64) NOT NULL UNIQUE,
        name         VARCHAR(128) NOT NULL,
        api_endpoint VARCHAR(512) NOT NULL,
        secret_key   VARCHAR(256) NOT NULL,
        is_disabled  BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);

    await q.query(`
      CREATE TABLE casino_games (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        provider_id      UUID NOT NULL REFERENCES casino_game_providers(id),
        provider_game_id VARCHAR(128) NOT NULL,
        is_active        BOOLEAN NOT NULL DEFAULT TRUE,
        min_bet          BIGINT NOT NULL DEFAULT 1,
        max_bet          BIGINT NOT NULL DEFAULT 1000000,
        UNIQUE (provider_id, provider_game_id)
      )
    `);

    await q.query(`
      CREATE TABLE casino_game_sessions (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token               VARCHAR(128) NOT NULL UNIQUE,
        user_id             UUID NOT NULL REFERENCES casino_users(id),
        wallet_id           UUID NOT NULL REFERENCES casino_wallets(id),
        game_id             UUID NOT NULL REFERENCES casino_games(id),
        provider_session_id VARCHAR(128),
        is_active           BOOLEAN NOT NULL DEFAULT TRUE,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE casino_transactions (
        id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        wallet_id                       UUID NOT NULL REFERENCES casino_wallets(id),
        session_id                      UUID REFERENCES casino_game_sessions(id),
        transaction_type                VARCHAR(32) NOT NULL
          CHECK (transaction_type IN ('DEBIT','CREDIT','ROLLBACK','ROLLBACK_TOMBSTONE')),
        amount                          BIGINT NOT NULL DEFAULT 0,
        external_transaction_id         VARCHAR(128) NOT NULL UNIQUE,
        related_external_transaction_id VARCHAR(128),
        balance_after                   BIGINT NOT NULL DEFAULT 0,
        response_cache                  JSONB NOT NULL,
        created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await q.query(`CREATE INDEX idx_casino_tx_related ON casino_transactions(related_external_transaction_id)`);
    await q.query(`CREATE INDEX idx_casino_tx_wallet ON casino_transactions(wallet_id)`);

    // ===== PROVIDER =====
    await q.query(`
      CREATE TABLE provider_games (
        id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        game_id   VARCHAR(128) NOT NULL UNIQUE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        min_bet   BIGINT NOT NULL DEFAULT 1,
        max_bet   BIGINT NOT NULL DEFAULT 1000000
      )
    `);

    await q.query(`
      CREATE TABLE provider_customers (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        player_id        VARCHAR(128) NOT NULL UNIQUE,
        casino_code      VARCHAR(64) NOT NULL,
        external_user_id VARCHAR(128) NOT NULL,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE provider_game_rounds (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        round_id            VARCHAR(128) NOT NULL UNIQUE,
        session_id          VARCHAR(128) NOT NULL,
        player_id           UUID NOT NULL REFERENCES provider_customers(id),
        game_id             UUID NOT NULL REFERENCES provider_games(id),
        currency            VARCHAR(8) NOT NULL,
        status              VARCHAR(16) NOT NULL DEFAULT 'OPEN',
        total_bet_amount    BIGINT NOT NULL DEFAULT 0,
        total_payout_amount BIGINT NOT NULL DEFAULT 0,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await q.query(`
      CREATE TABLE provider_bets (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        transaction_id       VARCHAR(128) NOT NULL UNIQUE,
        round_id             UUID NOT NULL REFERENCES provider_game_rounds(id),
        bet_type             VARCHAR(32) NOT NULL,
        amount               BIGINT NOT NULL,
        casino_balance_after BIGINT,
        status               VARCHAR(32) NOT NULL,
        response_cache       JSONB,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS provider_bets`);
    await q.query(`DROP TABLE IF EXISTS provider_game_rounds`);
    await q.query(`DROP TABLE IF EXISTS provider_customers`);
    await q.query(`DROP TABLE IF EXISTS provider_games`);
    await q.query(`DROP TABLE IF EXISTS casino_transactions`);
    await q.query(`DROP TABLE IF EXISTS casino_game_sessions`);
    await q.query(`DROP TABLE IF EXISTS casino_games`);
    await q.query(`DROP TABLE IF EXISTS casino_game_providers`);
    await q.query(`DROP TABLE IF EXISTS casino_wallets`);
    await q.query(`DROP TABLE IF EXISTS casino_users`);
  }
}
