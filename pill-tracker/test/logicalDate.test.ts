import { describe, expect, it } from 'vitest';
import {
  hmToMinutes,
  isQuietHour,
  logicalDate,
  minutesToHm,
  offsetFrom,
  wallClock,
} from '../src/domain/logicalDate.js';

const TZ = 'Asia/Tokyo';

describe('logicalDate', () => {
  it('日中はその日の日付', () => {
    // 2026-08-30 21:04 JST = 12:04Z
    expect(logicalDate(new Date('2026-08-30T12:04:00Z'), TZ, 4)).toBe('2026-08-30');
  });

  it('深夜0時半の記録は前日に寄せる', () => {
    // 2026-08-31 00:30 JST = 2026-08-30 15:30Z
    expect(logicalDate(new Date('2026-08-30T15:30:00Z'), TZ, 4)).toBe('2026-08-30');
  });

  it('切り替え時刻ちょうどからは当日', () => {
    // 2026-08-31 04:00 JST = 2026-08-30 19:00Z
    expect(logicalDate(new Date('2026-08-30T19:00:00Z'), TZ, 4)).toBe('2026-08-31');
  });

  it('切り替え時刻の直前は前日のまま', () => {
    // 2026-08-31 03:59 JST
    expect(logicalDate(new Date('2026-08-30T18:59:00Z'), TZ, 4)).toBe('2026-08-30');
  });

  it('day_start_hour=0 なら暦日と一致する', () => {
    expect(logicalDate(new Date('2026-08-30T15:30:00Z'), TZ, 0)).toBe('2026-08-31');
  });
});

describe('wallClock', () => {
  it('JSTの壁時計を返す', () => {
    expect(wallClock(new Date('2026-08-30T12:04:00Z'), TZ)).toEqual({
      ymd: '2026-08-30',
      hour: 21,
      minute: 4,
    });
  });

  it('真夜中は 24時ではなく 0時', () => {
    // 2026-08-31 00:00 JST
    expect(wallClock(new Date('2026-08-30T15:00:00Z'), TZ).hour).toBe(0);
  });
});

describe('hmToMinutes', () => {
  it('HH:MM を分数に', () => {
    expect(hmToMinutes('21:00')).toBe(1260);
    expect(hmToMinutes('9:05')).toBe(545);
  });

  it('不正な値は null', () => {
    expect(hmToMinutes('25:00')).toBeNull();
    expect(hmToMinutes('21:70')).toBeNull();
    expect(hmToMinutes('あさ')).toBeNull();
  });

  it('往復する', () => {
    expect(minutesToHm(hmToMinutes('09:05')!)).toBe('09:05');
  });
});

describe('offsetFrom', () => {
  it('リマインドからの経過時間で時刻を出す', () => {
    expect(minutesToHm(offsetFrom(hmToMinutes('21:00')!, 120))).toBe('23:00');
  });

  it('日をまたいでも折り返して出す（これが直前の不具合の原因だった）', () => {
    // 22:00 + 2時間 = 24:00。以前は1日の範囲を超えて永久に飛ばなかった
    expect(minutesToHm(offsetFrom(hmToMinutes('22:00')!, 120))).toBe('00:00');
    expect(minutesToHm(offsetFrom(hmToMinutes('23:00')!, 240))).toBe('03:00');
  });
});

describe('isQuietHour', () => {
  it('1時から切り替わり時刻までは深夜帯', () => {
    expect(isQuietHour(hmToMinutes('01:00')!, 4)).toBe(true);
    expect(isQuietHour(hmToMinutes('03:59')!, 4)).toBe(true);
  });

  it('0時台はまだ起きている前提で送る', () => {
    // リマインド22:00 + 2時間 = 0:00。ここを落とすと元の不具合が残る
    expect(isQuietHour(hmToMinutes('00:00')!, 4)).toBe(false);
    expect(isQuietHour(hmToMinutes('00:30')!, 4)).toBe(false);
  });

  it('切り替わり以降は通常時間', () => {
    expect(isQuietHour(hmToMinutes('04:00')!, 4)).toBe(false);
    expect(isQuietHour(hmToMinutes('23:30')!, 4)).toBe(false);
  });
});
