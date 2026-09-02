import { addDays, compactYmd } from '../domain/dates.js';

export const CALENDAR_SUMMARY = 'ピル・生理記録';

export type EventKind = 'dose' | 'placebo' | 'period' | 'prediction';

export interface AllDayEvent {
  id: string;
  kind: EventKind;
  summary: string;
  description?: string;
  /** 開始日 (含む)。 */
  start: string;
  /** 終了日 (含む)。Google の end.date は排他なので送出時に +1 する。 */
  endInclusive: string;
  colorId?: string;
}

/**
 * カレンダーへの投影先。実装を差し替えられるよう1枚挟んである。
 * いまは GAS 経由 (gas.ts) だけを使う。
 */
export interface CalendarBackend {
  ensureCalendar(timezone: string, summary: string): Promise<string>;
  upsert(calendarId: string, event: AllDayEvent): Promise<string>;
  remove(calendarId: string, eventId: string): Promise<void>;
}

/**
 * イベントIDは日付から決まる。Calendar API はイベントIDをクライアント指定でき、
 * 使える文字は base32hex (a-v と 0-9) なので下の接頭辞はすべて収まる。
 * 何度書き込んでも重複せず、リトライも二重実行も安全になる。
 */
export const eventId = {
  dose: (date: string) => `dose${compactYmd(date)}`,
  placebo: (placeboStart: string) => `placebo${compactYmd(placeboStart)}`,
  period: (startDate: string) => `period${compactYmd(startDate)}`,
  prediction: (predictedDate: string) => `pred${compactYmd(predictedDate)}`,
};

/** Calendar API v3 の終日イベント表現へ。end.date は排他。 */
export function toApiEvent(event: AllDayEvent): Record<string, unknown> {
  return {
    id: event.id,
    summary: event.summary,
    ...(event.description ? { description: event.description } : {}),
    start: { date: event.start },
    end: { date: addDays(event.endInclusive, 1) },
    transparency: 'transparent',
    ...(event.colorId ? { colorId: event.colorId } : {}),
    extendedProperties: { private: { app: 'pilltracker', kind: event.kind } },
  };
}
