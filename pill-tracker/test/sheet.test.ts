import { describe, expect, it } from 'vitest';
import { addDays } from '../src/domain/dates.js';
import {
  ACTIVE_LEN,
  dayInSheet,
  isPlacebo,
  nextPlaceboStarts,
  placeboStartOfSheet,
  sheetIndexOf,
  SHEET_LEN,
} from '../src/domain/sheet.js';

const ANCHOR = '2026-08-30'; // 1錠目

describe('dayInSheet', () => {
  it('アンカー当日が1日目', () => {
    expect(dayInSheet(ANCHOR, ANCHOR)).toBe(1);
  });

  it('実薬は1〜24日目', () => {
    expect(dayInSheet(ANCHOR, addDays(ANCHOR, 23))).toBe(24);
    expect(isPlacebo(24)).toBe(false);
  });

  it('プラセボは25〜28日目', () => {
    expect(dayInSheet(ANCHOR, addDays(ANCHOR, 24))).toBe(25);
    expect(dayInSheet(ANCHOR, addDays(ANCHOR, 27))).toBe(28);
    expect(isPlacebo(25)).toBe(true);
    expect(isPlacebo(28)).toBe(true);
  });

  it('28日で次のシートに繰り上がる', () => {
    expect(dayInSheet(ANCHOR, addDays(ANCHOR, 28))).toBe(1);
    expect(dayInSheet(ANCHOR, addDays(ANCHOR, 56))).toBe(1);
  });

  it('アンカーより前の日付でも壊れない', () => {
    expect(dayInSheet(ANCHOR, addDays(ANCHOR, -1))).toBe(SHEET_LEN);
    expect(dayInSheet(ANCHOR, addDays(ANCHOR, -28))).toBe(1);
    expect(sheetIndexOf(ANCHOR, addDays(ANCHOR, -1))).toBe(-1);
  });

  it('飲み忘れても暦日で進むのでシート終了日が動かない', () => {
    // 服用実績の本数ではなく暦日で数えているので、
    // 記録が飛んでいる日があっても day_in_sheet は変わらない
    const day = dayInSheet(ANCHOR, addDays(ANCHOR, 10));
    expect(day).toBe(11);
  });
});

describe('placebo windows', () => {
  it('最初のプラセボ期間はアンカー+24日', () => {
    expect(placeboStartOfSheet(ANCHOR, 0)).toBe(addDays(ANCHOR, ACTIVE_LEN));
  });

  it('以降28日ごと', () => {
    expect(placeboStartOfSheet(ANCHOR, 1)).toBe(addDays(ANCHOR, ACTIVE_LEN + SHEET_LEN));
    expect(placeboStartOfSheet(ANCHOR, 2)).toBe(addDays(ANCHOR, ACTIVE_LEN + SHEET_LEN * 2));
  });

  it('nextPlaceboStarts は from 以降だけを返す', () => {
    const first = placeboStartOfSheet(ANCHOR, 0);
    expect(nextPlaceboStarts(ANCHOR, ANCHOR, 3)[0]).toBe(first);
    // プラセボ開始当日は「以降」に含む
    expect(nextPlaceboStarts(ANCHOR, first, 1)[0]).toBe(first);
    // 1日過ぎたら次のシートへ
    expect(nextPlaceboStarts(ANCHOR, addDays(first, 1), 1)[0]).toBe(placeboStartOfSheet(ANCHOR, 1));
  });

  it('先6か月ぶんを重複なく返す', () => {
    const starts = nextPlaceboStarts(ANCHOR, ANCHOR, 7);
    expect(starts).toHaveLength(7);
    expect(new Set(starts).size).toBe(7);
  });
});
