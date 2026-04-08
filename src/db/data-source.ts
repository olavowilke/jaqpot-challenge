import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config } from '../config.js';
import {
  CasinoGame,
  CasinoGameProvider,
  CasinoGameSession,
  CasinoTransaction,
  CasinoUser,
  CasinoWallet,
} from '../entities/casino.js';
import {
  ProviderBet,
  ProviderCustomer,
  ProviderGame,
  ProviderGameRound,
} from '../entities/provider.js';
import { Init1700000000000 } from './migrations/1700000000000-Init.js';
import { Seed1700000000001 } from './migrations/1700000000001-Seed.js';

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: config.DATABASE_URL,
  entities: [
    CasinoUser,
    CasinoWallet,
    CasinoGameProvider,
    CasinoGame,
    CasinoGameSession,
    CasinoTransaction,
    ProviderGame,
    ProviderCustomer,
    ProviderGameRound,
    ProviderBet,
  ],
  migrations: [Init1700000000000, Seed1700000000001],
  migrationsRun: false,
  synchronize: false,
  logging: false,
});
