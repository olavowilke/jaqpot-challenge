import {Router, type Request, type Response, type NextFunction} from 'express';
import crypto from 'node:crypto';
import {z} from 'zod';
import type {EntityManager, QueryFailedError} from 'typeorm';
import {AppDataSource} from '../db/data-source.js';
import {
    CasinoGame,
    CasinoGameProvider,
    CasinoGameSession,
    CasinoTransaction,
    CasinoUser,
    CasinoWallet,
} from '../entities/casino.js';
import {AppError} from '../shared/errors.js';
import {makeVerifyMiddleware} from '../shared/hmac.js';
import {signedPost} from '../shared/http.js';
import {config} from '../config.js';

const verifyCasinoSig = makeVerifyMiddleware('x-casino-signature', config.CASINO_SECRET);

export const casinoRouter = Router();

const wrap =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
        (req: Request, res: Response, next: NextFunction) => {
            fn(req, res, next).catch(next);
        };

const isUniqueViolation = (e: unknown) =>
    (e as QueryFailedError & { code?: string }).code === '23505';

// ---------- helpers ----------

async function findCachedTx(
    manager: EntityManager,
    externalId: string,
): Promise<CasinoTransaction | null> {
    return manager.getRepository(CasinoTransaction).findOne({
        where: {externalTransactionId: externalId},
    });
}

async function loadSessionByToken(
    manager: EntityManager,
    token: string,
): Promise<CasinoGameSession & { wallet: CasinoWallet }> {
    const session = await manager.getRepository(CasinoGameSession).findOne({
        where: {token},
        relations: {wallet: true},
    });
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
    return session as CasinoGameSession & { wallet: CasinoWallet };
}

const LaunchGameSchema = z.object({
    userId: z.string().uuid().optional(),
    gameId: z.string().uuid().optional(),
    currency: z.string().default('USD'),
});

casinoRouter.post(
    '/launchGame',
    wrap(async (req, res) => {
        const input = LaunchGameSchema.parse(req.body ?? {});
        const userId = input.userId ?? '11111111-1111-1111-1111-111111111111';
        const gameId = input.gameId ?? '44444444-4444-4444-4444-444444444444';

        const userRepo = AppDataSource.getRepository(CasinoUser);
        const walletRepo = AppDataSource.getRepository(CasinoWallet);
        const gameRepo = AppDataSource.getRepository(CasinoGame);
        const providerRepo = AppDataSource.getRepository(CasinoGameProvider);
        const sessionRepo = AppDataSource.getRepository(CasinoGameSession);

        const user = await userRepo.findOneBy({id: userId});
        if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found');

        const wallet = await walletRepo.findOneBy({userId, currencyCode: input.currency});
        if (!wallet) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found');

        const game = await gameRepo.findOneBy({id: gameId});
        if (!game || !game.isActive) {
            throw new AppError(409, 'GAME_UNAVAILABLE', 'Game unavailable');
        }
        const provider = await providerRepo.findOneBy({id: game.providerId});
        if (!provider || provider.isDisabled) {
            throw new AppError(409, 'PROVIDER_DISABLED', 'Provider disabled');
        }

        const token = crypto.randomUUID();
        const session = await sessionRepo.save(
            sessionRepo.create({
                token,
                userId,
                walletId: wallet.id,
                gameId,
                isActive: true,
            }),
        );

        const launchResp = await signedPost<{
            providerSessionId: string;
            customerId: string;
            providerInternalGameId: string;
            currency: string;
        }>(
            `${config.PROVIDER_BASE_URL}/provider/launch`,
            {
                casinoSessionToken: token,
                userId,
                casinoCode: 'JAQPOT',
                providerGameId: game.providerGameId,
                currency: input.currency,
            },
            config.PROVIDER_SECRET,
            'x-provider-signature',
        );
        if (launchResp.status >= 400 || !launchResp.body) {
            throw new AppError(502, 'PROVIDER_LAUNCH_FAILED', 'Provider launch failed');
        }
        const {providerSessionId, customerId, providerInternalGameId} = launchResp.body;

        await sessionRepo.update(session.id, {providerSessionId});

        res.json({
            sessionToken: token,
            sessionId: session.id,
            providerSessionId,
            customerId,
            providerInternalGameId,
            currency: input.currency,
        });
    }),
);

const GetBalanceSchema = z.object({sessionToken: z.string()});

casinoRouter.post(
    '/getBalance',
    verifyCasinoSig,
    wrap(async (req, res) => {
        const input = GetBalanceSchema.parse(req.body);
        const session = await loadSessionByToken(AppDataSource.manager, input.sessionToken);
        res.json({
            sessionToken: input.sessionToken,
            userId: session.userId,
            currency: session.wallet.currencyCode,
            balance: session.wallet.playableBalance,
        });
    }),
);

const DebitSchema = z.object({
    transactionId: z.string().min(1),
    sessionToken: z.string(),
    amount: z.number().int().positive(),
    roundId: z.string().optional(),
});

casinoRouter.post(
    '/debit',
    verifyCasinoSig,
    wrap(async (req, res) => {
        const input = DebitSchema.parse(req.body);

        const result = await AppDataSource.transaction(async (manager) => {
            const cached = await findCachedTx(manager, input.transactionId);
            if (cached) {
                const session = await loadSessionByToken(manager, input.sessionToken);
                const liveWallet = await manager.getRepository(CasinoWallet).findOneBy({
                    id: session.walletId,
                });
                return {
                    ...(cached.responseCache as { status: string }),
                    balance: liveWallet ? liveWallet.playableBalance : undefined,
                } as { status: string; balance?: number };
            }

            const session = await loadSessionByToken(manager, input.sessionToken);
            const wallet = await manager.getRepository(CasinoWallet).findOne({
                where: {id: session.walletId},
                lock: {mode: 'pessimistic_write'},
            });
            if (!wallet) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found');

            if (wallet.playableBalance < input.amount) {
                const failPayload = {
                    status: 'INSUFFICIENT_FUNDS',
                    transactionId: input.transactionId,
                    balance: wallet.playableBalance,
                };
                try {
                    await manager.getRepository(CasinoTransaction).insert({
                        walletId: wallet.id,
                        sessionId: session.id,
                        transactionType: 'DEBIT',
                        amount: input.amount,
                        externalTransactionId: input.transactionId,
                        balanceAfter: wallet.playableBalance,
                        responseCache: failPayload,
                    });
                } catch (e) {
                    if (isUniqueViolation(e)) {
                        const replay = await findCachedTx(manager, input.transactionId);
                        if (replay) return replay.responseCache as { status: string };
                    }
                    throw e;
                }
                return failPayload;
            }

            const newBalance = wallet.playableBalance - input.amount;
            await manager.getRepository(CasinoWallet).update(
                {id: wallet.id},
                {playableBalance: newBalance},
            );
            const okPayload = {
                status: 'OK',
                transactionId: input.transactionId,
                balance: newBalance,
            };
            try {
                await manager.getRepository(CasinoTransaction).insert({
                    walletId: wallet.id,
                    sessionId: session.id,
                    transactionType: 'DEBIT',
                    amount: input.amount,
                    externalTransactionId: input.transactionId,
                    balanceAfter: newBalance,
                    responseCache: okPayload,
                });
            } catch (e) {
                if (isUniqueViolation(e)) {
                    throw new AppError(409, 'CONCURRENT_RETRY', 'Concurrent retry; please retry');
                }
                throw e;
            }
            return okPayload;
        });

        if (result.status === 'INSUFFICIENT_FUNDS') {
            res.status(402).json(result);
            return;
        }
        res.json(result);
    }),
);

const CreditSchema = z.object({
    transactionId: z.string().min(1),
    sessionToken: z.string(),
    amount: z.number().int().nonnegative(),
    relatedTransactionId: z.string().optional(),
    roundId: z.string().optional(),
});

casinoRouter.post(
    '/credit',
    verifyCasinoSig,
    wrap(async (req, res) => {
        const input = CreditSchema.parse(req.body);

        const result = await AppDataSource.transaction(async (manager) => {
            const cached = await findCachedTx(manager, input.transactionId);
            if (cached) {
                const session = await loadSessionByToken(manager, input.sessionToken);
                const liveWallet = await manager.getRepository(CasinoWallet).findOneBy({
                    id: session.walletId,
                });
                return {
                    ...(cached.responseCache as Record<string, unknown>),
                    balance: liveWallet ? liveWallet.playableBalance : undefined,
                };
            }

            const session = await loadSessionByToken(manager, input.sessionToken);
            const wallet = await manager.getRepository(CasinoWallet).findOne({
                where: {id: session.walletId},
                lock: {mode: 'pessimistic_write'},
            });
            if (!wallet) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found');

            const newBalance = wallet.playableBalance + input.amount;
            await manager.getRepository(CasinoWallet).update(
                {id: wallet.id},
                {playableBalance: newBalance},
            );
            const okPayload = {
                status: 'OK',
                transactionId: input.transactionId,
                balance: newBalance,
            };
            try {
                await manager.getRepository(CasinoTransaction).insert({
                    walletId: wallet.id,
                    sessionId: session.id,
                    transactionType: 'CREDIT',
                    amount: input.amount,
                    externalTransactionId: input.transactionId,
                    relatedExternalTransactionId: input.relatedTransactionId ?? null,
                    balanceAfter: newBalance,
                    responseCache: okPayload,
                });
            } catch (e) {
                if (isUniqueViolation(e)) {
                    throw new AppError(409, 'CONCURRENT_RETRY', 'Concurrent retry; please retry');
                }
                throw e;
            }
            return okPayload;
        });

        res.json(result);
    }),
);

const RollbackSchema = z.object({
    transactionId: z.string().min(1),
    originalTransactionId: z.string().min(1),
    sessionToken: z.string(),
});

casinoRouter.post(
    '/rollback',
    verifyCasinoSig,
    wrap(async (req, res) => {
        const input = RollbackSchema.parse(req.body);

        const result = await AppDataSource.transaction(async (manager) => {
            const cached = await findCachedTx(manager, input.transactionId);
            if (cached) return cached.responseCache;

            const session = await loadSessionByToken(manager, input.sessionToken);
            const txRepo = manager.getRepository(CasinoTransaction);

            const original = await txRepo.findOne({
                where: {externalTransactionId: input.originalTransactionId},
            });

            if (!original) {
                const tombPayload = {
                    status: 'OK',
                    transactionId: input.transactionId,
                    tombstone: true,
                    balance: session.wallet.playableBalance,
                };
                await txRepo.insert({
                    walletId: session.walletId,
                    sessionId: session.id,
                    transactionType: 'ROLLBACK_TOMBSTONE',
                    amount: 0,
                    externalTransactionId: input.transactionId,
                    relatedExternalTransactionId: input.originalTransactionId,
                    balanceAfter: session.wallet.playableBalance,
                    responseCache: tombPayload,
                });
                return tombPayload;
            }

            if (original.transactionType !== 'DEBIT') {
                throw new AppError(409, 'ROLLBACK_NOT_ALLOWED', 'Only DEBIT transactions can be rolled back');
            }

            const existingCredit = await txRepo.findOne({
                where: {
                    relatedExternalTransactionId: input.originalTransactionId,
                    transactionType: 'CREDIT',
                },
            });
            if (existingCredit) {
                throw new AppError(409, 'ROLLBACK_AFTER_PAYOUT', 'Cannot rollback a bet that has a payout');
            }

            const wallet = await manager.getRepository(CasinoWallet).findOne({
                where: {id: original.walletId},
                lock: {mode: 'pessimistic_write'},
            });
            if (!wallet) throw new AppError(404, 'WALLET_NOT_FOUND', 'Wallet not found');

            const refund = original.amount;
            const newBalance = wallet.playableBalance + refund;
            await manager.getRepository(CasinoWallet).update(
                {id: wallet.id},
                {playableBalance: newBalance},
            );

            const okPayload = {
                status: 'OK',
                transactionId: input.transactionId,
                balance: newBalance,
                rolledBack: input.originalTransactionId,
            };
            try {
                await txRepo.insert({
                    walletId: wallet.id,
                    sessionId: session.id,
                    transactionType: 'ROLLBACK',
                    amount: refund,
                    externalTransactionId: input.transactionId,
                    relatedExternalTransactionId: input.originalTransactionId,
                    balanceAfter: newBalance,
                    responseCache: okPayload,
                });
            } catch (e) {
                if (isUniqueViolation(e)) {
                    throw new AppError(409, 'CONCURRENT_RETRY', 'Concurrent retry; please retry');
                }
                throw e;
            }
            return okPayload;
        });

        res.json(result);
    }),
);

casinoRouter.post(
    '/simulateRound',
    wrap(async (req, res) => {
        const casinoCode = (req.body && typeof req.body.casinoCode === 'string')
            ? req.body.casinoCode
            : 'JAQPOT';
        const launchResp = await signedPost<{
            sessionToken: string;
            providerSessionId: string;
            customerId: string;
            providerInternalGameId: string;
            currency: string;
        }>(
            `${config.CASINO_BASE_URL}/casino/launchGame`,
            req.body ?? {},
            config.CASINO_SECRET,
            'x-casino-signature',
        );
        if (launchResp.status >= 400 || !launchResp.body) {
            throw new AppError(502, 'LAUNCH_FAILED', 'launchGame failed');
        }
        const {sessionToken, providerSessionId, customerId, providerInternalGameId, currency} =
            launchResp.body;

        const simResp = await signedPost(
            `${config.PROVIDER_BASE_URL}/provider/simulate`,
            {
                casinoCode,
                casinoSessionToken: sessionToken,
                providerSessionId,
                customerId,
                providerInternalGameId,
                currency,
            },
            config.PROVIDER_SECRET,
            'x-provider-signature',
        );

        res.status(simResp.status).json({
            sessionToken,
            providerSessionId,
            provider: simResp.body,
        });
    }),
);
