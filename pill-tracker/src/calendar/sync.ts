import { addDays } from '../domain/dates.js';
import { predictBleeds } from '../domain/predict.js';
import {
  ACTIVE_LEN,
  dayInSheet,
  isPlacebo,
  nextPlaceboStarts,
  SHEET_LEN,
} from '../domain/sheet.js';
import type { Store, UserRow } from '../store/db.js';
import type { CalendarBackend } from './backend.js';
import { eventId } from './backend.js';

/** 先出しするシート数。28日 × 7 ≒ 6か月半。 */
const HORIZON_SHEETS = 7;
/** アンカーを打ち直したとき、古いアンカー由来のイベントを消す範囲。 */
const CLEANUP_SHEETS = 9;

const COLOR = {
  doseActive: '7', // Peacock
  dosePlacebo: '8', // Graphite
  placeboWindow: '8', // Graphite
  period: '11', // Tomato
  prediction: '4', // Flamingo — 実際の生理(赤)の薄い版として読ませる
} as const;

export class CalendarSync {
  constructor(
    private readonly store: Store,
    private readonly calendar: CalendarBackend,
  ) {}

  /** 専用カレンダーが無ければ作る。 */
  async ensureCalendar(user: UserRow): Promise<string> {
    if (user.google_calendar_id) return user.google_calendar_id;
    const id = await this.calendar.ensureCalendar(user.timezone);
    await this.store.updateUser(user.line_user_id, { google_calendar_id: id });
    return id;
  }

  async syncDose(user: UserRow, localDate: string, takenAt: string): Promise<void> {
    const calendarId = await this.ensureCalendar(user);
    const id = eventId.dose(localDate);
    const day = user.sheet_anchor ? dayInSheet(user.sheet_anchor, localDate) : null;

    await this.calendar.upsert(calendarId, {
      id,
      kind: 'dose',
      summary: doseSummary(day),
      description: `${takenAt} に記録`,
      start: localDate,
      endInclusive: localDate,
      colorId: day !== null && isPlacebo(day) ? COLOR.dosePlacebo : COLOR.doseActive,
    });
    await this.store.setDoseEventId(user.line_user_id, localDate, id);
  }

  async removeDose(user: UserRow, localDate: string): Promise<void> {
    if (!user.google_calendar_id) return;
    await this.calendar.remove(user.google_calendar_id, eventId.dose(localDate));
  }

  async syncPeriod(user: UserRow, startDate: string, endDate: string | null): Promise<void> {
    const calendarId = await this.ensureCalendar(user);
    const id = eventId.period(startDate);

    await this.calendar.upsert(calendarId, {
      id,
      kind: 'period',
      summary: '🩸 生理',
      start: startDate,
      endInclusive: endDate ?? startDate,
      colorId: COLOR.period,
    });
    await this.store.setPeriodEventId(user.line_user_id, startDate, id);
  }

  async removePeriod(user: UserRow, startDate: string): Promise<void> {
    if (!user.google_calendar_id) return;
    await this.calendar.remove(user.google_calendar_id, eventId.period(startDate));
  }

  /**
   * プラセボ期間と消退出血の予測を、先6か月ぶんまとめてカレンダーへ書く。
   *
   * 24+4 はシートの進行が暦だけで決まるので、自然周期のように
   * 「次の1件だけ」ではなく、旅行や予定の計画に使える形で先出しできる。
   * 実測ラグが更新されたら未来ぶんを差し替える。
   */
  async syncSchedule(user: UserRow, today: string): Promise<void> {
    const anchor = user.sheet_anchor;
    if (!anchor) return;

    const calendarId = await this.ensureCalendar(user);

    // アンカーを打ち直したら、古いアンカー由来の未来イベントを先に消す
    if (user.last_synced_anchor && user.last_synced_anchor !== anchor) {
      await this.clearSchedule(user.line_user_id, calendarId, user.last_synced_anchor, today);
    }

    const periodStarts = await this.store.listPeriodStarts(user.line_user_id);
    const predictions = predictBleeds(anchor, periodStarts, today, HORIZON_SHEETS);
    const keep = new Set(predictions.map((p) => p.placeboStart));

    // 予測日が動いた/範囲外になった古い行はイベントごと消す
    for (const row of await this.store.listPredictions(user.line_user_id)) {
      const stillWanted = predictions.find((p) => p.placeboStart === row.placebo_start);
      if (!stillWanted || stillWanted.date !== row.predicted_date) {
        if (row.calendar_event_id) await this.calendar.remove(calendarId, row.calendar_event_id);
        if (!keep.has(row.placebo_start)) {
          await this.store.deletePrediction(user.line_user_id, row.placebo_start);
        }
      }
    }

    for (const placeboStart of nextPlaceboStarts(anchor, today, HORIZON_SHEETS)) {
      await this.calendar.upsert(calendarId, {
        id: eventId.placebo(placeboStart),
        kind: 'placebo',
        summary: '○ プラセボ期間',
        description: `シート ${ACTIVE_LEN + 1}〜${SHEET_LEN}日目`,
        start: placeboStart,
        endInclusive: addDays(placeboStart, SHEET_LEN - ACTIVE_LEN - 1),
        colorId: COLOR.placeboWindow,
      });
    }

    for (const p of predictions) {
      const id = eventId.prediction(p.date);
      await this.calendar.upsert(calendarId, {
        id,
        kind: 'prediction',
        summary: `(予測) 🩸 消退出血 ±${p.band}日`,
        description:
          p.confidence === 'high'
            ? '実測ラグの中央値から算出'
            : '記録がまだ少ないため参考値です',
        start: p.date,
        endInclusive: p.date,
        colorId: COLOR.prediction,
      });
      await this.store.upsertPrediction({
        user_id: user.line_user_id,
        placebo_start: p.placeboStart,
        predicted_date: p.date,
        band: p.band,
        confidence: p.confidence,
        calendar_event_id: id,
      });
    }

    await this.store.updateUser(user.line_user_id, { last_synced_anchor: anchor });
  }

  /**
   * DB を正本としてカレンダーを貼り直す。
   *
   * GAS 側が落ちていた間の書き込み漏れや、カレンダーを手で消してしまった
   * ときの復旧経路。イベントIDが日付から決まるので、何度流しても増えない。
   */
  async resync(user: UserRow, today: string, days: number): Promise<number> {
    const since = addDays(today, -days);
    let written = 0;

    for (const date of await this.store.listDoseDatesSince(user.line_user_id, since)) {
      const dose = await this.store.getDose(user.line_user_id, date);
      if (!dose) continue;
      await this.syncDose(user, date, dose.taken_at);
      written += 1;
    }

    for (const start of await this.store.listPeriodStarts(user.line_user_id)) {
      if (start < since) continue;
      const period = await this.store.getPeriod(user.line_user_id, start);
      await this.syncPeriod(user, start, period?.end_date ?? null);
      written += 1;
    }

    await this.syncSchedule(user, today);
    return written;
  }

  /** 古いアンカー由来のプラセボ期間イベントを消す。 */
  private async clearSchedule(
    userId: string,
    calendarId: string,
    oldAnchor: string,
    today: string,
  ): Promise<void> {
    for (const placeboStart of nextPlaceboStarts(oldAnchor, today, CLEANUP_SHEETS)) {
      await this.calendar.remove(calendarId, eventId.placebo(placeboStart));
    }
    for (const row of await this.store.listPredictions(userId)) {
      if (row.calendar_event_id) await this.calendar.remove(calendarId, row.calendar_event_id);
      await this.store.deletePrediction(userId, row.placebo_start);
    }
  }
}

function doseSummary(day: number | null): string {
  if (day === null) return '💊 ピル';
  return isPlacebo(day) ? `○ プラセボ ${day}/${SHEET_LEN}` : `💊 ピル ${day}/${SHEET_LEN}`;
}
