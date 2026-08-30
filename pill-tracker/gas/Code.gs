/**
 * ピル・生理記録 — カレンダー書き込み担当 (Google Apps Script)
 *
 * Cloudflare Workers から呼ばれ、Google カレンダーへの書き込みだけを行う。
 * こちらはスクリプト所有者の権限で動くので、OAuth クライアントの作成も
 * 同意画面の公開も refresh token の失効管理も要らない。
 *
 * LINE の Webhook は Workers 側で受けて署名検証しているため、
 * 「GAS はヘッダが読めず x-line-signature を検証できない」という
 * GAS 単体構成の弱点はこの構成では踏まない。
 *
 * 必要な設定:
 *   1. エディタの「サービス」から Calendar API (Advanced Calendar Service) を追加
 *      → イベントIDをこちらで指定できるようになり、冪等な書き込みが保てる
 *   2. スクリプトプロパティ SHARED_SECRET に Workers と同じ値を設定
 *   3. デプロイ: 種類=ウェブアプリ / 実行ユーザー=自分 / アクセス=全員
 *      ※ 再デプロイ時は「デプロイを管理 → 既存デプロイを編集」で URL を保つこと
 */

/** リプレイを弾く猶予 (ミリ秒)。Workers 側の MAX_SKEW_MS と揃える。 */
var MAX_SKEW_MS = 5 * 60 * 1000;

function doPost(e) {
  try {
    var envelope = JSON.parse(e.postData.contents);
    var secret = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
    if (!secret) return fail_('SHARED_SECRET is not set');

    if (!verify_(envelope.payload, envelope.sig, secret)) return fail_('bad signature');

    var body = JSON.parse(envelope.payload);
    if (Math.abs(Date.now() - body.ts) > MAX_SKEW_MS) return fail_('stale request');

    return ok_(dispatch_(body));
  } catch (err) {
    // 本文にイベントの中身は出さない (ログに健康情報を残さない)
    return fail_(String(err && err.name ? err.name : 'error'));
  }
}

function dispatch_(body) {
  switch (body.op) {
    case 'ensureCalendar':
      return { calendarId: ensureCalendar_(body.summary, body.timezone) };
    case 'upsert':
      return { eventId: upsertEvent_(body.calendarId, body.event) };
    case 'remove':
      removeEvent_(body.calendarId, body.eventId);
      return {};
    default:
      throw new Error('unknown op');
  }
}

/** 同名のカレンダーがあれば使い回す。リトライで増殖させないため。 */
function ensureCalendar_(summary, timezone) {
  var existing = CalendarApp.getCalendarsByName(summary);
  if (existing && existing.length > 0) return existing[0].getId();

  var created = CalendarApp.createCalendar(summary, { timeZone: timezone });
  return created.getId();
}

/**
 * イベントIDを指定した冪等な upsert。
 * まず update し、まだ無ければ (404) 同じIDで insert する。
 */
function upsertEvent_(calendarId, event) {
  try {
    Calendar.Events.update(event, calendarId, event.id);
    return event.id;
  } catch (err) {
    if (!isNotFound_(err)) throw err;
  }

  try {
    Calendar.Events.insert(event, calendarId);
  } catch (err) {
    // 409 は「別経路で作成済み」なので成功として扱う
    if (!isAlreadyExists_(err)) throw err;
  }
  return event.id;
}

function removeEvent_(calendarId, eventId) {
  try {
    Calendar.Events.remove(calendarId, eventId);
  } catch (err) {
    // すでに無いものを消そうとしただけなら成功扱い
    if (!isNotFound_(err) && !isDeleted_(err)) throw err;
  }
}

function isNotFound_(err) {
  return /\b404\b|Not Found/i.test(String(err));
}

function isDeleted_(err) {
  return /\b410\b|deleted/i.test(String(err));
}

function isAlreadyExists_(err) {
  return /\b409\b|already exists|duplicate/i.test(String(err));
}

/** 定数時間に近い比較。長さの違いも先に潰す。 */
function verify_(payload, sig, secret) {
  if (!payload || !sig) return false;
  var expected = sign_(payload, secret);
  if (expected.length !== sig.length) return false;

  var diff = 0;
  for (var i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return diff === 0;
}

function sign_(payload, secret) {
  var raw = Utilities.computeHmacSha256Signature(payload, secret);
  var hex = '';
  for (var i = 0; i < raw.length; i++) {
    hex += ('0' + (raw[i] & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

function ok_(extra) {
  var body = { ok: true };
  for (var k in extra) body[k] = extra[k];
  return json_(body);
}

function fail_(message) {
  return json_({ ok: false, error: message });
}

function json_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
