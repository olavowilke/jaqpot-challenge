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
  ProviderCasino,
  ProviderCustomer,
  ProviderGame,
  ProviderGameRound,
} from '../entities/provider.js';
import { Init1700000000000 } from './migrations/1700000000000-Init.js';
import { Seed1700000000001 } from './migrations/1700000000001-Seed.js';
import { ProviderCasinos1700000000002 } from './migrations/1700000000002-ProviderCasinos.js';
import { DevSeedAlign1700000000003 } from './migrations/1700000000003-DevSeedAlign.js';

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
    ProviderCasino,
    ProviderCustomer,
    ProviderGameRound,
    ProviderBet,
  ],
  migrations: [
    Init1700000000000,
    Seed1700000000001,
    ProviderCasinos1700000000002,
    DevSeedAlign1700000000003,
  ],
  migrationsRun: false,
  synchronize: false,
  logging: false,
});
