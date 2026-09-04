import type { Context } from 'hono';
import { Hono } from 'hono';
import { GasCalendar } from './calendar/gas.js';
import { CalendarSync } from './calendar/sync.js';
import { logicalDate } from './domain/logicalDate.js';
import { handleEvent } from './handler.js';
import { runNotifications } from './jobs/notify.js';
import { LineClient } from './line/client.js';
import * as M from './line/messages.js';
import { verifySignature } from './line/verify.js';
import { Store } from './store/db.js';

export interface Env {
  DB: D1Database;
  TZ_NAME: string;
  LINE_CHANNEL_SECRET: string;
  LINE_ACCESS_TOKEN: string;
  ALLOWED_LINE_USER_ID: string;
  /** カレンダー書き込みを担う GAS ウェブアプリの /exec URL。 */
  GAS_CALENDAR_URL: string;
  /** Workers ⇄ GAS の共有シークレット。 */
  GAS_SHARED_SECRET: string;
}

interface LineWebhookEvent {
  type: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: { userId?: string };
  message?: { type: string; text?: string };
  postback?: { data: string };
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('pill-tracker'));

// 末尾スラッシュ付きでも受ける。LINE の Webhook URL の設定間違いで
// 404 になるのを防ぐため。
app.post('/webhook/', (c) => webhook(c));
app.post('/webhook', (c) => webhook(c));

// パスを間違えたときに、何が正しいかを本文で伝える
app.notFound((c) =>
  c.text(`not found. LINE の Webhook URL には ${new URL(c.req.url).origin}/webhook を設定してください`, 404),
);

async function webhook(c: Context<{ Bindings: Env }>) {
  const body = await c.req.text();

  const ok = await verifySignature(
    c.env.LINE_CHANNEL_SECRET,
    body,
    c.req.header('x-line-signature') ?? null,
  );
  if (!ok) return c.text('unauthorized', 401);

  const payload = JSON.parse(body) as { events?: LineWebhookEvent[] };
  const events = payload.events ?? [];

  // LINE は Webhook の遅延に厳しい。返信だけ同期で行い、
  // カレンダー書き込みは waitUntil に逃がして即座に 200 を返す。
  for (const event of events) {
    await processEvent(c.env, event, c.executionCtx);
  }

  return c.text('ok');
}

/** waitUntil だけ使うので、workers-types と Hono の型差を避けて構造的に受ける。 */
interface Waiter {
  waitUntil(promise: Promise<unknown>): void;
}

async function processEvent(env: Env, event: LineWebhookEvent, ctx: Waiter): Promise<void> {
  const userId = event.source?.userId;
  if (!userId) return;

  const store = new Store(env.DB);
  const owners = parseAllowlist(env.ALLOWED_LINE_USER_ID);
  const owner = owners.includes(userId);

  // 許可した userId 以外は記録に触らせない。
  // ただし本人に自分の userId は返す。LINE Official Account Manager は
  // userId を表示しないので、これがないと運用者がログを見に行くしかなくなる。
  if (!owner && !(await store.isAllowedUser(userId))) {
    console.log(`unregistered sender: ${userId}`);
    if (event.replyToken) {
      await new LineClient(env.LINE_ACCESS_TOKEN).reply(
        event.replyToken,
        [
          'このbotはまだあなたを登録していません。',
          '管理者に次のIDを伝えてください。',
          '',
          userId,
        ].join('\n'),
      );
    }
    return;
  }

  // LINE は同じイベントを再送してくる
  const eventId = event.webhookEventId;
  if (eventId && !(await store.claimWebhookEvent(eventId))) return;

  try {
    const deps = { ...buildDeps(env, store), owner, owners };
    const reply = await handleEvent(deps, userId, event, new Date());
    if (!reply) return;

    if (event.replyToken) {
      await deps.line.reply(event.replyToken, reply.text, reply.quickReplies);
    }
    if (reply.after) {
      ctx.waitUntil(reply.after().catch((err: Error) => reportSyncFailure(env, store, userId, err)));
    }
  } catch (err) {
    // 途中で落ちたら予約を戻し、LINE の再送で取り直せるようにする。
    // 服薬の記録を黙って取りこぼすほうが害が大きい。
    if (eventId) await store.releaseWebhookEvent(eventId);
    throw err;
  }
}

/**
 * カレンダーへの書き込みが失敗したことを本人に伝える。
 *
 * 放置して使うものなので、黙って書き込まれないまま進むのがいちばん困る。
 * 記録自体は D1 に入っているため、「同期」で貼り直せば復旧できる。
 * 1日1通までに抑える (連投でプッシュの無料枠を食わないように)。
 */
async function reportSyncFailure(env: Env, store: Store, userId: string, err: Error): Promise<void> {
  console.error(`calendar sync failed: ${err.message}`);

  const today = logicalDate(new Date(), env.TZ_NAME, DEFAULT_DAY_START_HOUR);
  if (!(await store.claimNotification(userId, 'sync_failed', today))) return;

  await new LineClient(env.LINE_ACCESS_TOKEN)
    .push(userId, M.syncFailed())
    .catch((pushErr: Error) => console.error(`sync failure notice failed: ${pushErr.message}`));
}

/** 通知の重複判定にだけ使う。利用者ごとの設定は handler 側で見ている。 */
const DEFAULT_DAY_START_HOUR = 4;

/** カンマ区切りで複数の userId を許可する。1人だけならそのまま1件。 */
export function parseAllowlist(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

function buildDeps(env: Env, store: Store) {
  const line = new LineClient(env.LINE_ACCESS_TOKEN);
  const calendar = new GasCalendar(env.GAS_CALENDAR_URL, env.GAS_SHARED_SECRET);
  return { store, line, sync: new CalendarSync(store, calendar), timezone: env.TZ_NAME };
}

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const store = new Store(env.DB);
    const deps = { ...buildDeps(env, store), owners: parseAllowlist(env.ALLOWED_LINE_USER_ID) };
    ctx.waitUntil(runNotifications(deps, new Date()));
  },
};
