import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_SKEW_MS, seal, sign } from '../src/calendar/signing.js';

const SECRET = 'test-shared-secret-0123456789';

/**
 * GAS 側 (gas/Code.gs の sign_) と同じ計算を Node で再現する。
 * 片方だけ直したときに気づけるよう、実装をまたいで突き合わせる。
 */
function gasSign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

describe('sign', () => {
  it('GAS 側の HMAC-SHA256(hex) と一致する', async () => {
    const payload = '{"op":"upsert","ts":1756500000000}';
    expect(await sign(payload, SECRET)).toBe(gasSign(payload, SECRET));
  });

  it('日本語を含む本文でも一致する (UTF-8 の扱いが揃っている)', async () => {
    const payload = JSON.stringify({ summary: '💊 ピル 12/28', ts: 1 });
    expect(await sign(payload, SECRET)).toBe(gasSign(payload, SECRET));
  });

  it('シークレットが違えば署名も変わる', async () => {
    const payload = '{"a":1}';
    expect(await sign(payload, SECRET)).not.toBe(await sign(payload, 'other'));
  });

  it('本文が1文字変わるだけで署名が変わる', async () => {
    expect(await sign('{"a":1}', SECRET)).not.toBe(await sign('{"a":2}', SECRET));
  });
});

describe('seal', () => {
  it('タイムスタンプを載せて署名する', async () => {
    const now = 1756500000000;
    const env = await seal({ op: 'remove', eventId: 'dose20260830' }, SECRET, now);

    const body = JSON.parse(env.payload);
    expect(body.op).toBe('remove');
    expect(body.ts).toBe(now);
    expect(env.sig).toBe(gasSign(env.payload, SECRET));
  });

  it('署名は payload そのものに対して行う (再直列化のズレを避ける)', async () => {
    const env = await seal({ op: 'ensureCalendar' }, SECRET, 1);
    // 受信側は payload を JSON.parse する前に、生の文字列で検証できる
    expect(await sign(env.payload, SECRET)).toBe(env.sig);
  });

  it('リプレイ猶予は両側で同じ値を使う', () => {
    expect(MAX_SKEW_MS).toBe(5 * 60 * 1000);
  });
});
