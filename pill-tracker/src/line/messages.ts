import { addDays, diffDays, formatMd } from '../domain/dates.js';
import type { Prediction } from '../domain/predict.js';
import { ACTIVE_LEN, isPlacebo, SHEET_LEN } from '../domain/sheet.js';
import { hmToMinutes, isQuietHour, minutesToHm, offsetFrom } from '../domain/logicalDate.js';
import type { QuickReplyItem } from './client.js';

export const QR = {
  dose: (date: string): QuickReplyItem => ({ label: '飲んだ', data: `action=dose&date=${date}` }),
  periodStart: (date: string): QuickReplyItem => ({
    label: '生理きた',
    data: `action=period_start&date=${date}`,
  }),
  periodEnd: (date: string): QuickReplyItem => ({
    label: '生理おわった',
    data: `action=period_end&date=${date}`,
  }),
  none: (): QuickReplyItem => ({ label: 'なんでもない', data: 'action=none' }),
  predict: (): QuickReplyItem => ({ label: '予測を見る', data: 'action=predict' }),
  undo: (): QuickReplyItem => ({ label: '取り消し', data: 'action=undo' }),
};

export function sheetLabel(day: number): string {
  return isPlacebo(day)
    ? `シート ${day}/${SHEET_LEN}日目（プラセボ ${day - ACTIVE_LEN}日目）`
    : `シート ${day}/${SHEET_LEN}日目（実薬）`;
}

export function doseRecorded(date: string, day: number | null, streak: number): string {
  const lines = [`💊 ${formatMd(date)} 記録しました`];
  if (day !== null) lines.push(`   ${sheetLabel(day)} ／ ${streak}日連続`);
  else lines.push(`   ${streak}日連続`);
  return lines.join('\n');
}

export function doseAlready(date: string, takenAt: string): string {
  return `${formatMd(date)} はすでに記録済みです（${takenAt}）`;
}

export function periodRecorded(
  date: string,
  lag: number | null,
  next: Prediction | null,
): string {
  const lines = [`🩸 ${formatMd(date)} 生理開始を記録しました`];
  if (lag !== null) lines.push(`   プラセボ開始から ${lag}日目`);
  if (next) {
    lines.push(`   次のプラセボ期間: ${formatMd(next.placeboStart)} 〜 ${formatMd(addDays(next.placeboStart, SHEET_LEN - ACTIVE_LEN - 1))}`);
    lines.push(`   次回出血予測: ${formatMd(next.date)} ごろ ± ${next.band}日`);
  }
  return lines.join('\n');
}

export function periodClosed(start: string, end: string): string {
  return `🩸 ${formatMd(start)} 〜 ${formatMd(end)}（${diffDays(start, end) + 1}日間）で記録しました`;
}

export function sheetStarted(date: string): string {
  return [
    `📦 ${formatMd(date)} を1錠目としてシートを開始しました`,
    `   実薬 1〜${ACTIVE_LEN}日目、プラセボ ${ACTIVE_LEN + 1}〜${SHEET_LEN}日目`,
    '   先6か月ぶんのプラセボ期間と予測をカレンダーに書き出しました',
  ].join('\n');
}

export function predictionSummary(
  today: string,
  day: number | null,
  next: Prediction | null,
  confidence: string,
): string {
  const lines: string[] = [];
  if (day !== null) lines.push(`今日は ${sheetLabel(day)}`);
  if (!next) {
    lines.push('シートの起点が未設定です。「新しいシート」と送ると今日を1錠目にします。');
    return lines.join('\n');
  }
  lines.push(`次のプラセボ期間: ${formatMd(next.placeboStart)} から4日間`);
  lines.push(`次回出血予測: ${formatMd(next.date)} ごろ ± ${next.band}日`);
  if (confidence !== 'high') lines.push('（実測の記録が少ないため参考値です）');
  else lines.push(`（あと ${diffDays(today, next.date)}日）`);
  return lines.join('\n');
}

export function statusSummary(
  day: number | null,
  streak: number,
  recordedToday: boolean,
  next: Prediction | null,
  notifiable?: boolean,
  reason?: string,
): string {
  const lines = [
    recordedToday ? '💊 今日は記録済み' : '💊 今日はまだ記録がありません',
    `   ${streak}日連続`,
  ];
  if (day !== null) lines.push(`   ${sheetLabel(day)}`);
  if (next) lines.push(`🩸 次回出血予測: ${formatMd(next.date)} ごろ ± ${next.band}日`);
  if (notifiable !== undefined) {
    lines.push(notifiable ? '📨 通知は届きます' : '🔕 通知は届きません');
    if (reason) lines.push(`   ${reason}`);
  }
  return lines.join('\n');
}

export function allowed(userId: string, added: boolean): string {
  return added
    ? `✅ 登録しました\n   ${userId}\n   本人が「新しいシート」と送れば使い始められます`
    : `すでに登録済みです\n   ${userId}`;
}

export function disallowed(userId: string, removed: boolean): string {
  return removed
    ? `🚫 登録を解除しました\n   ${userId}\n   （記録は残ります）`
    : `登録されていません\n   ${userId}`;
}

export function members(
  rows: readonly { line_user_id: string; display_name: string | null }[],
  owners: readonly string[],
): string {
  const lines = ['👥 利用できる人'];
  for (const id of owners) lines.push(`   ${label(id, null)}（管理者・通知なし）`);
  for (const row of rows) lines.push(`   ${label(row.line_user_id, row.display_name)}`);
  if (rows.length === 0) lines.push('   （管理者のほかに登録された人はいません）');
  lines.push('');
  lines.push('定期通知が届くのは、管理者を除いた上の一覧の人だけです。');
  lines.push('追加: 「許可 Uxxxx…」／ 解除: 「解除 Uxxxx…」');
  return lines.join('\n');
}

/** userId をそのまま並べると読めないので、表示名か先頭6文字にする。 */
function label(userId: string, displayName: string | null): string {
  return displayName?.trim() ? displayName.trim() : userId.slice(0, 9) + '…';
}

export function notOwner(): string {
  return 'この操作は管理者だけができます';
}

/**
 * 通知の予定時刻を、実際に送られる形で見せる。
 * 深夜帯にかかって送られない分も黙って落とさず明示する。
 */
export function notificationSchedule(
  reminder: string,
  nudgeAfterMin: number,
  finalAfterMin: number | null,
  dayStartHour: number,
  notifiable = true,
  reason = '',
): string {
  const base = hmToMinutes(reminder) ?? 21 * 60;
  const lines = [`⏰ リマインド ${reminder}`];

  lines.push(`   追い打ち ${slot(base, nudgeAfterMin, dayStartHour)}`);
  lines.push(
    finalAfterMin === null
      ? '   最終 なし'
      : `   最終 ${slot(base, finalAfterMin, dayStartHour)}`,
  );

  // 設定はできるのに届かない、という状態を黙って作らない
  lines.push('');
  lines.push(notifiable ? '📨 通知は届きます' : '🔕 通知は届きません');
  if (reason) lines.push(`   ${reason}`);
  if (!notifiable) lines.push('   受け取るには「通知 オン」と送ってください');
  return lines.join('\n');
}

function slot(baseMinutes: number, offsetMinutes: number, dayStartHour: number): string {
  const at = offsetFrom(baseMinutes, offsetMinutes);
  const label = `${minutesToHm(at)}（${describeOffset(offsetMinutes)}後）`;
  return isQuietHour(at, dayStartHour) ? `${label} → 深夜帯のため送信されません` : label;
}

function describeOffset(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分`;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

export function syncFailed(): string {
  return [
    '⚠️ カレンダーへの書き込みに失敗しました',
    '   記録自体は保存されています。',
    '   あとで「同期」と送ると貼り直せます。',
  ].join('\n');
}

export function calendarChanged(): string {
  return [
    '📅 書き込み先カレンダーを変更しました',
    '   これまでの記録を新しいカレンダーに貼り直しています…',
    '   （前のカレンダーのイベントは残ります。不要なら手で削除してください）',
  ].join('\n');
}

export function resyncStarted(): string {
  return '🔄 カレンダーを貼り直しています…';
}

export function resyncDone(written: number): string {
  return `🔄 ${written}件を貼り直しました（記録はDBが正本なので、カレンダーを消しても復元できます）`;
}

export function undone(what: string): string {
  return `取り消しました: ${what}`;
}

export function confirm(): string {
  return 'どちらを記録しますか？';
}

export const PROVISIONAL_ANCHOR = [
  '※ シートの起点が未設定だったので、プラセボ2日目に出血が始まったと仮定して',
  '   暫定で置きました。1錠目の日付が分かれば「新しいシート」で打ち直せます。',
].join('\n');

export function reminder(day: number | null): string {
  if (day === null) return '💊 ピルの時間です';
  return isPlacebo(day)
    ? `○ プラセボ ${day - ACTIVE_LEN}日目です`
    : `💊 ピルの時間です（実薬 ${day}/${SHEET_LEN}日目）`;
}

export function nudge(day: number | null): string {
  if (day === null) return 'まだ今日の記録がありません';
  return isPlacebo(day)
    ? `プラセボ ${day}/${SHEET_LEN} の記録がありません`
    : `実薬 ${day}/${SHEET_LEN} の記録がありません`;
}

export function finalNudge(): string {
  return '今日は記録なしのままです';
}

export function placeboNotice(placeboStart: string, next: Prediction | null): string {
  const lines = [`明日 ${formatMd(placeboStart)} からプラセボ期間です（4日間）`];
  if (next) lines.push(`   出血は ${formatMd(next.date)} ごろの見込み ± ${next.band}日`);
  return lines.join('\n');
}

export function bleedNotice(next: Prediction): string {
  return `🩸 ${formatMd(next.date)} ごろ 消退出血の予測です（± ${next.band}日）`;
}

export function noBleedAlert(sheets: number): string {
  return `${sheets}周期続けて出血の記録がありません。記録漏れでなければ、気になるときは主治医に相談を。`;
}

/**
 * 使い方。管理コマンドは管理者にだけ見せる。
 * 使えないコマンドを一覧に混ぜても迷わせるだけなので。
 */
export function help(owner: boolean): string {
  const lines = [
    '使い方',
    '',
    '💊 記録: 「飲んだ」／「💊」',
    '   過去の日: 「昨日飲んだ」／「8/12 飲んだ」',
    '🩸 生理: 「生理が来た」／「8/12 生理が来た」',
    '   終了: 「生理終わった」',
    '📦 シート: 「新しいシート」= その日を1錠目にする',
    '   過去の日付も: 「8/30 新しいシート」',
    '',
    '🔮 予測: 「予測」／「次いつ」',
    '📋 状況: 「状況」= 今日の記録・連続日数・次回予測',
    '↩️ 取り消し: 「取り消し」= 直近1件を消す',
    '',
    '⏰ リマインド時刻: 「リマインド 21:00」',
    '   追い打ち: 「追い打ち 2時間」= リマインドの何時間後か',
    '   最終通知: 「最終通知 4時間」／「最終通知 なし」',
    '🔕 通知の受け取り: 「通知 オフ」／「通知 オン」／「通知 自動」',
    '🔄 貼り直し: 「同期」= カレンダーをDBから復元',
    '📅 書き込み先: 「カレンダー xxx@group.calendar.google.com」',
    '👥 利用者: 「メンバー」',
  ];

  if (owner) {
    lines.push(
      '',
      '--- 管理者向け ---',
      '追加: 「許可 Uxxxx…」',
      '解除: 「解除 Uxxxx…」',
      '   userId は、その人が bot に何か送ると本人に返ります',
    );
  }

  lines.push(
    '',
    '※ 飲み忘れたときの対応は案内できません。添付文書と主治医の指示に従ってください。',
  );

  return lines.join('\n');
}
