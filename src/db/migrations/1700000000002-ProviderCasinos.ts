import type {MigrationInterface, QueryRunner} from 'typeorm';

/**
 * Adds the `provider_casinos` directory table and migrates
 * `provider_customers` from a free-text `casino_code` to a `casino_id` FK.
 *
 * The provider now resolves casino API endpoint + secret from this table at
 * runtime, instead of relying on a single hard-coded env-level secret.
 */
export class ProviderCasinos1700000000002 implements MigrationInterface {
    name = 'ProviderCasinos1700000000002';

    public async up(q: QueryRunner): Promise<void> {
        await q.query(`
            CREATE TABLE provider_casinos
            (
                id                  UUID PRIMARY KEY      DEFAULT gen_random_uuid(),
                casino_code         VARCHAR(64)  NOT NULL UNIQUE,
                name                VARCHAR(128) NOT NULL,
                casino_api_endpoint VARCHAR(512) NOT NULL,
                casino_secret       VARCHAR(256) NOT NULL,
                is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
                created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
            )
        `);

        await q.query(`
            INSERT INTO provider_casinos (id, casino_code, name, casino_api_endpoint, casino_secret, is_active)
            VALUES ('66666666-6666-6666-6666-666666666666',
                    'JAQPOT', 'Jaqpot Casino',
                    'http://localhost:3000', 'dev-casino-secret', TRUE) ON CONFLICT (casino_code) DO NOTHING
        `);

        await q.query(`ALTER TABLE provider_customers
            ADD COLUMN casino_id UUID`);
        await q.query(`
            UPDATE provider_customers pc
            SET casino_id = c.id FROM provider_casinos c
            WHERE c.casino_code = pc.casino_code
        `);

        await q.query(`ALTER TABLE provider_customers
            ALTER COLUMN casino_id SET NOT NULL`);
        await q.query(
            `ALTER TABLE provider_customers
                ADD CONSTRAINT fk_provider_customers_casino FOREIGN KEY (casino_id) REFERENCES provider_casinos (id)`,
        );
        await q.query(`ALTER TABLE provider_customers DROP COLUMN casino_code`);
    }

    public async down(q: QueryRunner): Promise<void> {
        await q.query(`ALTER TABLE provider_customers
            ADD COLUMN casino_code VARCHAR(64)`);
        await q.query(`
            UPDATE provider_customers pc
            SET casino_code = c.casino_code FROM provider_casinos c
            WHERE c.id = pc.casino_id
        `);
        await q.query(`ALTER TABLE provider_customers
            ALTER COLUMN casino_code SET NOT NULL`);
        await q.query(`ALTER TABLE provider_customers DROP CONSTRAINT fk_provider_customers_casino`);
        await q.query(`ALTER TABLE provider_customers DROP COLUMN casino_id`);
        await q.query(`DROP TABLE IF EXISTS provider_casinos`);
    }
}
