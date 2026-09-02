/**
 * x-line-signature の検証。
 *
 * GAS の doPost ではリクエストヘッダが読めずこれができない。
 * 健康データを扱う以上ここは譲れないので、Cloudflare Workers を選んでいる。
 */
export async function verifySignature(
  channelSecret: string,
  body: string,
  signature: string | null,
): Promise<boolean> {
  if (!signature) return false;

  let expected: Uint8Array;
  try {
    expected = base64ToBytes(signature);
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  // crypto.subtle.verify は定数時間で比較する
  return crypto.subtle.verify('HMAC', key, expected, new TextEncoder().encode(body));
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
