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

export function minutesToHm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
