import type { CalendarSync } from '../calendar/sync.js';
import { addDays, diffDays } from '../domain/dates.js';
import {
  hmToMinutes,
  isQuietHour,
  logicalDate,
  offsetFrom,
  wallClock,
} from '../domain/logicalDate.js';
import { missedBleedSheets, predictBleeds } from '../domain/predict.js';
import { ACTIVE_LEN, dayInSheet, isPlacebo } from '../domain/sheet.js';
import type { LineClient } from '../line/client.js';
import * as M from '../line/messages.js';
import { QR } from '../line/messages.js';
import type { Store, UserRow } from '../store/db.js';

/**
 * cron の取りこぼしを吸収する猶予。5分おきに起動するが、
 * 実行が遅れてもこの範囲内なら送る。二重送信は
 * sent_notifications の UNIQUE が防ぐので、窓を広げても安全。
 */
const CATCHUP_MINUTES = 60;

/** 朝の通知 (プラセボ予告・出血予測・出血なし) を送る時刻。 */
const MORNING = 9 * 60;

export interface NotifyDeps {
  store: Store;
  line: LineClient;
  sync: CalendarSync;
}

export async function runNotifications(deps: NotifyDeps, now: Date): Promise<void> {
  for (const user of await deps.store.listUsers()) {
    try {
      await notifyUser(deps, user, now);
    } catch (err) {
      console.error(`notify failed for user: ${(err as Error).message}`);
    }
  }
}

async function notifyUser(deps: NotifyDeps, user: UserRow, now: Date): Promise<void> {
  const { store, line } = deps;
  const userId = user.line_user_id;
  const { hour, minute } = wallClock(now, user.timezone);
  const nowMinutes = hour * 60 + minute;
  const today = logicalDate(now, user.timezone, user.day_start_hour);

  const anchor = user.sheet_anchor;
  const day = anchor ? dayInSheet(anchor, today) : null;
  const recorded = (await store.getDose(userId, today)) !== null;

  const reminderMinutes = hmToMinutes(user.reminder_time) ?? 21 * 60;

  // --- 服薬リマインド ----------------------------------------------------
  if (!recorded && due(nowMinutes, reminderMinutes)) {
    await send(deps, user, 'reminder', today, M.reminder(day), [QR.dose(today)]);
  }

  // --- 飲み忘れ検知 ------------------------------------------------------
  // 追い打ちはリマインドからの経過時間で決める。時刻を固定していると、
  // リマインドを変えたときに間隔が詰まったり順序が入れ替わったりする。
  //
  // 回数は実薬とプラセボで分ける。文面はどちらも事実の提示に留め、
  // 医学的な意味づけ (飲み忘れたときどうするか) はbotに言わせない。
  const nudge1 = offsetFrom(reminderMinutes, user.nudge_after_min);
  if (!recorded && sendable(nudge1, user) && due(nowMinutes, nudge1)) {
    await send(deps, user, 'nudge1', today, M.nudge(day), [QR.dose(today)]);
  }

  const activeDay = day === null || !isPlacebo(day);
  const finalOffset = user.final_nudge_after_min;
  if (!recorded && activeDay && finalOffset !== null) {
    const nudge2 = offsetFrom(reminderMinutes, finalOffset);
    if (sendable(nudge2, user) && due(nowMinutes, nudge2)) {
      await send(deps, user, 'nudge2', today, M.finalNudge(), [QR.dose(today)]);
    }
  }

  if (!anchor) return;

  const starts = await store.listPeriodStarts(userId);

  // --- プラセボ期間の予告 (シート Day 24) --------------------------------
  if (day === ACTIVE_LEN && due(nowMinutes, MORNING)) {
    const next = predictBleeds(anchor, starts, addDays(today, 1), 1)[0] ?? null;
    await send(deps, user, 'placebo_notice', today, M.placeboNotice(addDays(today, 1), next), []);
  }

  // --- 消退出血の事前通知 ------------------------------------------------
  if (due(nowMinutes, MORNING)) {
    const next = predictBleeds(anchor, starts, today, 1)[0];
    if (next && diffDays(today, next.date) === user.period_notice_days) {
      await send(deps, user, 'bleed_notice', today, M.bleedNotice(next), [QR.periodStart(today)]);
    }
  }

  // --- 出血なしアラート (次シートの Day 1) --------------------------------
  // Day 28 の時点ではプラセボ期間がまだ終わっていないので、
  // 直前のプラセボ期間が完了した翌日 (= 次シートの1日目) に判定する。
  if (day === 1 && due(nowMinutes, MORNING)) {
    const missed = missedBleedSheets(anchor, starts, today);
    if (missed >= 2) {
      await send(deps, user, 'no_bleed_alert', today, M.noBleedAlert(missed), []);
    }
  }

  // --- 予測の先出しを維持する --------------------------------------------
  // ラグが更新されていなくても、シートが進めば地平線の先が1枚増える。
  if (day === 1 && due(nowMinutes, MORNING)) {
    await deps.sync.syncSchedule(user, today);
  }
}

/**
 * target を過ぎていて、まだ猶予の内側か。
 *
 * 日をまたいだ target (リマインドが遅い時刻のとき) も扱えるよう、
 * 差は 24時間で巻き取って測る。同じ通知が二度出ないことは
 * sent_notifications 側が保証しているので、巻き取っても安全。
 */
function due(nowMinutes: number, target: number): boolean {
  const delta = (((nowMinutes - target) % 1440) + 1440) % 1440;
  return delta < CATCHUP_MINUTES;
}

/** 深夜帯には送らない。起こしてまで知らせる種類の通知ではない。 */
function sendable(targetMinutes: number, user: UserRow): boolean {
  return !isQuietHour(targetMinutes, user.day_start_hour);
}

async function send(
  deps: NotifyDeps,
  user: UserRow,
  kind: string,
  localDate: string,
  text: string,
  quickReplies: ReturnType<typeof QR.dose>[],
): Promise<void> {
  // 先に予約を取ってから送る。cron が多重起動しても二重送信にならない。
  const claimed = await deps.store.claimNotification(user.line_user_id, kind, localDate);
  if (!claimed) return;

  try {
    await deps.line.push(user.line_user_id, text, quickReplies);
  } catch (err) {
    // 送れなかったぶんは予約を戻し、次の起動で再試行させる
    await deps.store.releaseNotification(user.line_user_id, kind, localDate);
    throw err;
  }
}
