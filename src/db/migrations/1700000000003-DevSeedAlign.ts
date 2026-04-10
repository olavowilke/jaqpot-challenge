import type {MigrationInterface, QueryRunner} from 'typeorm';

/**
 * Aligns the seeded `provider_casinos` row with the runtime env so that the
 * provider's signed callbacks can actually authenticate against the casino on
 * a fresh `npm run migrate`. Without this, `casino_secret` and the running
 * app's `CASINO_SECRET` drift apart and every provider→casino call returns
 * 401 BAD_SIGNATURE.
 *
 * Re-running this migration is a no-op (it only updates an existing row); use
 * `npm run seed` to re-align after changing your .env.
 */
export class DevSeedAlign1700000000003 implements MigrationInterface {
    name = 'DevSeedAlign1700000000003';

    public async up(q: QueryRunner): Promise<void> {
        const casinoSecret = process.env.CASINO_SECRET ?? 'dev-casino-secret';
        const casinoBaseUrl = process.env.CASINO_BASE_URL ?? 'http://localhost:3000';

        await q.query(
            `UPDATE provider_casinos
             SET casino_secret       = $1,
                 casino_api_endpoint = $2,
                 is_active           = TRUE
             WHERE casino_code = 'JAQPOT'`,
            [casinoSecret, casinoBaseUrl],
        );
    }

    public async down(): Promise<void> {
    }
}
