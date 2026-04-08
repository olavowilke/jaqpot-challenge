import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from './errors.js';

export function signBuffer(body: Buffer, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function signString(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function verifySignature(providedSig: string | undefined, body: Buffer, secret: string): boolean {
  if (!providedSig) return false;
  const expected = signBuffer(body, secret);
  try {
    const a = Buffer.from(providedSig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function makeVerifyMiddleware(headerName: string, secret: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sig = req.header(headerName);
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0);
    if (!verifySignature(sig, raw, secret)) {
      return next(new AppError(401, 'BAD_SIGNATURE', `Invalid or missing ${headerName}`));
    }
    next();
  };
}
