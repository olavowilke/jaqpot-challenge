import { request } from 'undici';
import { signString } from './hmac.js';

export interface SignedPostResult<T = unknown> {
  status: number;
  body: T;
}

export async function signedPost<T = unknown>(
  url: string,
  payload: unknown,
  secret: string,
  headerName: string,
): Promise<SignedPostResult<T>> {
  const body = JSON.stringify(payload);
  const signature = signString(body, secret);
  const res = await request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [headerName]: signature,
    },
    body,
  });
  const text = await res.body.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.statusCode, body: parsed as T };
}
