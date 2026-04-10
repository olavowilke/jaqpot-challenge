import 'reflect-metadata';
import express, {type Request} from 'express';
import {config} from './config.js';
import {AppDataSource} from './db/data-source.js';
import {casinoRouter} from './casino/routes.js';
import {providerRouter} from './provider/routes.js';
import {errorMiddleware} from './shared/errors.js';

export function createApp() {
    const app = express();
    app.use(
        express.json({
            verify: (req, _res, buf) => {
                (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
            },
        }),
    );
    app.get('/health', (_req, res) => res.json({ok: true}));
    app.use('/casino', casinoRouter);
    app.use('/provider', providerRouter);
    app.use(errorMiddleware);
    return app;
}

export async function bootstrap() {
    if (!AppDataSource.isInitialized) {
        await AppDataSource.initialize();
    }
    const app = createApp();
    return app;
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('index.ts');
if (isMain) {
    bootstrap()
        .then((app) => {
            app.listen(config.PORT, () => {
                // eslint-disable-next-line no-console
                console.log(`jaqpot listening on http://localhost:${config.PORT}`);
            });
        })
        .catch((e) => {
            // eslint-disable-next-line no-console
            console.error('bootstrap failed', e);
            process.exit(1);
        });
}
