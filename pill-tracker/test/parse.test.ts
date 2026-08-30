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
  ])('%s → %s', (text, intent) => {
    expect(p(text).intent).toBe(intent);
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
