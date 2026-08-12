import nodemailer from 'nodemailer';

const {
  LINE_TOKEN,
  LINE_USER_ID,
  GMAIL_USER,
  GMAIL_APP_PASS,
  NOTIFY_TO,
} = process.env;

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
  await transporter.sendMail({ from: GMAIL_USER, to: NOTIFY_TO, subject, text: body });
}

// LINE と メールの両方に投げる。片方が落ちてももう片方は送りたいので allSettled。
export async function notify(title, body) {
  console.log(`\n=== NOTIFY ===\n${title}\n${body}\n==============\n`);
  const results = await Promise.allSettled([
    sendLine(`${title}\n\n${body}`),
    sendEmail(title, body),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('notify channel failed:', r.reason);
  }
}
