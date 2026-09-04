import { describe, expect, it } from 'vitest';
import { normalize, parseMessage, parsePostback } from '../src/domain/parse.js';

const TODAY = '2026-08-30';
const p = (text: string) => parseMessage(text, TODAY);

describe('normalize', () => {
  it('全角・空白・絵文字を落とす', () => {
    expect(normalize('　飲んだ 💊 ')).toBe('飲んだ');
    expect(normalize('ＯＫ')).toBe('ok');
  });
});

describe('服薬', () => {
  it.each(['飲んだ', 'のんだ', '飲みました', 'ピル飲んだ', 'OK', '💊'])('%s → DOSE', (text) => {
    const r = p(text);
    expect(r.intent).toBe('DOSE');
    expect(r.date).toBe(TODAY);
    expect(r.confident).toBe(true);
  });

  it('昨日・一昨日を解く', () => {
    expect(p('昨日飲んだ').date).toBe('2026-08-29');
    expect(p('一昨日飲んだ').date).toBe('2026-08-28');
  });

  it('8/12 のような日付指定を解く', () => {
    expect(p('8/12 飲んだ').date).toBe('2026-08-12');
    expect(p('8月12日に飲んだ').date).toBe('2026-08-12');
  });

  it('未来日になる指定は前年とみなす', () => {
    expect(p('12/25 飲んだ').date).toBe('2025-12-25');
  });

  it('N日 の指定が未来なら先月とみなす', () => {
    expect(p('12日に飲んだ').date).toBe('2026-08-12');
    expect(p('31日に飲んだ').date).toBe('2026-07-31');
  });
});

describe('生理', () => {
  it('明示的な言い方は confident', () => {
    for (const text of ['生理が来た', '生理きた', '生理']) {
      const r = p(text);
      expect(r.intent).toBe('PERIOD_START');
      expect(r.confident).toBe(true);
    }
  });

  it('「きた」単体は取り違えやすいので確認を挟む', () => {
    const r = p('きた');
    expect(r.intent).toBe('PERIOD_START');
    expect(r.confident).toBe(false);
  });

  it('終了は開始より先に判定される', () => {
    // 「生理終わった」は「生理」も「終わった」も含むので順序が効く
    expect(p('生理終わった').intent).toBe('PERIOD_END');
    expect(p('終わった').intent).toBe('PERIOD_END');
  });
});

describe('その他の意図', () => {
  it.each([
    ['新しいシート', 'SHEET_START'],
    ['1錠目', 'SHEET_START'],
    ['予測', 'PREDICT'],
    ['次いつ', 'PREDICT'],
    ['状況', 'STATUS'],
    ['取り消し', 'UNDO'],
    ['間違えた', 'UNDO'],
    ['ヘルプ', 'HELP'],
    ['同期', 'RESYNC'],
    ['カレンダー直して', 'RESYNC'],
  ])('%s → %s', (text, intent) => {
    expect(p(text).intent).toBe(intent);
  });

  it('シート起点に過去の日付を指定できる', () => {
    const r = p('8/30 新しいシート');
    expect(r.intent).toBe('SHEET_START');
    expect(r.date).toBe('2026-08-30');
  });

  it('一昨日でもシート起点を指定できる', () => {
    expect(p('一昨日 新しいシート').date).toBe('2026-08-28');
  });

  it('語順・全角スペース・「8月30日」形式のどれでも同じに読む', () => {
    for (const text of [
      '新しいシート　8月30日',
      '新しいシート 8月30日',
      '新しいシート 8/30',
      '8/30 新しいシート',
      '新しいシート　8月30日から',
    ]) {
      const r = p(text);
      expect(r.intent, text).toBe('SHEET_START');
      expect(r.date, text).toBe('2026-08-30');
    }
  });

  it('利用者の追加コマンドを読む', () => {
    const id = 'U' + 'a1b2c3d4e5f6'.repeat(2) + 'a1b2c3d4';
    const r = p(`許可 ${id}`);
    expect(r.intent).toBe('ALLOW');
    expect(r.targetUserId).toBe(id);
  });

  it('解除コマンドを読む', () => {
    const id = 'U' + '0123456789ab'.repeat(2) + '01234567';
    expect(p(`解除 ${id}`).intent).toBe('DISALLOW');
  });

  it('userId の形をしていないものは管理コマンドにしない', () => {
    expect(p('許可 して').intent).not.toBe('ALLOW');
    expect(p('削除').intent).toBe('UNDO');
  });

  it('メンバー一覧', () => {
    expect(p('メンバー').intent).toBe('MEMBERS');
  });

  it('追い打ちの間隔を読む', () => {
    expect(p('追い打ち 2時間')).toMatchObject({ intent: 'SET_NUDGE', offsetMinutes: 120 });
    expect(p('追い打ち 90分')).toMatchObject({ intent: 'SET_NUDGE', offsetMinutes: 90 });
    expect(p('追い打ち 1時間30分')).toMatchObject({ intent: 'SET_NUDGE', offsetMinutes: 90 });
  });

  it('最終通知の間隔と無効化を読む', () => {
    expect(p('最終通知 4時間')).toMatchObject({ intent: 'SET_FINAL_NUDGE', offsetMinutes: 240 });
    expect(p('最終通知 なし')).toMatchObject({ intent: 'SET_FINAL_NUDGE', offsetMinutes: null });
  });

  it('解釈できない指定は設定コマンドにしない', () => {
    expect(p('追い打ち たくさん').intent).not.toBe('SET_NUDGE');
  });

  it('通知の受け取りを切り替える', () => {
    expect(p('通知 オフ')).toMatchObject({ intent: 'SET_NOTIFICATIONS', notifications: 0 });
    expect(p('通知 オン')).toMatchObject({ intent: 'SET_NOTIFICATIONS', notifications: 1 });
    expect(p('通知 自動')).toMatchObject({ intent: 'SET_NOTIFICATIONS', notifications: null });
  });

  it('「通知 21:00」は従来どおりリマインド時刻として読む', () => {
    expect(p('通知 21:00')).toMatchObject({ intent: 'SET_REMINDER', reminderTime: '21:00' });
  });

  it('カレンダーIDを読む', () => {
    const r = p('カレンダー abc123@group.calendar.google.com');
    expect(r.intent).toBe('SET_CALENDAR');
    expect(r.calendarId).toBe('abc123@group.calendar.google.com');
  });

  it('メールアドレス形式でないものは SET_CALENDAR にしない', () => {
    expect(p('カレンダー 見せて').intent).not.toBe('SET_CALENDAR');
  });

  it('リマインド時刻を読む', () => {
    const r = p('リマインド 21:00');
    expect(r.intent).toBe('SET_REMINDER');
    expect(r.reminderTime).toBe('21:00');
  });

  it('不正な時刻は SET_REMINDER にしない', () => {
    expect(p('リマインド 99:99').intent).not.toBe('SET_REMINDER');
  });

  it('判定できないものは UNKNOWN かつ confident=false', () => {
    const r = p('明日は雨らしい');
    expect(r.intent).toBe('UNKNOWN');
    expect(r.confident).toBe(false);
  });

  it('空文字も落とさない', () => {
    expect(p('   ').intent).toBe('UNKNOWN');
  });
});

describe('postback', () => {
  it('日付つきのアクションを解く', () => {
    const r = parsePostback('action=dose&date=2026-08-29', TODAY);
    expect(r.intent).toBe('DOSE');
    expect(r.date).toBe('2026-08-29');
    expect(r.confident).toBe(true);
  });

  it('日付が無ければ今日', () => {
    expect(parsePostback('action=predict', TODAY).date).toBe(TODAY);
  });

  it('未知のアクションは UNKNOWN', () => {
    expect(parsePostback('action=bogus', TODAY).intent).toBe('UNKNOWN');
  });
});
