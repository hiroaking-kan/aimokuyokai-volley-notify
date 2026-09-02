import { addDays, diffDays, mad, median } from './dates.js';
import {
  ACTIVE_LEN,
  dayInSheet,
  nextPlaceboStarts,
  placeboStartOfSheet,
  sheetIndexOf,
  SHEET_LEN,
} from './sheet.js';

export type Confidence = 'high' | 'medium' | 'low';

export interface Prediction {
  placeboStart: string;
  date: string;
  band: number;
  confidence: Confidence;
}

/** これを外れた値は別要因とみなし、ラグの中央値に混ぜない。 */
const LAG_MIN = -2;
const LAG_MAX = 6;
const DEFAULT_LAG = 2;
const DEFAULT_BAND = 2;

/**
 * 1件の出血開始日を、どのシートのプラセボ期間に紐づけるか決めてラグを返す。
 *
 * Day 25〜28 に始まったなら自分のシートのプラセボ開始から数え、
 * Day 1〜4 に始まったなら前シートのプラセボ開始から数える
 * (前シートのプラセボ開始は Day 1 の4日前)。どちらでもなければ null。
 */
export function lagForBleed(anchor: string, start: string): number | null {
  const day = dayInSheet(anchor, start);
  const own = day - (ACTIVE_LEN + 1);
  const prev = day + (SHEET_LEN - ACTIVE_LEN - 1);

  const candidates = [own, prev].filter((l) => l >= LAG_MIN && l <= LAG_MAX);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (Math.abs(a) <= Math.abs(b) ? a : b));
}

/**
 * 実測ラグを集める。
 *
 * 消退出血が来ない月はそのシートが単に欠測になるだけで、
 * 「周期が延びた」とは解釈されない。ここが自然周期版との決定的な違い。
 */
export function observedLags(anchor: string, periodStarts: readonly string[]): number[] {
  return periodStarts
    .map((s) => lagForBleed(anchor, s))
    .filter((l): l is number => l !== null);
}

export function lagStats(lags: readonly number[]): {
  lag: number;
  band: number;
  confidence: Confidence;
} {
  if (lags.length === 0) {
    return { lag: DEFAULT_LAG, band: DEFAULT_BAND, confidence: 'low' };
  }
  return {
    lag: Math.round(median(lags)),
    band: lags.length >= 3 ? Math.max(1, Math.round(mad(lags))) : DEFAULT_BAND,
    confidence: lags.length >= 3 ? 'high' : 'medium',
  };
}

/**
 * from 以降の消退出血を n 件予測する。
 *
 * 24+4 は周期が28日で確定しているので、学習するのは周期長ではなく
 * 「プラセボ開始 → 実際の出血開始」のラグの一点だけ。
 * スケジュールが決定論的なぶん、先6か月ぶんをまとめて先出しできる。
 */
export function predictBleeds(
  anchor: string,
  periodStarts: readonly string[],
  from: string,
  n: number,
): Prediction[] {
  const { lag, band, confidence } = lagStats(observedLags(anchor, periodStarts));
  return nextPlaceboStarts(anchor, from, n).map((placeboStart) => ({
    placeboStart,
    date: addDays(placeboStart, lag),
    band,
    confidence,
  }));
}

/**
 * sheet_anchor が未設定のときの暫定値。
 * プラセボ2日目に出血が始まったと仮定して逆算する (confidence は low 扱い)。
 */
export function estimateAnchorFromBleed(start: string): string {
  return addDays(start, -(ACTIVE_LEN + DEFAULT_LAG));
}

/**
 * その出血がどのシートのプラセボ期間に属するか。ラグを引き戻せば開始日そのもの。
 */
export function attributedPlaceboStart(anchor: string, start: string): string | null {
  const lag = lagForBleed(anchor, start);
  return lag === null ? null : addDays(start, -lag);
}

/**
 * 直近のプラセボ期間が何回続けて「出血の記録なし」だったか。
 * 自然周期用の「45日ルール」の代わりに、ドロエチではこちらを使う。
 */
export function missedBleedSheets(
  anchor: string,
  periodStarts: readonly string[],
  today: string,
): number {
  const covered = new Set(
    periodStarts
      .map((s) => attributedPlaceboStart(anchor, s))
      .filter((s): s is string => s !== null),
  );

  let missed = 0;
  for (let back = 0; back < 2; back++) {
    const start = completedPlaceboStart(anchor, today, back);
    if (start === null || covered.has(start)) break;
    missed += 1;
  }
  return missed;
}

/** すでに終わったプラセボ期間の開始日を、新しいほうから back 番目に。 */
function completedPlaceboStart(anchor: string, today: string, back: number): string | null {
  if (diffDays(anchor, today) < 0) return null;
  let index = sheetIndexOf(anchor, today);
  // 今いるシートのプラセボがまだ終わっていなければ1つ前のシートを見る
  if (dayInSheet(anchor, today) < SHEET_LEN) index -= 1;
  index -= back;
  return index < 0 ? null : placeboStartOfSheet(anchor, index);
}
