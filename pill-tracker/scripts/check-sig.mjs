#!/usr/bin/env node
/**
 * 署名が合わないときの切り分け用。
 *
 * GASエディタで diagnose() を実行したログと、この出力を突き合わせる。
 *   指紋が違う            → 共有シークレットの値が違う
 *   指紋は同じで署名が違う → 文字コードの扱いが食い違っている
 *
 * シークレットそのものは出力しない。指紋は SHA-256 の先頭12桁なので、
 * ここから元の値は逆算できず、貼って共有しても安全。
 */

import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

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
          return [line.slice(0, eq).trim(), value.replace(/^(['"])(.*)\1$/, '$2')];
        }),
    );
  } catch {
    return {};
  }
}

const secret = process.env.GAS_SHARED_SECRET ?? readDevVars().GAS_SHARED_SECRET;
if (!secret) {
  console.error('GAS_SHARED_SECRET が見つかりません (.dev.vars を確認してください)');
  process.exit(1);
}

const hmac = (payload) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
const fingerprint = createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);

console.log('secret fingerprint :', fingerprint);
console.log('secret length      :', String(secret.length));
console.log('sig (ascii)        :', hmac('{"op":"ping","ts":1}'));
console.log('sig (japanese)     :', hmac('{"op":"ping","name":"ピル","ts":1}'));
console.log('');
console.log('GASエディタで diagnose() を実行し、実行ログの4行と見比べてください。');
console.log('  指紋が違う             → 共有シークレットの値が違う');
console.log('  指紋は同じで署名が違う → 文字コードの扱いが食い違っている');
