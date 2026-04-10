import type {NextFunction, Request, Response} from 'express';

export class AppError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}

export function errorMiddleware(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
) {
    if (err instanceof AppError) {
        res.status(err.status).json({error: {code: err.code, message: err.message}});
        return;
    }
    console.error('unhandled', err);
    res.status(500).json({error: {code: 'INTERNAL', message: 'Internal server error'}});
}
