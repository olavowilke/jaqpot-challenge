import {
    Column,
    CreateDateColumn,
    Entity,
    JoinColumn,
    ManyToOne,
    PrimaryGeneratedColumn,
} from 'typeorm';
import {bigintToNumber} from './transformers.js';

@Entity({name: 'provider_games'})
export class ProviderGame {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({name: 'game_id', type: 'varchar', length: 128, unique: true})
    gameId!: string;

    @Column({name: 'is_active', type: 'boolean', default: true})
    isActive!: boolean;

    @Column({name: 'min_bet', type: 'bigint', default: 1, transformer: bigintToNumber})
    minBet!: number;

    @Column({name: 'max_bet', type: 'bigint', default: 1000000, transformer: bigintToNumber})
    maxBet!: number;
}

@Entity({name: 'provider_casinos'})
export class ProviderCasino {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({name: 'casino_code', type: 'varchar', length: 64, unique: true})
    casinoCode!: string;

    @Column({type: 'varchar', length: 128})
    name!: string;

    @Column({name: 'casino_api_endpoint', type: 'varchar', length: 512})
    casinoApiEndpoint!: string;

    @Column({name: 'casino_secret', type: 'varchar', length: 256})
    casinoSecret!: string;

    @Column({name: 'is_active', type: 'boolean', default: true})
    isActive!: boolean;

    @CreateDateColumn({name: 'created_at', type: 'timestamptz'})
    createdAt!: Date;
}

@Entity({name: 'provider_customers'})
export class ProviderCustomer {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({name: 'player_id', type: 'varchar', length: 128, unique: true})
    playerId!: string;

    @Column({name: 'casino_id', type: 'uuid'})
    casinoId!: string;

    @ManyToOne(() => ProviderCasino)
    @JoinColumn({name: 'casino_id'})
    casino!: ProviderCasino;

    @Column({name: 'external_user_id', type: 'varchar', length: 128})
    externalUserId!: string;

    @CreateDateColumn({name: 'created_at', type: 'timestamptz'})
    createdAt!: Date;
}

@Entity({name: 'provider_game_rounds'})
export class ProviderGameRound {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({name: 'round_id', type: 'varchar', length: 128, unique: true})
    roundId!: string;

    @Column({name: 'session_id', type: 'varchar', length: 128})
    sessionId!: string;

    @Column({name: 'player_id', type: 'uuid'})
    playerId!: string;

    @ManyToOne(() => ProviderCustomer)
    @JoinColumn({name: 'player_id'})
    player!: ProviderCustomer;

    @Column({name: 'game_id', type: 'uuid'})
    gameId!: string;

    @ManyToOne(() => ProviderGame)
    @JoinColumn({name: 'game_id'})
    game!: ProviderGame;

    @Column({type: 'varchar', length: 8})
    currency!: string;

    @Column({type: 'varchar', length: 16, default: 'OPEN'})
    status!: string;

    @Column({name: 'total_bet_amount', type: 'bigint', default: 0, transformer: bigintToNumber})
    totalBetAmount!: number;

    @Column({name: 'total_payout_amount', type: 'bigint', default: 0, transformer: bigintToNumber})
    totalPayoutAmount!: number;

    @CreateDateColumn({name: 'created_at', type: 'timestamptz'})
    createdAt!: Date;
}

@Entity({name: 'provider_bets'})
export class ProviderBet {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({name: 'transaction_id', type: 'varchar', length: 128, unique: true})
    transactionId!: string;

    @Column({name: 'round_id', type: 'uuid'})
    roundId!: string;

    @ManyToOne(() => ProviderGameRound)
    @JoinColumn({name: 'round_id'})
    round!: ProviderGameRound;

    @Column({name: 'bet_type', type: 'varchar', length: 32})
    betType!: string;

    @Column({type: 'bigint', transformer: bigintToNumber})
    amount!: number;

    @Column({
        name: 'casino_balance_after',
        type: 'bigint',
        nullable: true,
        transformer: bigintToNumber,
    })
    casinoBalanceAfter!: number | null;

    @Column({type: 'varchar', length: 32})
    status!: string;

    @Column({name: 'response_cache', type: 'jsonb', nullable: true})
    responseCache!: Record<string, unknown> | null;

    @CreateDateColumn({name: 'created_at', type: 'timestamptz'})
    createdAt!: Date;
}
