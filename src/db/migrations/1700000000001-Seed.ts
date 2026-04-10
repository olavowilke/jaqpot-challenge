import type {MigrationInterface, QueryRunner} from 'typeorm';

/**
 * Deterministic seed for the demo simulate flow. Idempotent.
 */
export class Seed1700000000001 implements MigrationInterface {
    name = 'Seed1700000000001';

    public async up(q: QueryRunner): Promise<void> {
        await q.query(`
            INSERT INTO casino_users (id, username, email)
            VALUES ('11111111-1111-1111-1111-111111111111', 'demo_user', 'demo@jaqpot.test') ON CONFLICT (id) DO NOTHING
        `);

        await q.query(`
            INSERT INTO casino_wallets (id, user_id, currency_code, playable_balance, redeemable_balance)
            VALUES ('22222222-2222-2222-2222-222222222222',
                    '11111111-1111-1111-1111-111111111111',
                    'USD', 100000, 0) ON CONFLICT (id) DO NOTHING
        `);

        await q.query(`
            INSERT INTO casino_game_providers (id, code, name, api_endpoint, secret_key, is_disabled)
            VALUES ('33333333-3333-3333-3333-333333333333',
                    'JAQPOT', 'Jaqpot Games',
                    'http://localhost:3000', 'unused-stored-secret', FALSE) ON CONFLICT (id) DO NOTHING
        `);

        await q.query(`
            INSERT INTO casino_games (id, provider_id, provider_game_id, is_active, min_bet, max_bet)
            VALUES ('44444444-4444-4444-4444-444444444444',
                    '33333333-3333-3333-3333-333333333333',
                    'slot-001', TRUE, 100, 50000) ON CONFLICT (id) DO NOTHING
        `);

        await q.query(`
            INSERT INTO provider_games (id, game_id, is_active, min_bet, max_bet)
            VALUES ('55555555-5555-5555-5555-555555555555', 'slot-001', TRUE, 100, 50000) ON CONFLICT (id) DO NOTHING
        `);
    }

    public async down(q: QueryRunner): Promise<void> {
        await q.query(`DELETE
                       FROM provider_games
                       WHERE id = '55555555-5555-5555-5555-555555555555'`);
        await q.query(`DELETE
                       FROM casino_games
                       WHERE id = '44444444-4444-4444-4444-444444444444'`);
        await q.query(`DELETE
                       FROM casino_game_providers
                       WHERE id = '33333333-3333-3333-3333-333333333333'`);
        await q.query(`DELETE
                       FROM casino_wallets
                       WHERE id = '22222222-2222-2222-2222-222222222222'`);
        await q.query(`DELETE
                       FROM casino_users
                       WHERE id = '11111111-1111-1111-1111-111111111111'`);
    }
}
