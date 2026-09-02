/** 'YYYY-MM-DD' の文字列を素直に扱うためのヘルパー。すべてUTC基準で計算する。 */

const MS_PER_DAY = 86_400_000;
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

export function ymdToEpochDay(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) throw new Error(`invalid date: ${ymd}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY;
}

export function epochDayToYmd(day: number): string {
  const d = new Date(day * MS_PER_DAY);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function addDays(ymd: string, n: number): string {
  return epochDayToYmd(ymdToEpochDay(ymd) + n);
}

/** to - from の日数。 */
export function diffDays(from: string, to: string): number {
  return ymdToEpochDay(to) - ymdToEpochDay(from);
}

/** 「8/30(土)」形式。返信や通知の見出しに使う。 */
export function formatMd(ymd: string): string {
  const d = new Date(ymdToEpochDay(ymd) * MS_PER_DAY);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY_JA[d.getUTCDay()]})`;
}

/** カレンダーのイベントIDに使う 'YYYYMMDD'。 */
export function compactYmd(ymd: string): string {
  return ymd.replace(/-/g, '');
}

/** 常に非負を返す剰余。アンカーより前の日付を扱うために必要。 */
export function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) throw new Error('median of empty list');
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** 中央絶対偏差。外れ値に強いばらつきの指標。 */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}
