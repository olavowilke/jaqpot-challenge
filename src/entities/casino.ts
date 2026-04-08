import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { bigintToNumber } from './transformers.js';

@Entity({ name: 'casino_users' })
export class CasinoUser {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  username!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

@Entity({ name: 'casino_wallets' })
@Unique(['userId', 'currencyCode'])
export class CasinoWallet {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => CasinoUser)
  @JoinColumn({ name: 'user_id' })
  user!: CasinoUser;

  @Column({ name: 'currency_code', type: 'varchar', length: 8 })
  currencyCode!: string;

  @Column({ name: 'playable_balance', type: 'bigint', default: 0, transformer: bigintToNumber })
  playableBalance!: number;

  @Column({ name: 'redeemable_balance', type: 'bigint', default: 0, transformer: bigintToNumber })
  redeemableBalance!: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

@Entity({ name: 'casino_game_providers' })
export class CasinoGameProvider {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 128 })
  name!: string;

  @Column({ name: 'api_endpoint', type: 'varchar', length: 512 })
  apiEndpoint!: string;

  @Column({ name: 'secret_key', type: 'varchar', length: 256 })
  secretKey!: string;

  @Column({ name: 'is_disabled', type: 'boolean', default: false })
  isDisabled!: boolean;
}

@Entity({ name: 'casino_games' })
@Unique(['providerId', 'providerGameId'])
export class CasinoGame {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'provider_id', type: 'uuid' })
  providerId!: string;

  @ManyToOne(() => CasinoGameProvider)
  @JoinColumn({ name: 'provider_id' })
  provider!: CasinoGameProvider;

  @Column({ name: 'provider_game_id', type: 'varchar', length: 128 })
  providerGameId!: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ name: 'min_bet', type: 'bigint', default: 1, transformer: bigintToNumber })
  minBet!: number;

  @Column({ name: 'max_bet', type: 'bigint', default: 1000000, transformer: bigintToNumber })
  maxBet!: number;
}

@Entity({ name: 'casino_game_sessions' })
export class CasinoGameSession {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128, unique: true })
  token!: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId!: string;

  @ManyToOne(() => CasinoUser)
  @JoinColumn({ name: 'user_id' })
  user!: CasinoUser;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @ManyToOne(() => CasinoWallet)
  @JoinColumn({ name: 'wallet_id' })
  wallet!: CasinoWallet;

  @Column({ name: 'game_id', type: 'uuid' })
  gameId!: string;

  @ManyToOne(() => CasinoGame)
  @JoinColumn({ name: 'game_id' })
  game!: CasinoGame;

  @Column({ name: 'provider_session_id', type: 'varchar', length: 128, nullable: true })
  providerSessionId!: string | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export type CasinoTxType = 'DEBIT' | 'CREDIT' | 'ROLLBACK' | 'ROLLBACK_TOMBSTONE';

@Entity({ name: 'casino_transactions' })
@Index(['relatedExternalTransactionId'])
@Index(['walletId'])
export class CasinoTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'wallet_id', type: 'uuid' })
  walletId!: string;

  @ManyToOne(() => CasinoWallet)
  @JoinColumn({ name: 'wallet_id' })
  wallet!: CasinoWallet;

  @Column({ name: 'session_id', type: 'uuid', nullable: true })
  sessionId!: string | null;

  @ManyToOne(() => CasinoGameSession, { nullable: true })
  @JoinColumn({ name: 'session_id' })
  session!: CasinoGameSession | null;

  @Column({ name: 'transaction_type', type: 'varchar', length: 32 })
  transactionType!: CasinoTxType;

  @Column({ type: 'bigint', default: 0, transformer: bigintToNumber })
  amount!: number;

  @Column({ name: 'external_transaction_id', type: 'varchar', length: 128, unique: true })
  externalTransactionId!: string;

  @Column({
    name: 'related_external_transaction_id',
    type: 'varchar',
    length: 128,
    nullable: true,
  })
  relatedExternalTransactionId!: string | null;

  @Column({ name: 'balance_after', type: 'bigint', default: 0, transformer: bigintToNumber })
  balanceAfter!: number;

  @Column({ name: 'response_cache', type: 'jsonb' })
  responseCache!: Record<string, unknown>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
