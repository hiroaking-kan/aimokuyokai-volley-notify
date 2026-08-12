import fs from 'node:fs/promises';

import { notify } from './lib/notify.mjs';
import { withBrowser } from './lib/render.mjs';
import { findLink, extractLabeledValue, hasStartClockTime } from './lib/parse.mjs';
import { targets } from './targets.mjs';

const STATE_FILE = 'state/watch_state.json';

// 監視すべきものが全部片付いたことをワークフロー(bash)に伝える終了コード。
// 0 (まだ監視中) / 1 (異常終了) と衝突しない値ならなんでもよい。
const ALL_DONE_EXIT_CODE = 20;

const helpers = { findLink, extractLabeledValue, hasStartClockTime };

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { targets: {} };
  }
}

async function saveState(state) {
  await fs.mkdir('state', { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function runTarget(target, { state, render }) {
  const html = await render(target.url, { waitForSelector: target.waitForSelector });
  const result = await target.inspect({ html, render, helpers });

  const previous = state.targets[target.id] ?? {};
  const now = new Date().toISOString();
  const entry = {
    label: target.label,
    lastValue: result.value ?? null,
    lastCheckedAt: now,
    notifiedValue: previous.notifiedValue ?? null,
    notifiedAt: previous.notifiedAt ?? null,
  };

  console.log(
    `[${target.id}] ready=${Boolean(result.ready)} value=${JSON.stringify(result.value ?? null)}` +
      (result.detail ? ` (${result.detail})` : '')
  );

  // 条件を満たしていて、かつ前回通知した内容と変わっているときだけ通知する。
  const shouldNotify =
    Boolean(result.ready) && result.value != null && result.value !== previous.notifiedValue;

  if (shouldNotify) {
    const body = [result.detail, result.url ? `\nURL: ${result.url}` : null]
      .filter(Boolean)
      .join('\n');
    await notify(`🔔 ${target.label}`, body || String(result.value));
    entry.notifiedValue = result.value;
    entry.notifiedAt = now;
  }

  state.targets[target.id] = entry;
  return { notified: shouldNotify, done: entry.notifiedValue != null };
}

async function main() {
  if (process.env.TEST_MODE === '1') {
    await notify(
      '✅ Watch テスト通知',
      `これはテスト通知です。\nLINE / メールの設定が正しく動作しています。\n\n送信時刻: ${new Date().toISOString()}`
    );
    console.log('Test notification sent.');
    return;
  }

  const enabled = targets.filter((t) => t.enabled);
  if (enabled.length === 0) {
    console.log('有効な監視対象がありません (scripts/targets.mjs の enabled を確認)。');
    process.exitCode = ALL_DONE_EXIT_CODE;
    return;
  }

  const state = await loadState();
  state.targets ??= {};

  const failures = [];
  let notifiedCount = 0;
  let doneCount = 0;

  await withBrowser(async ({ render }) => {
    for (const target of enabled) {
      try {
        const { notified, done } = await runTarget(target, { state, render });
        if (notified) notifiedCount++;
        if (done) doneCount++;
      } catch (err) {
        // 1つコケても他の監視は続ける。
        console.error(`[${target.id}] FAILED:`, err);
        failures.push(`${target.label}: ${err.message}`);
      }
    }
  });

  await saveState(state);

  if (failures.length > 0) {
    await notify('⚠️ Watch 失敗', failures.join('\n\n').slice(0, 2000));
  }

  console.log(
    `Done. targets=${enabled.length} notified=${notifiedCount} failed=${failures.length}`
  );

  // 有効な対象がすべて通知済みになったら、もう見張るものは無い。
  if (failures.length === 0 && doneCount === enabled.length) {
    console.log('すべての監視対象が通知済みです。監視を終了します。');
    process.exitCode = ALL_DONE_EXIT_CODE;
  }
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  try {
    await notify('⚠️ Watch failed', String(err?.stack ?? err).slice(0, 2000));
  } catch (e) {
    console.error('failed to notify about failure:', e);
  }
  process.exit(1);
});
