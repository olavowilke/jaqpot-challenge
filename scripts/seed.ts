/**
 * Idempotent dev seed: re-aligns the seeded `provider_casinos` row with the
 * current .env (CASINO_SECRET + CASINO_BASE_URL) and re-asserts the demo
 * casino_user / casino_wallet rows so the Postman flow works end-to-end.
 *
 * Safe to run anytime — every statement is an UPSERT or an UPDATE on the
 * well-known seeded UUIDs. Use this after changing CASINO_SECRET in .env,
 * since migrations only run once and won't pick up the new value.
 */
import 'reflect-metadata';
import { AppDataSource } from '../src/db/data-source.js';
import { config } from '../src/config.js';

async function main() {
  await AppDataSource.initialize();

  // demo user
  await AppDataSource.query(`
    INSERT INTO casino_users (id, username, email)
    VALUES ('11111111-1111-1111-1111-111111111111', 'demo_user', 'demo@jaqpot.test')
    ON CONFLICT (id) DO NOTHING
  `);

  // demo wallet (USD, 100k)
  await AppDataSource.query(`
    INSERT INTO casino_wallets (id, user_id, currency_code, playable_balance, redeemable_balance)
    VALUES ('22222222-2222-2222-2222-222222222222',
            '11111111-1111-1111-1111-111111111111',
            'USD', 100000, 0)
    ON CONFLICT (id) DO NOTHING
  `);

  // casino-side game provider + game
  await AppDataSource.query(`
    INSERT INTO casino_game_providers (id, code, name, api_endpoint, secret_key, is_disabled)
    VALUES ('33333333-3333-3333-3333-333333333333',
            'JAQPOT', 'Jaqpot Games',
            'http://localhost:3000', 'unused-stored-secret', FALSE)
    ON CONFLICT (id) DO NOTHING
  `);
  await AppDataSource.query(`
    INSERT INTO casino_games (id, provider_id, provider_game_id, is_active, min_bet, max_bet)
    VALUES ('44444444-4444-4444-4444-444444444444',
            '33333333-3333-3333-3333-333333333333',
            'slot-001', TRUE, 100, 50000)
    ON CONFLICT (id) DO NOTHING
  `);

  // provider-side game
  await AppDataSource.query(`
    INSERT INTO provider_games (id, game_id, is_active, min_bet, max_bet)
    VALUES ('55555555-5555-5555-5555-555555555555', 'slot-001', TRUE, 100, 50000)
    ON CONFLICT (id) DO NOTHING
  `);

  // provider-side casino directory entry — upsert + always re-align secret/url
  await AppDataSource.query(
    `
    INSERT INTO provider_casinos (id, casino_code, name, casino_api_endpoint, casino_secret, is_active)
    VALUES ('66666666-6666-6666-6666-666666666666',
            'JAQPOT', 'Jaqpot Casino', $1, $2, TRUE)
    ON CONFLICT (casino_code) DO UPDATE
       SET casino_api_endpoint = EXCLUDED.casino_api_endpoint,
           casino_secret       = EXCLUDED.casino_secret,
           is_active           = TRUE
  `,
    [config.CASINO_BASE_URL, config.CASINO_SECRET],
  );

  console.log(`> seeded; provider_casinos.JAQPOT aligned to ${config.CASINO_BASE_URL}`);
  await AppDataSource.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
