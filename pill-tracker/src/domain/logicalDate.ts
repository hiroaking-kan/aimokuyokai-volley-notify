import { addDays } from './dates.js';

/**
 * 論理日を返す。
 *
 * 深夜0:30に「飲んだ」と送ったとき、体感ではそれは前日の分なので、
 * dayStartHour (既定4時) より前の記録は前日に寄せる。
 * これがないと連続日数の計算も飲み忘れ検知も実態とズレる。
 */
export function logicalDate(
  at: Date,
  timezone: string,
  dayStartHour: number,
): string {
  const { ymd, hour } = wallClock(at, timezone);
  return hour < dayStartHour ? addDays(ymd, -1) : ymd;
}

/** そのタイムゾーンでの壁時計の日付・時・分。 */
export function wallClock(
  at: Date,
  timezone: string,
): { ymd: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  // hourCycle の都合で 24 が返る環境があるため 0 に丸める
  const hour = Number(get('hour')) % 24;
  return {
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    minute: Number(get('minute')),
  };
}

/** 'HH:MM' を0時からの分数に。不正な値は null。 */
export function hmToMinutes(hm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 通知予定の時刻を組み立てる。
 *
 * リマインドからの経過時間で決めるので、日をまたぐことがある。
 * 24時を超えた分は素直に翌日の時刻に折り返す。
 */
export function offsetFrom(baseMinutes: number, offsetMinutes: number): number {
  return (((baseMinutes + offsetMinutes) % 1440) + 1440) % 1440;
}

/**
 * 通知を送らない時間帯の始まり。
 *
 * 論理日の切り替わり(既定4時)より前すべてを避けると、リマインドを
 * 22時にした人の追い打ち(0時)まで落ちてしまう。0時台はまだ起きている
 * 前提で、実際に眠っている 1時〜切り替わり時刻 だけを避ける。
 */
const QUIET_START_HOUR = 1;

/**
 * 深夜帯か。
 *
 * リマインドを遅い時刻にすると追い打ちが未明に回り込むので、
 * そこには送らない。起こしてまで知らせる種類の通知ではない。
 */
export function isQuietHour(minutes: number, dayStartHour: number): boolean {
  const start = QUIET_START_HOUR * 60;
  const end = dayStartHour * 60;
  return end > start && minutes >= start && minutes < end;
}

export function minutesToHm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
