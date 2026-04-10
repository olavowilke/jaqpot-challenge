import {describe, it, expect} from 'vitest';
import {signString, signBuffer, verifySignature} from '../src/shared/hmac.js';

describe('hmac', () => {
    it('signs and verifies a payload', () => {
        const secret = 'topsecret';
        const body = Buffer.from(JSON.stringify({a: 1}));
        const sig = signBuffer(body, secret);
        expect(verifySignature(sig, body, secret)).toBe(true);
    });

    it('rejects tampered body', () => {
        const secret = 'topsecret';
        const sig = signString('{"a":1}', secret);
        expect(verifySignature(sig, Buffer.from('{"a":2}'), secret)).toBe(false);
    });

    it('rejects missing or wrong-length sig', () => {
        expect(verifySignature(undefined, Buffer.from('x'), 's')).toBe(false);
        expect(verifySignature('deadbeef', Buffer.from('x'), 's')).toBe(false);
    });
});
