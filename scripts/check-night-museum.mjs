import fs from 'node:fs/promises';
import nodemailer from 'nodemailer';
import * as cheerio from 'cheerio';

// 横浜ナイトミュージアム (MYSTERY OF TUTANKHAMEN) の asoview チケット販売ページを監視する。
// 月替わりのチケット詳細ページは毎回 URL が変わるため、まずチャンネルの一覧ページから
// 「9月分」のリンクを探し、見つかったら詳細ページの「販売期間」欄を確認する。
const CHANNEL_LIST_URL = 'https://www.asoview.com/channel/tickets/w1aENKVx1j/';
const TARGET_MONTH_PATTERN = /9月分/;
const VENUE_KEYWORD_PATTERN = /ナイトミュージアム|NIGHT\s*MUSEUM|TUTANKHAMEN/i;
const STATE_FILE = 'state/night_museum_state.json';

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
};

const {
  LINE_TOKEN,
  LINE_USER_ID,
  GMAIL_USER,
  GMAIL_APP_PASS,
  NOTIFY_TO,
} = process.env;

async function fetchHtml(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status}`);
  }
  return res.text();
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return { ticketUrl: null, salesPeriodText: null, notifiedSalesPeriodText: null };
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

// 一覧ページから「9月分」かつナイトミュージアム関連のチケット詳細リンクを探す。
function findTargetTicketUrl(listHtml) {
  const $ = cheerio.load(listHtml);
  let found = null;
  $('a[href*="/channel/ticket/"]').each((_, el) => {
    if (found) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (TARGET_MONTH_PATTERN.test(text) && VENUE_KEYWORD_PATTERN.test(text)) {
      const href = $(el).attr('href');
      found = new URL(href, CHANNEL_LIST_URL).toString();
    }
  });
  return found;
}

// 詳細ページから「販売期間」欄のテキストを抽出する (dt/dd, table, div 等いくつかの構造を試す)。
function extractSalesPeriodText(detailHtml) {
  const $ = cheerio.load(detailHtml);
  let value = null;
  $('dt, th, td, div, span').each((_, el) => {
    if (value) return;
    const label = $(el).text().trim();
    if (label !== '販売期間') return;
    const $next = $(el).next();
    const candidate = $next.text().replace(/\s+/g, ' ').trim();
    if (candidate) value = candidate;
  });
  return value;
}

// 期間テキストの開始側 (〜より前) に時刻 (HH:MM) が含まれているかで、
// 「販売開始時刻が公表済みかどうか」を判定する。
function isStartTimeAnnounced(salesPeriodText) {
  if (!salesPeriodText) return false;
  const [startPart] = salesPeriodText.split('〜');
  return /\d{1,2}:\d{2}/.test(startPart ?? '');
}

async function main() {
  if (process.env.TEST_MODE === '1') {
    await notify(
      '✅ Night Museum Watch テスト通知',
      `これはテスト通知です。\nLINE / メールの設定が正しく動作しています。\n\n送信時刻: ${new Date().toISOString()}`
    );
    console.log('Test notification sent.');
    return;
  }

  const state = await loadState();

  const listHtml = await fetchHtml(CHANNEL_LIST_URL);
  const ticketUrl = findTargetTicketUrl(listHtml);

  if (!ticketUrl) {
    console.log('9月分のチケットページはまだ一覧に見つかりません。');
    state.ticketUrl = null;
    await saveState(state);
    console.log('Done. New notifications: 0.');
    return;
  }

  console.log(`9月分チケットページを検出: ${ticketUrl}`);
  const detailHtml = await fetchHtml(ticketUrl);
  const salesPeriodText = extractSalesPeriodText(detailHtml);
  console.log(`販売期間: ${salesPeriodText ?? '(取得できず)'}`);

  const announced = isStartTimeAnnounced(salesPeriodText);
  let notified = 0;

  if (
    announced &&
    salesPeriodText &&
    salesPeriodText !== state.notifiedSalesPeriodText
  ) {
    await notify(
      '🏛️ ナイトミュージアム 9月分 販売開始時刻が公表されました',
      `販売期間: ${salesPeriodText}\n\nチケットページ: ${ticketUrl}\n\nお早めにご購入ください。`
    );
    state.notifiedSalesPeriodText = salesPeriodText;
    notified = 1;
  } else if (!announced) {
    console.log('9月分ページは見つかりましたが、開始時刻はまだ未公表のようです。');
  } else {
    console.log('前回と同じ内容のため通知はスキップします。');
  }

  state.ticketUrl = ticketUrl;
  state.salesPeriodText = salesPeriodText;
  await saveState(state);
  console.log(`Done. New notifications: ${notified}.`);
}

main().catch(async (err) => {
  console.error('FATAL:', err);
  try {
    await notify('⚠️ Night museum watch failed', String(err?.stack ?? err).slice(0, 2000));
  } catch (e) {
    console.error('failed to notify about failure:', e);
  }
  process.exit(1);
});
