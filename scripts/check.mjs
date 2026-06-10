import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';

const CALENDAR_API_IDS = [
  'cal-70ew5hCCuAPCCMk', // AI木曜会(メンバー限定)
  'cal-EKlRmHMjJTEbiIZ', // テスト用: ユーザー個人カレンダー (テスト完了後に削除)
];
const NAME_PATTERN = /テストバレー\d+会/;
const STATE_FILE = 'state/known_events.json';
const LUMA_API = (id) =>
  `https://api.lu.ma/calendar/get-items?calendar_api_id=${id}&period=future&pagination_limit=100`;

const {
  LINE_TOKEN,
  LINE_USER_ID,
  GMAIL_USER,
  GMAIL_APP_PASS,
  NOTIFY_TO,
} = process.env;

async function fetchEvents() {
  const all = [];
  for (const id of CALENDAR_API_IDS) {
    const res = await fetch(LUMA_API(id), {
      headers: { 'User-Agent': 'luma-watch/1.0 (+github actions)' },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Luma API ${res.status} for ${id}: ${body.slice(0, 500)}`);
    }
    const data = await res.json();
    for (const entry of data.entries ?? []) all.push(entry);
  }
  return all;
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { known: {} };
  }
}

async function saveState(state) {
  await fs.mkdir('state', { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

async function sendLine(text) {
  if (!LINE_TOKEN || !LINE_USER_ID) {
    console.log('[skip LINE] missing LINE_TOKEN or LINE_USER_ID');
    return;
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({
      to: LINE_USER_ID,
      messages: [{ type: 'text', text: text.slice(0, 4900) }],
    }),
  });
  if (!res.ok) {
    throw new Error(`LINE push ${res.status}: ${await res.text()}`);
  }
}

async function sendEmail(subject, body) {
  if (!GMAIL_USER || !GMAIL_APP_PASS || !NOTIFY_TO) {
    console.log('[skip email] missing GMAIL_USER, GMAIL_APP_PASS, or NOTIFY_TO');
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS },
  });
  await transporter.sendMail({
    from: GMAIL_USER,
    to: NOTIFY_TO,
    subject,
    text: body,
  });
}

async function notify(title, body) {
  console.log(`\n=== NOTIFY ===\n${title}\n${body}\n==============\n`);
  const results = await Promise.allSettled([
    sendLine(`${title}\n\n${body}`),
    sendEmail(title, body),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('notify channel failed:', r.reason);
  }
}

function formatJst(iso) {
  return new Date(iso).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function main() {
  if (process.env.TEST_MODE === '1') {
    await notify(
      '✅ Luma Watch テスト通知',
      `これはテスト通知です。\nLINE / メールの設定が正しく動作しています。\n\n送信時刻: ${new Date().toISOString()}`
    );
    console.log('Test notification sent.');
    return;
  }

  const entries = await fetchEvents();
  const state = await loadState();
  state.known ??= {};

  const matches = entries
    .map((e) => e.event)
    .filter((ev) => ev?.name && NAME_PATTERN.test(ev.name));

  console.log(`Found ${entries.length} future events; ${matches.length} match pattern.`);

  const newEvents = [];
  const nowIso = new Date().toISOString();

  for (const ev of matches) {
    const url = `https://lu.ma/${ev.url}`;
    const existing = state.known[ev.api_id];
    if (!existing) newEvents.push(ev);
    state.known[ev.api_id] = {
      name: ev.name,
      url,
      start_at: ev.start_at,
      first_seen_at: existing?.first_seen_at ?? nowIso,
      last_seen_at: nowIso,
    };
  }

  for (const ev of newEvents) {
    const url = `https://lu.ma/${ev.url}`;
    const start = formatJst(ev.start_at);
    await notify(
      `🏐 ${ev.name}`,
      `開催日時: ${start}\nLuma: ${url}\n\n募集が開始されました。お早めにご登録ください。`
    );
  }

  await saveState(state);
  console.log(`Done. New notifications: ${newEvents.length}.`);
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  try {
    await notify('⚠️ Luma watch failed', String(err?.stack ?? err).slice(0, 2000));
  } catch (e) {
    console.error('failed to notify about failure:', e);
  }
  process.exit(1);
});
