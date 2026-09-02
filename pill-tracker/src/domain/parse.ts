import { addDays } from './dates.js';
import { hmToMinutes, minutesToHm } from './logicalDate.js';

export type Intent =
  | 'DOSE'
  | 'PERIOD_START'
  | 'PERIOD_END'
  | 'SHEET_START'
  | 'PREDICT'
  | 'STATUS'
  | 'UNDO'
  | 'SET_REMINDER'
  | 'RESYNC'
  | 'SET_CALENDAR'
  | 'ALLOW'
  | 'DISALLOW'
  | 'MEMBERS'
  | 'HELP'
  | 'UNKNOWN';

export interface ParseResult {
  intent: Intent;
  /** 対象の論理日。日付を伴わない意図では today と同じ。 */
  date: string;
  /** false のときは推測せず、確認のクイックリプライを返す。 */
  confident: boolean;
  /** SET_REMINDER のときだけ 'HH:MM'。 */
  reminderTime?: string;
  /** SET_CALENDAR のときだけ、書き込み先のカレンダーID。 */
  calendarId?: string;
  /** ALLOW / DISALLOW のときだけ、対象の userId。 */
  targetUserId?: string;
  raw: string;
}

/** 全角→半角、空白と絵文字の除去。判定はすべてこの後の文字列で行う。 */
export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

const DOSE_WORDS = ['飲んだ', 'のんだ', '飲みました', 'のみました', '飲む', '服用', 'ピル', 'ok', 'おk'];

/** normalize が絵文字を落とすので、絵文字だけのメッセージは正規化前に見る。 */
const EMOJI_INTENT: ReadonlyArray<readonly [string, Intent]> = [
  ['💊', 'DOSE'],
  ['🩸', 'PERIOD_START'],
  ['👌', 'DOSE'],
  ['🆗', 'DOSE'],
];
const PERIOD_START_WORDS = ['生理が来た', '生理きた', '生理来た', '生理はじまった', '生理始まった', '生理', 'きた', '来た'];
const PERIOD_END_WORDS = ['生理終わった', '生理おわった', '終わった', 'おわった', 'おわり', '終わり'];
const SHEET_WORDS = ['新しいシート', 'シート開始', 'あたらしいシート', '新シート', '1錠目', '一錠目'];
const PREDICT_WORDS = ['予測', '次いつ', 'つぎいつ', 'いつ来る', '次の生理'];
const STATUS_WORDS = ['状況', '履歴', '今月', 'ステータス', 'いま'];
const UNDO_WORDS = ['取り消し', '取消', 'とりけし', '間違えた', 'まちがえた', 'やっぱ違う', '削除'];
const RESYNC_WORDS = ['同期', 'カレンダー直して', '貼り直し', '再同期'];
const HELP_WORDS = ['ヘルプ', 'help', '使い方', 'つかいかた'];

/** 「昨日飲んだ」「8/12飲んだ」のような日付指定を解く。 */
function resolveDate(text: string, today: string): string {
  if (text.includes('一昨日') || text.includes('おととい')) return addDays(today, -2);
  if (text.includes('昨日') || text.includes('きのう')) return addDays(today, -1);

  const md = /(\d{1,2})[/月](\d{1,2})日?/.exec(text);
  if (md) {
    const year = Number(today.slice(0, 4));
    const p = (n: string) => n.padStart(2, '0');
    const candidate = `${year}-${p(md[1]!)}-${p(md[2]!)}`;
    // 未来日になるなら前年の指定とみなす (年末年始の遡り記録)
    return candidate > today ? `${year - 1}-${p(md[1]!)}-${p(md[2]!)}` : candidate;
  }

  const dOnly = /(\d{1,2})日に?/.exec(text);
  if (dOnly) {
    const day = Number(dOnly[1]);
    const thisMonth = withDayOfMonth(today, day);
    // 未来日になるなら先月の指定とみなす
    return thisMonth > today ? withDayOfMonth(lastDayOfPrevMonth(today), day) : thisMonth;
  }

  return today;
}

function withDayOfMonth(ymd: string, day: number): string {
  return `${ymd.slice(0, 7)}-${String(day).padStart(2, '0')}`;
}

function lastDayOfPrevMonth(ymd: string): string {
  return addDays(`${ymd.slice(0, 7)}-01`, -1);
}

function includesAny(text: string, words: readonly string[]): boolean {
  return words.some((w) => text.includes(w));
}

export function parseMessage(raw: string, today: string): ParseResult {
  const text = normalize(raw);
  const base = { date: today, confident: true, raw } as const;

  if (text.length === 0) {
    const emoji = EMOJI_INTENT.find(([e]) => raw.includes(e));
    if (emoji) return { ...base, intent: emoji[1] };
    return { ...base, intent: 'UNKNOWN', confident: false };
  }

  // リマインド時刻の変更は数字を伴うので、他の判定より先に見る
  const reminder = /^(?:リマインド|通知|reminder)(\d{1,2}:\d{2})$/.exec(text);
  if (reminder) {
    const minutes = hmToMinutes(reminder[1]!);
    if (minutes !== null) {
      return { ...base, intent: 'SET_REMINDER', reminderTime: minutesToHm(minutes) };
    }
  }

  // userId は大文字小文字が意味を持つので、正規化前の文字列から取る
  const admin = /^(許可|追加|解除|削除|allow|deny)[:：\s]*(U[0-9a-f]{32})$/i.exec(raw.trim());
  if (admin) {
    const removing = /解除|削除|deny/i.test(admin[1]!);
    return {
      ...base,
      intent: removing ? 'DISALLOW' : 'ALLOW',
      targetUserId: admin[2]!,
    };
  }
  if (/^(メンバー|members|利用者)$/i.test(raw.trim())) {
    return { ...base, intent: 'MEMBERS' };
  }

  // カレンダーIDは正規化で壊れるので、生の文字列から取る
  const calendar = /^(?:カレンダー|calendar)[:：\s]*(\S+@\S+)$/.exec(raw.trim());
  if (calendar) {
    return { ...base, intent: 'SET_CALENDAR', calendarId: calendar[1]! };
  }

  if (includesAny(text, HELP_WORDS)) return { ...base, intent: 'HELP' };
  if (includesAny(text, RESYNC_WORDS)) return { ...base, intent: 'RESYNC' };
  if (includesAny(text, UNDO_WORDS)) return { ...base, intent: 'UNDO' };
  if (includesAny(text, SHEET_WORDS)) return { ...base, intent: 'SHEET_START', date: resolveDate(text, today) };

  // 「生理終わった」は「終わった」も「生理」も含むので、終了を先に判定する
  if (includesAny(text, PERIOD_END_WORDS)) {
    return { ...base, intent: 'PERIOD_END', date: resolveDate(text, today) };
  }
  if (includesAny(text, DOSE_WORDS)) {
    return { ...base, intent: 'DOSE', date: resolveDate(text, today) };
  }
  if (includesAny(text, PERIOD_START_WORDS)) {
    // 「きた」「来た」単体は取り違えやすいので確認を挟む
    const explicit = text.includes('生理');
    return { ...base, intent: 'PERIOD_START', date: resolveDate(text, today), confident: explicit };
  }
  if (includesAny(text, PREDICT_WORDS)) return { ...base, intent: 'PREDICT' };
  if (includesAny(text, STATUS_WORDS)) return { ...base, intent: 'STATUS' };

  return { ...base, intent: 'UNKNOWN', confident: false };
}

/** リッチメニューとクイックリプライの postback を解く。 */
export function parsePostback(data: string, today: string): ParseResult {
  const params = new URLSearchParams(data);
  const action = params.get('action') ?? '';
  const date = params.get('date') ?? today;

  const map: Record<string, Intent> = {
    dose: 'DOSE',
    period_start: 'PERIOD_START',
    period_end: 'PERIOD_END',
    sheet_start: 'SHEET_START',
    predict: 'PREDICT',
    status: 'STATUS',
    undo: 'UNDO',
    help: 'HELP',
    resync: 'RESYNC',
    none: 'UNKNOWN',
  };

  const intent = map[action] ?? 'UNKNOWN';
  return { intent, date, confident: intent !== 'UNKNOWN', raw: data };
}
