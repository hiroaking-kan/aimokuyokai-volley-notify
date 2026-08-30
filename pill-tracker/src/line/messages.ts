import { addDays, diffDays, formatMd } from '../domain/dates.js';
import type { Prediction } from '../domain/predict.js';
import { ACTIVE_LEN, isPlacebo, SHEET_LEN } from '../domain/sheet.js';
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
): string {
  const lines = [
    recordedToday ? '💊 今日は記録済み' : '💊 今日はまだ記録がありません',
    `   ${streak}日連続`,
  ];
  if (day !== null) lines.push(`   ${sheetLabel(day)}`);
  if (next) lines.push(`🩸 次回出血予測: ${formatMd(next.date)} ごろ ± ${next.band}日`);
  return lines.join('\n');
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

export const HELP = [
  '使い方',
  '',
  '💊 記録: 「飲んだ」／「昨日飲んだ」／「8/12 飲んだ」',
  '🩸 生理: 「生理が来た」／「生理終わった」',
  '📦 シート: 「新しいシート」= その日を1錠目にする',
  '🔮 予測: 「予測」／「次いつ」',
  '📋 状況: 「状況」',
  '↩️ 取り消し: 「取り消し」',
  '⏰ リマインド時刻: 「リマインド 21:00」',
  '',
  '※ 飲み忘れたときの対応は案内できません。添付文書と主治医の指示に従ってください。',
].join('\n');
