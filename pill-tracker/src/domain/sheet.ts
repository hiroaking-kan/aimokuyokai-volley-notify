import { addDays, diffDays, mod } from './dates.js';

/**
 * ドロエチ (ドロスピレノン・エチニルエストラジオール) の 24+4 レジメン。
 *
 * 28錠すべてを毎日飲む (Day 25〜28 はプラセボ錠) ので、21+7 と違って
 * 服薬記録に空白ができない。「服薬が途切れた地点が次シートの開始」という
 * 復元ができないため、1錠目の日付 (sheet_anchor) を明示的に持ち、
 * シート内の位置は服用実績の本数ではなく暦日から計算する。
 *
 * 暦日基準にするのが要点。飲み忘れて翌日に2錠飲んでもシートの終了日は
 * 動かないので、本数を数える実装だと飲み忘れのたびに予測が1日ずつズレる。
 */
export const SHEET_LEN = 28;
export const ACTIVE_LEN = 24;

/** シート内の位置 (1..28)。 */
export function dayInSheet(anchor: string, date: string): number {
  return mod(diffDays(anchor, date), SHEET_LEN) + 1;
}

export function isPlacebo(day: number): boolean {
  return day > ACTIVE_LEN;
}

/** date が何シート目に属するか (アンカーのシートが 0)。 */
export function sheetIndexOf(anchor: string, date: string): number {
  return Math.floor(diffDays(anchor, date) / SHEET_LEN);
}

/** i シート目のプラセボ期間の開始日 (Day 25)。 */
export function placeboStartOfSheet(anchor: string, sheetIndex: number): string {
  return addDays(anchor, sheetIndex * SHEET_LEN + ACTIVE_LEN);
}

/** date を含むシートのプラセボ期間開始日。 */
export function placeboStartOfSheetContaining(anchor: string, date: string): string {
  return placeboStartOfSheet(anchor, sheetIndexOf(anchor, date));
}

/** from 以降のプラセボ期間開始日を n 件。 */
export function nextPlaceboStarts(anchor: string, from: string, n: number): string[] {
  let i = sheetIndexOf(anchor, from);
  if (placeboStartOfSheet(anchor, i) < from) i += 1;
  return Array.from({ length: n }, (_, k) => placeboStartOfSheet(anchor, i + k));
}

/** シートの1錠目の日付 (Day 1)。 */
export function sheetStartOfSheet(anchor: string, sheetIndex: number): string {
  return addDays(anchor, sheetIndex * SHEET_LEN);
}
