import { describe, expect, it } from 'vitest';
import { addDays } from '../src/domain/dates.js';
import {
  attributedPlaceboStart,
  estimateAnchorFromBleed,
  lagForBleed,
  lagStats,
  missedBleedSheets,
  observedLags,
  predictBleeds,
} from '../src/domain/predict.js';
import { placeboStartOfSheet } from '../src/domain/sheet.js';

const ANCHOR = '2026-08-30';
const P0 = placeboStartOfSheet(ANCHOR, 0); // 2026-09-23
const P1 = placeboStartOfSheet(ANCHOR, 1);

describe('lagForBleed', () => {
  it('プラセボ期間中の出血は自分のシートから数える', () => {
    expect(lagForBleed(ANCHOR, P0)).toBe(0);
    expect(lagForBleed(ANCHOR, addDays(P0, 2))).toBe(2);
    expect(lagForBleed(ANCHOR, addDays(P0, 3))).toBe(3);
  });

  it('次シートに食い込んだ出血は前シートのプラセボから数える', () => {
    // 次シートの Day 1 は前シートのプラセボ開始から4日目
    expect(lagForBleed(ANCHOR, addDays(ANCHOR, 28))).toBe(4);
    expect(lagForBleed(ANCHOR, addDays(ANCHOR, 30))).toBe(6);
  });

  it('プラセボより少し早い出血も拾う', () => {
    expect(lagForBleed(ANCHOR, addDays(P0, -1))).toBe(-1);
    expect(lagForBleed(ANCHOR, addDays(P0, -2))).toBe(-2);
  });

  it('範囲外は紐づけない', () => {
    expect(lagForBleed(ANCHOR, addDays(P0, -3))).toBeNull();
    expect(lagForBleed(ANCHOR, addDays(P0, 7))).toBeNull();
    expect(lagForBleed(ANCHOR, addDays(ANCHOR, 12))).toBeNull();
  });

  it('紐づけ先のプラセボ期間はラグを引き戻せば出る', () => {
    expect(attributedPlaceboStart(ANCHOR, addDays(P0, 2))).toBe(P0);
    expect(attributedPlaceboStart(ANCHOR, addDays(ANCHOR, 28))).toBe(P0);
  });
});

describe('lagStats', () => {
  it('記録がなければ既定値2日・信頼度low', () => {
    expect(lagStats([])).toEqual({ lag: 2, band: 2, confidence: 'low' });
  });

  it('2件までは medium で幅を広めに取る', () => {
    expect(lagStats([2, 3])).toMatchObject({ lag: 3, band: 2, confidence: 'medium' });
  });

  it('3件以上で high になり、幅は MAD から出す', () => {
    const s = lagStats([2, 2, 2]);
    expect(s.confidence).toBe('high');
    expect(s.lag).toBe(2);
    expect(s.band).toBe(1); // MAD=0 でも最低1日は残す
  });

  it('外れた1件に引きずられない', () => {
    // 平均なら 2.75 に寄るが、中央値なので 2 のまま
    expect(lagStats([2, 2, 2, 5]).lag).toBe(2);
  });
});

describe('predictBleeds', () => {
  it('記録ゼロでも既定ラグで予測を出す', () => {
    const [first] = predictBleeds(ANCHOR, [], ANCHOR, 1);
    expect(first!.placeboStart).toBe(P0);
    expect(first!.date).toBe(addDays(P0, 2));
    expect(first!.confidence).toBe('low');
  });

  it('実測ラグを学習して予測日が動く', () => {
    const starts = [addDays(P0, 3)];
    const [next] = predictBleeds(ANCHOR, starts, addDays(P0, 4), 1);
    expect(next!.placeboStart).toBe(P1);
    expect(next!.date).toBe(addDays(P1, 3));
  });

  it('先6か月ぶんをまとめて返す', () => {
    const list = predictBleeds(ANCHOR, [], ANCHOR, 7);
    expect(list).toHaveLength(7);
    expect(new Set(list.map((p) => p.date)).size).toBe(7);
  });

  it('出血が来なかったシートは欠測として扱い、周期が延びたとは解釈しない', () => {
    // P0 は出血なし、P1 でラグ2日の出血
    const starts = [addDays(P1, 2)];
    const [next] = predictBleeds(ANCHOR, starts, addDays(P1, 3), 1);
    // 次はあくまで P2 のプラセボ基準。周期が延びたことにはならない
    expect(next!.placeboStart).toBe(placeboStartOfSheet(ANCHOR, 2));
    expect(next!.date).toBe(addDays(placeboStartOfSheet(ANCHOR, 2), 2));
  });
});

describe('missedBleedSheets', () => {
  it('終わったプラセボ期間に出血があれば0', () => {
    const today = addDays(ANCHOR, 28); // P0 は終了済み
    expect(missedBleedSheets(ANCHOR, [addDays(P0, 2)], today)).toBe(0);
  });

  it('1シート分だけ抜けていれば1', () => {
    const today = addDays(ANCHOR, 28);
    expect(missedBleedSheets(ANCHOR, [], today)).toBe(1);
  });

  it('2シート続けて抜けていれば2', () => {
    const today = addDays(ANCHOR, 56);
    expect(missedBleedSheets(ANCHOR, [], today)).toBe(2);
  });

  it('プラセボ期間がまだ終わっていなければ数えない', () => {
    expect(missedBleedSheets(ANCHOR, [], addDays(ANCHOR, 10))).toBe(0);
  });
});

describe('estimateAnchorFromBleed', () => {
  it('プラセボ2日目に出血が始まったと仮定して逆算する', () => {
    expect(estimateAnchorFromBleed(addDays(ANCHOR, 26))).toBe(ANCHOR);
  });
});
