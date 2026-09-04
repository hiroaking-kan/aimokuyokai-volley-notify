import { CalendarSync } from './calendar/sync.js';
import { addDays, diffDays, formatMd } from './domain/dates.js';
import { logicalDate, wallClock } from './domain/logicalDate.js';
import { notificationReason, notificationsOn } from './domain/notifications.js';
import type { ParseResult } from './domain/parse.js';
import { parseMessage, parsePostback } from './domain/parse.js';
import { estimateAnchorFromBleed, lagForBleed, predictBleeds } from './domain/predict.js';
import { dayInSheet } from './domain/sheet.js';
import type { LineClient } from './line/client.js';
import * as M from './line/messages.js';
import type { Store, UserRow } from './store/db.js';

/** 「継続中の生理」とみなす日数。これ以内の再送は新しい周期にしない。 */
const PERIOD_CONTINUATION_DAYS = 3;

/** 「同期」で貼り直す遡り日数。 */
const RESYNC_DAYS = 90;

export interface HandlerDeps {
  store: Store;
  line: LineClient;
  sync: CalendarSync;
  timezone: string;
  /** シークレットに載っている管理者か。人の追加・削除ができる。 */
  owner: boolean;
  /** 一覧表示用の管理者ID。 */
  owners: string[];
}

export interface Reply {
  text: string;
  quickReplies: ReturnType<typeof M.QR.dose>[];
  /** カレンダー同期など、返信後に waitUntil で流す処理。 */
  after?: () => Promise<void>;
}

export async function handleEvent(
  deps: HandlerDeps,
  userId: string,
  event: { type: string; message?: { type: string; text?: string }; postback?: { data: string } },
  now: Date,
): Promise<Reply | null> {
  let user = await deps.store.ensureUser(userId, deps.timezone);

  // 複数人で使うとき、カレンダー名を見分けるために表示名を控える。
  // 取れなくても動作には影響しないので、失敗しても先へ進む。
  // null だけでなく undefined と空文字も拾う (列が未作成のときは undefined になる)。
  if (!user.display_name) {
    const name = await deps.line.displayName(userId);
    if (name) {
      await deps.store.updateUser(userId, { display_name: name });
      user = { ...user, display_name: name };
    }
  }

  const today = logicalDate(now, user.timezone, user.day_start_hour);

  const parsed =
    event.type === 'postback' && event.postback
      ? parsePostback(event.postback.data, today)
      : event.type === 'message' && event.message?.type === 'text'
        ? parseMessage(event.message.text ?? '', today)
        : null;

  if (!parsed) return null;
  return act(deps, user, parsed, today, now);
}

async function act(
  deps: HandlerDeps,
  user: UserRow,
  parsed: ParseResult,
  today: string,
  now: Date,
): Promise<Reply> {
  const { store, sync } = deps;
  const userId = user.line_user_id;

  // 判定できないときは推測しない。記録漏れより誤記録のほうが害が大きい。
  if (!parsed.confident) {
    return {
      text: M.confirm(),
      quickReplies: [M.QR.dose(parsed.date), M.QR.periodStart(parsed.date), M.QR.none()],
    };
  }

  switch (parsed.intent) {
    case 'DOSE':
      return recordDose(deps, user, parsed.date, now, parsed.raw.startsWith('action=') ? 'quick_reply' : 'text');

    case 'PERIOD_START':
      return recordPeriodStart(deps, user, parsed.date, today);

    case 'PERIOD_END':
      return recordPeriodEnd(deps, user, parsed.date);

    case 'SHEET_START': {
      await store.updateUser(userId, { sheet_anchor: parsed.date });
      const fresh = await store.getUser(userId);
      return {
        text: M.sheetStarted(parsed.date),
        quickReplies: [M.QR.dose(today)],
        after: async () => {
          if (fresh) await sync.syncSchedule(fresh, today);
        },
      };
    }

    case 'PREDICT': {
      const next = await nextPrediction(store, user, today);
      return {
        text: M.predictionSummary(
          today,
          user.sheet_anchor ? dayInSheet(user.sheet_anchor, today) : null,
          next,
          next?.confidence ?? 'low',
        ),
        quickReplies: [M.QR.dose(today)],
      };
    }

    case 'STATUS': {
      const next = await nextPrediction(store, user, today);
      const recorded = (await store.getDose(userId, today)) !== null;
      return {
        text: M.statusSummary(
          user.sheet_anchor ? dayInSheet(user.sheet_anchor, today) : null,
          await doseStreak(store, userId, today),
          recorded,
          next,
          notificationsOn(user) && (await store.isAllowedUser(userId)),
          notificationReason(user),
        ),
        quickReplies: recorded ? [M.QR.predict()] : [M.QR.dose(today)],
      };
    }

    case 'UNDO':
      return undo(deps, user, today);

    case 'SET_REMINDER':
      return applySchedule(deps, user, { reminder_time: parsed.reminderTime! });

    case 'SET_NUDGE':
      // 1回目の追い打ちは無効にできない（飲み忘れ検知の中心なので）
      if (parsed.offsetMinutes === null) {
        return { text: '追い打ちは無効にできません。最終通知なら「最終通知 なし」で止められます。', quickReplies: [] };
      }
      return applySchedule(deps, user, { nudge_after_min: parsed.offsetMinutes! });

    case 'SET_FINAL_NUDGE':
      return applySchedule(deps, user, { final_nudge_after_min: parsed.offsetMinutes ?? null });

    case 'SET_NOTIFICATIONS':
      return applySchedule(deps, user, { notifications_enabled: parsed.notifications ?? null });

    case 'RESYNC': {
      return {
        text: M.resyncStarted(),
        quickReplies: [],
        after: async () => {
          const written = await sync.resync(user, today, RESYNC_DAYS);
          await deps.line.push(userId, M.resyncDone(written));
        },
      };
    }

    case 'SET_CALENDAR': {
      await store.updateUser(userId, { google_calendar_id: parsed.calendarId! });
      const fresh = (await store.getUser(userId)) ?? user;
      return {
        text: M.calendarChanged(),
        quickReplies: [],
        after: () => sync.resync(fresh, today, RESYNC_DAYS).then(() => undefined),
      };
    }

    case 'MEMBERS': {
      const rows = await store.listAllowedUsers();
      return { text: M.members(rows, deps.owners), quickReplies: [] };
    }

    case 'ALLOW': {
      if (!deps.owner) return { text: M.notOwner(), quickReplies: [] };
      const added = await store.addAllowedUser(parsed.targetUserId!, userId);
      return { text: M.allowed(parsed.targetUserId!, added), quickReplies: [] };
    }

    case 'DISALLOW': {
      if (!deps.owner) return { text: M.notOwner(), quickReplies: [] };
      const removed = await store.removeAllowedUser(parsed.targetUserId!);
      return { text: M.disallowed(parsed.targetUserId!, removed), quickReplies: [] };
    }

    case 'HELP':
    default:
      return { text: M.help(deps.owner), quickReplies: [M.QR.dose(today), M.QR.predict()] };
  }
}

/** 通知の設定を変えて、実際に送られる時刻を返す。 */
async function applySchedule(
  deps: HandlerDeps,
  user: UserRow,
  patch: Partial<UserRow>,
): Promise<Reply> {
  await deps.store.updateUser(user.line_user_id, patch);
  const fresh = (await deps.store.getUser(user.line_user_id)) ?? { ...user, ...patch };

  return {
    text: M.notificationSchedule(
      fresh.reminder_time,
      fresh.nudge_after_min,
      fresh.final_nudge_after_min,
      fresh.day_start_hour,
      notificationsOn(fresh) && (await deps.store.isAllowedUser(user.line_user_id)),
      notificationReason(fresh),
    ),
    quickReplies: [],
  };
}

async function recordDose(
  deps: HandlerDeps,
  user: UserRow,
  date: string,
  now: Date,
  source: string,
): Promise<Reply> {
  const userId = user.line_user_id;
  const takenAt = new Date(now).toISOString();

  const inserted = await deps.store.insertDose({
    id: `dose-${userId}-${date}`,
    user_id: userId,
    local_date: date,
    taken_at: takenAt,
    source,
  });

  if (!inserted) {
    const existing = await deps.store.getDose(userId, date);
    const at = existing ? wallClock(new Date(existing.taken_at), user.timezone) : null;
    return {
      text: M.doseAlready(date, at ? `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}` : '記録済み'),
      quickReplies: [M.QR.undo()],
    };
  }

  const day = user.sheet_anchor ? dayInSheet(user.sheet_anchor, date) : null;
  const streak = await doseStreak(deps.store, userId, date);

  return {
    text: M.doseRecorded(date, day, streak),
    quickReplies: [],
    after: () => deps.sync.syncDose(user, date, formatTime(takenAt, user.timezone)),
  };
}

async function recordPeriodStart(
  deps: HandlerDeps,
  user: UserRow,
  date: string,
  today: string,
): Promise<Reply> {
  const userId = user.line_user_id;
  const latest = await deps.store.latestPeriod(userId);

  // 直前の開始から3日以内なら継続中とみなし、新しい周期を作らない
  if (latest && diffDays(latest.start_date, date) >= 0 && diffDays(latest.start_date, date) <= PERIOD_CONTINUATION_DAYS) {
    return {
      text: `🩸 ${formatMd(latest.start_date)} からの記録が継続中です`,
      quickReplies: [M.QR.periodEnd(date)],
    };
  }

  await deps.store.insertPeriod({ id: `period-${userId}-${date}`, user_id: userId, start_date: date });

  // シート起点が未設定なら、プラセボ2日目に始まったと仮定して暫定値を置く。
  // 正確な日付が分かれば「新しいシート」で打ち直せる。
  let anchor = user.sheet_anchor;
  const provisional = anchor === null;
  if (provisional) {
    anchor = estimateAnchorFromBleed(date);
    await deps.store.updateUser(userId, { sheet_anchor: anchor });
  }

  const lag = lagForBleed(anchor!, date);
  const starts = await deps.store.listPeriodStarts(userId);
  const next = predictBleeds(anchor!, starts, addDays(date, 1), 1)[0] ?? null;

  const fresh = (await deps.store.getUser(userId)) ?? user;

  return {
    text: M.periodRecorded(date, lag, next) + (provisional ? `\n\n${M.PROVISIONAL_ANCHOR}` : ''),
    quickReplies: [M.QR.periodEnd(today)],
    after: async () => {
      await deps.sync.syncPeriod(fresh, date, null);
      await deps.sync.syncSchedule(fresh, today);
    },
  };
}

async function recordPeriodEnd(deps: HandlerDeps, user: UserRow, date: string): Promise<Reply> {
  const latest = await deps.store.latestPeriod(user.line_user_id);
  if (!latest || latest.end_date !== null) {
    return { text: '継続中の生理の記録が見つかりません', quickReplies: [M.QR.periodStart(date)] };
  }
  if (diffDays(latest.start_date, date) < 0) {
    return { text: '開始日より前の日付では終了できません', quickReplies: [] };
  }

  await deps.store.closePeriod(user.line_user_id, latest.start_date, date);
  return {
    text: M.periodClosed(latest.start_date, date),
    quickReplies: [],
    after: async () => {
      await deps.sync.syncPeriod(user, latest.start_date, date);
      // 期間の長さを学習したので、先の予測にも反映する
      await deps.sync.syncSchedule(user, date);
    },
  };
}

async function undo(deps: HandlerDeps, user: UserRow, today: string): Promise<Reply> {
  const userId = user.line_user_id;
  const dose = await deps.store.latestDose(userId);
  const period = await deps.store.latestPeriod(userId);

  // 新しいほうを1件だけ取り消す
  const undoPeriod = period && (!dose || period.start_date >= dose.local_date);

  if (undoPeriod && period) {
    await deps.store.deletePeriod(userId, period.start_date);
    return {
      text: M.undone(`🩸 ${formatMd(period.start_date)} の生理記録`),
      quickReplies: [],
      after: async () => {
        await deps.sync.removePeriod(user, period.start_date);
        await deps.sync.syncSchedule(user, today);
      },
    };
  }

  if (dose) {
    await deps.store.deleteDose(userId, dose.local_date);
    return {
      text: M.undone(`💊 ${formatMd(dose.local_date)} の服薬記録`),
      quickReplies: [],
      after: () => deps.sync.removeDose(user, dose.local_date),
    };
  }

  return { text: '取り消せる記録がありません', quickReplies: [] };
}

async function nextPrediction(store: Store, user: UserRow, today: string) {
  if (!user.sheet_anchor) return null;
  const starts = await store.listPeriodStarts(user.line_user_id);
  return predictBleeds(user.sheet_anchor, starts, today, 1)[0] ?? null;
}

/** date を含む連続服用日数。 */
export async function doseStreak(store: Store, userId: string, date: string): Promise<number> {
  const dates = await store.listDoseDatesSince(userId, addDays(date, -400));
  const set = new Set(dates);
  let streak = 0;
  let cursor = date;
  while (set.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

function formatTime(iso: string, timezone: string): string {
  const { hour, minute } = wallClock(new Date(iso), timezone);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}
