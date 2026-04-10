import {Router, type Request, type Response, type NextFunction} from 'express';
import crypto from 'node:crypto';
import {z} from 'zod';
import {AppDataSource} from '../db/data-source.js';
import {
    ProviderBet,
    ProviderCasino,
    ProviderCustomer,
    ProviderGame,
    ProviderGameRound,
} from '../entities/provider.js';
import {AppError} from '../shared/errors.js';
import {makeVerifyMiddleware} from '../shared/hmac.js';
import {signedPost} from '../shared/http.js';
import {config} from '../config.js';

const verifyProviderSig = makeVerifyMiddleware('x-provider-signature', config.PROVIDER_SECRET);

export const providerRouter = Router();

const wrap =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
        (req: Request, res: Response, next: NextFunction) => {
            fn(req, res, next).catch(next);
        };

const LaunchSchema = z.object({
    casinoSessionToken: z.string(),
    userId: z.string(),
    casinoCode: z.string(),
    providerGameId: z.string(),
    currency: z.string(),
});

providerRouter.post(
    '/launch',
    verifyProviderSig,
    wrap(async (req, res) => {
        const input = LaunchSchema.parse(req.body);

        const game = await AppDataSource.getRepository(ProviderGame).findOneBy({
            gameId: input.providerGameId,
        });
        if (!game) throw new AppError(404, 'PROVIDER_GAME_NOT_FOUND', 'Game not found');
        if (!game.isActive) throw new AppError(409, 'PROVIDER_GAME_INACTIVE', 'Game inactive');

        const casino = await AppDataSource.getRepository(ProviderCasino).findOneBy({
            casinoCode: input.casinoCode,
        });
        if (!casino) throw new AppError(404, 'CASINO_NOT_FOUND', 'Casino not found');
        if (!casino.isActive) throw new AppError(409, 'CASINO_INACTIVE', 'Casino is not active');

        const playerKey = `${input.casinoCode}:${input.userId}`;
        const customerRepo = AppDataSource.getRepository(ProviderCustomer);
        let customer = await customerRepo.findOneBy({playerId: playerKey});
        if (!customer) {
            try {
                customer = await customerRepo.save(
                    customerRepo.create({
                        playerId: playerKey,
                        casinoId: casino.id,
                        externalUserId: input.userId,
                    }),
                );
            } catch {
                customer = await customerRepo.findOneByOrFail({playerId: playerKey});
            }
        }

        const providerSessionId = crypto.randomUUID();

        res.json({
            providerSessionId,
            customerId: customer.id,
            playerId: playerKey,
            providerInternalGameId: game.id,
            currency: input.currency,
        });
    }),
);


/**
 Simulate is invoked by the casino with all the provider-side context it
 already obtained from /provider/launch. The provider therefore never
 reads any CASINO_* table — it only touches its own domain and calls back
 to the casino over HTTP.
 **/
const SimulateSchema = z.object({
    casinoCode: z.string(),
    casinoSessionToken: z.string(),
    providerSessionId: z.string(),
    customerId: z.string().uuid(),
    providerInternalGameId: z.string().uuid(),
    currency: z.string(),
});

interface CasinoOk {
    status: string;
    balance: number;
    transactionId?: string;
}

providerRouter.post(
    '/simulate',
    verifyProviderSig,
    wrap(async (req, res) => {
        const input = SimulateSchema.parse(req.body);
        const trace: Array<{ step: string; result: unknown }> = [];

        const casinoRow = await AppDataSource.getRepository(ProviderCasino).findOneBy({
            casinoCode: input.casinoCode,
        });
        if (!casinoRow) throw new AppError(404, 'CASINO_NOT_FOUND', 'Casino not found');
        if (!casinoRow.isActive) throw new AppError(409, 'CASINO_INACTIVE', 'Casino is not active');

        const casino = <T = CasinoOk>(path: string, body: unknown) =>
            signedPost<T>(
                `${casinoRow.casinoApiEndpoint}${path}`,
                body,
                casinoRow.casinoSecret,
                'x-casino-signature',
            );

        const initBal = await casino('/casino/getBalance', {sessionToken: input.casinoSessionToken});
        if (initBal.status >= 400) throw new AppError(502, 'BALANCE_CHECK_FAILED', 'getBalance failed');
        trace.push({step: 'getBalance', result: initBal.body});
        const initialBalance = (initBal.body as CasinoOk).balance;

        const playerRow = await AppDataSource.getRepository(ProviderCustomer).findOneBy({
            id: input.customerId,
        });
        const gameRow = await AppDataSource.getRepository(ProviderGame).findOneBy({
            id: input.providerInternalGameId,
        });
        if (!playerRow || !gameRow) {
            throw new AppError(404, 'PROVIDER_STATE_MISSING', 'Provider customer/game not found');
        }

        const roundExternalId = crypto.randomUUID();
        const roundRepo = AppDataSource.getRepository(ProviderGameRound);
        const round = await roundRepo.save(
            roundRepo.create({
                roundId: roundExternalId,
                sessionId: input.providerSessionId,
                playerId: playerRow.id,
                gameId: gameRow.id,
                currency: input.currency,
                status: 'OPEN',
            }),
        );

        const betRepo = AppDataSource.getRepository(ProviderBet);
        const recordBet = async (
            transactionId: string,
            betType: string,
            amount: number,
            status: string,
            response: unknown,
            balanceAfter: number | null,
        ) => {
            await betRepo.insert({
                transactionId,
                roundId: round.id,
                betType,
                amount,
                casinoBalanceAfter: balanceAfter,
                status,
                responseCache: response as never,
            });
        };

        const bet1Id = crypto.randomUUID();
        const bet1Amount = 500;
        const bet1 = await casino('/casino/debit', {
            transactionId: bet1Id,
            sessionToken: input.casinoSessionToken,
            amount: bet1Amount,
            roundId: roundExternalId,
        });
        trace.push({step: 'debit#1', result: bet1.body});
        if (bet1.status >= 400) throw new AppError(502, 'DEBIT_FAILED', 'debit#1 failed');
        await recordBet(bet1Id, 'BET', bet1Amount, 'OK', bet1.body, (bet1.body as CasinoOk).balance);

        const bet2Id = crypto.randomUUID();
        const bet2Amount = 300;
        const bet2 = await casino('/casino/debit', {
            transactionId: bet2Id,
            sessionToken: input.casinoSessionToken,
            amount: bet2Amount,
            roundId: roundExternalId,
        });
        trace.push({step: 'debit#2', result: bet2.body});
        if (bet2.status >= 400) throw new AppError(502, 'DEBIT_FAILED', 'debit#2 failed');
        await recordBet(bet2Id, 'BET', bet2Amount, 'OK', bet2.body, (bet2.body as CasinoOk).balance);

        const winId = crypto.randomUUID();
        const winAmount = 1200;
        const win = await casino('/casino/credit', {
            transactionId: winId,
            sessionToken: input.casinoSessionToken,
            amount: winAmount,
            relatedTransactionId: bet1Id,
            roundId: roundExternalId,
        });
        trace.push({step: 'credit', result: win.body});
        if (win.status >= 400) throw new AppError(502, 'CREDIT_FAILED', 'credit failed');
        await recordBet(winId, 'WIN', winAmount, 'OK', win.body, (win.body as CasinoOk).balance);

        const rbId = crypto.randomUUID();
        const rb = await casino('/casino/rollback', {
            transactionId: rbId,
            originalTransactionId: bet2Id,
            sessionToken: input.casinoSessionToken,
        });
        trace.push({step: 'rollback', result: rb.body});
        if (rb.status >= 400) throw new AppError(502, 'ROLLBACK_FAILED', 'rollback failed');
        await recordBet(rbId, 'ROLLBACK', bet2Amount, 'OK', rb.body, (rb.body as CasinoOk).balance);

        await roundRepo.update(round.id, {
            status: 'CLOSED',
            totalBetAmount: bet1Amount + bet2Amount,
            totalPayoutAmount: winAmount,
        });

        const finalBal = await casino('/casino/getBalance', {sessionToken: input.casinoSessionToken});
        trace.push({step: 'getBalance', result: finalBal.body});
        const finalBalance = (finalBal.body as CasinoOk).balance;

        const expected = initialBalance - bet1Amount + winAmount;

        res.json({
            roundId: roundExternalId,
            initialBalance,
            finalBalance,
            expectedBalance: expected,
            consistent: finalBalance === expected,
            trace,
        });
    }),
);
