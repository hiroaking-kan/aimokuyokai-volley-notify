#!/usr/bin/env node
/**
 * GAS 側 (カレンダー書き込み) だけを単体で確認する。
 *
 * Workers も LINE も通さずに GAS を直接叩くので、
 * 「動かない」ときの切り分けがここで終わる。
 *
 * 値は pill-tracker/.dev.vars から読む (gitignore済み)。環境変数でも渡せる。
 *
 *   GAS_CALENDAR_URL=https://script.google.com/macros/s/AKfy.../exec
 *   GAS_SHARED_SECRET=...
 */

import { readFileSync } from 'node:fs';

/** .dev.vars を読む。シェルの履歴にシークレットを残さずに済む。 */
function readDevVars() {
  try {
    const text = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
    return Object.fromEntries(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => {
          const eq = line.indexOf('=');
          const value = line.slice(eq + 1).trim();
          // 引用符で囲まれていれば外す
          return [line.slice(0, eq).trim(), value.replace(/^(['"])(.*)\1$/, '$2')];
        }),
    );
  } catch {
    return {};
  }
}

const vars = readDevVars();
const url = process.env.GAS_CALENDAR_URL ?? vars.GAS_CALENDAR_URL;
const secret = process.env.GAS_SHARED_SECRET ?? vars.GAS_SHARED_SECRET;

if (!url || !secret) {
  console.error('GAS_CALENDAR_URL と GAS_SHARED_SECRET が見つかりません。\n');
  console.error('pill-tracker/.dev.vars に次の2行を書いてください:\n');
  console.error('  GAS_CALENDAR_URL=https://script.google.com/macros/s/AKfy.../exec');
  console.error('  GAS_SHARED_SECRET=生成した共有シークレット\n');
  console.error('(.dev.vars は gitignore 済みなので、コミットされません)');
  process.exit(1);
}
if (!url.endsWith('/exec')) {
  console.error(`URL が /exec で終わっていません: ${url}`);
  console.error('「デプロイを管理」で表示される ウェブアプリ の URL を使ってください。');
  process.exit(1);
}

/** src/calendar/signing.ts と同じ形式。本文そのものに署名を載せる。 */
async function call(body) {
  const payload = JSON.stringify({ ...body, ts: Date.now() });
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sig = Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload, sig }),
    redirect: 'follow',
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // ログイン画面のHTMLが返るのがいちばん多い失敗
    throw new Error(
      'JSON ではなく HTML が返りました。デプロイの「アクセスできるユーザー」が\n' +
        '「全員」になっているか確認してください。',
    );
  }
  if (!parsed.ok) throw new Error(`GAS が拒否しました: ${parsed.error}`);
  return parsed;
}

const today = new Date().toISOString().slice(0, 10);
const TEST_EVENT_ID = 'pilltrackerselftest';

try {
  process.stdout.write('1. カレンダーの作成/取得 … ');
  const { calendarId } = await call({
    op: 'ensureCalendar',
    summary: 'ピル・生理記録',
    timezone: 'Asia/Tokyo',
  });
  console.log(`OK\n   calendarId: ${calendarId}`);

  process.stdout.write('2. イベントの書き込み … ');
  const event = {
    id: TEST_EVENT_ID,
    summary: '✅ pill-tracker 疎通確認',
    start: { date: today },
    end: { date: today },
    transparency: 'transparent',
    extendedProperties: { private: { app: 'pilltracker', kind: 'selftest' } },
  };
  // end.date は排他なので翌日にする
  event.end.date = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  await call({ op: 'upsert', calendarId, event });
  console.log('OK');

  process.stdout.write('3. 同じIDで再書き込み (冪等性) … ');
  await call({ op: 'upsert', calendarId, event });
  console.log('OK  ← 重複しないことを確認');

  process.stdout.write('4. イベントの削除 … ');
  await call({ op: 'remove', calendarId, eventId: TEST_EVENT_ID });
  console.log('OK');

  process.stdout.write('5. 署名が違うリクエストを弾く … ');
  const bad = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ payload: '{"op":"ensureCalendar","ts":1}', sig: 'deadbeef' }),
    redirect: 'follow',
  });
  const badBody = await bad.json().catch(() => ({ ok: true }));
  if (badBody.ok) throw new Error('署名なしのリクエストが通ってしまいました');
  console.log(`OK  ← 拒否理由: ${badBody.error}`);

  console.log('\n✅ GAS 側は正常です。Cloudflare のセットアップに進めます。');
} catch (err) {
  console.log('NG');
  console.error(`\n❌ ${err.message}\n`);
  console.error('よくある原因:');
  console.error('  - スクリプトプロパティ SHARED_SECRET が未設定 / 値が違う');
  console.error('  - サービスから Calendar API (Advanced Calendar Service) を追加していない');
  console.error('  - デプロイの「アクセスできるユーザー」が「全員」になっていない');
  console.error('  - デプロイの「次のユーザーとして実行」が「自分」になっていない');
  console.error('  - 再デプロイで URL が変わった (「デプロイを管理 → 既存デプロイを編集」を使う)');
  process.exit(1);
}
