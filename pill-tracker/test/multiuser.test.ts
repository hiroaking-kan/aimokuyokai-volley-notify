import { describe, expect, it } from 'vitest';
import { calendarName } from '../src/calendar/sync.js';
import { parseAllowlist } from '../src/index.js';

describe('parseAllowlist', () => {
  it('1人だけならそのまま1件', () => {
    expect(parseAllowlist('U1234')).toEqual(['U1234']);
  });

  it('カンマ区切りで複数を許可する', () => {
    expect(parseAllowlist('U1111,U2222,U3333')).toEqual(['U1111', 'U2222', 'U3333']);
  });

  it('前後の空白や改行を無視する', () => {
    expect(parseAllowlist(' U1111 , U2222 \n')).toEqual(['U1111', 'U2222']);
  });

  it('空の項目は落とす (末尾カンマで誰でも通ることがないように)', () => {
    expect(parseAllowlist('U1111,,')).toEqual(['U1111']);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist(undefined)).toEqual([]);
  });
});

describe('calendarName', () => {
  it('表示名で誰のものか分かるようにする', () => {
    expect(calendarName({ display_name: 'さくら', line_user_id: 'U123' })).toBe(
      'ピル・生理記録（さくら）',
    );
  });

  it('表示名が取れなければ userId の一部で代用する', () => {
    expect(calendarName({ display_name: null, line_user_id: 'Uabcdef0123' })).toBe(
      'ピル・生理記録（abcdef）',
    );
  });

  it('空白だけの表示名は無いものとして扱う', () => {
    expect(calendarName({ display_name: '   ', line_user_id: 'Uabcdef0123' })).toBe(
      'ピル・生理記録（abcdef）',
    );
  });

  it('利用者が違えば名前も違う (同じカレンダーを共有しない)', () => {
    const a = calendarName({ display_name: 'さくら', line_user_id: 'U111' });
    const b = calendarName({ display_name: 'ゆき', line_user_id: 'U222' });
    expect(a).not.toBe(b);
  });
});
