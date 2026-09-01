import type { Context } from 'hono';
import { Hono } from 'hono';
import { GasCalendar } from './calendar/gas.js';
import { CalendarSync } from './calendar/sync.js';
import { handleEvent } from './handler.js';
import { runNotifications } from './jobs/notify.js';
import { LineClient } from './line/client.js';
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
  // 許可した userId 以外は一切処理しない
  if (!userId || userId !== env.ALLOWED_LINE_USER_ID) return;

  const store = new Store(env.DB);

  // LINE は同じイベントを再送してくる
  const eventId = event.webhookEventId;
  if (eventId && !(await store.claimWebhookEvent(eventId))) return;

  try {
    const deps = buildDeps(env, store);
    const reply = await handleEvent(deps, userId, event, new Date());
    if (!reply) return;

    if (event.replyToken) {
      await deps.line.reply(event.replyToken, reply.text, reply.quickReplies);
    }
    if (reply.after) {
      ctx.waitUntil(
        reply.after().catch((err: Error) => console.error(`calendar sync failed: ${err.message}`)),
      );
    }
  } catch (err) {
    // 途中で落ちたら予約を戻し、LINE の再送で取り直せるようにする。
    // 服薬の記録を黙って取りこぼすほうが害が大きい。
    if (eventId) await store.releaseWebhookEvent(eventId);
    throw err;
  }
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
    ctx.waitUntil(runNotifications(buildDeps(env, store), new Date()));
  },
};
