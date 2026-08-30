/**
 * Workers ⇄ GAS 間の共有シークレットによる署名。
 *
 * GAS のウェブアプリは「全員(匿名含む)」でしか公開できず、
 * doPost からリクエストヘッダも読めない。そこで本文そのものに
 * 署名とタイムスタンプを載せて検証する。
 */

/** 署名対象の生文字列と、その署名を包む封筒。 */
export interface Envelope {
  payload: string;
  sig: string;
}

/** リプレイを弾く猶予。 */
export const MAX_SKEW_MS = 5 * 60 * 1000;

export async function sign(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return toHex(new Uint8Array(mac));
}

export async function seal(body: unknown, secret: string, now: number): Promise<Envelope> {
  const payload = JSON.stringify({ ...(body as object), ts: now });
  return { payload, sig: await sign(payload, secret) };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
