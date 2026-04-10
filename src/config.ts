import 'dotenv/config';
import {z} from 'zod';

const Schema = z.object({
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string(),
    CASINO_SECRET: z.string().min(8),
    PROVIDER_SECRET: z.string().min(8),
    CASINO_BASE_URL: z.string().url(),
    PROVIDER_BASE_URL: z.string().url(),
    LOG_LEVEL: z.string().default('info'),
});

export const config = Schema.parse(process.env);
