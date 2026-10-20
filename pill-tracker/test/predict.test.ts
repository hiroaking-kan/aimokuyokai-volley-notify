import { describe, expect, it } from 'vitest';
import { addDays } from '../src/domain/dates.js';
import {
  attributedPlaceboStart,
  overlappingPeriodStart,
  bleedDuration,
  observedDurations,
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

describe('実測済みの周期は予測しない', () => {
  it('記録した日と同じ周期の予測は紐づけ先が一致する', () => {
    // 10/15 に実際に来た。予測も同じプラセボ期間を指すので、
    // そのまま出すと実際の記録と重なり、二重に来たように見える
    const bleed = P0;
    expect(attributedPlaceboStart(ANCHOR, bleed)).toBe(P0);

    const preds = predictBleeds(ANCHOR, [bleed], bleed, 7);
    expect(preds[0]!.placeboStart).toBe(P0);

    // カレンダー側はこの集合で除外する
    const recorded = new Set([attributedPlaceboStart(ANCHOR, bleed)]);
    const shown = preds.filter((p) => !recorded.has(p.placeboStart));
    expect(shown[0]!.placeboStart).toBe(placeboStartOfSheet(ANCHOR, 1));
  });

  it('記録していない周期の予測は残る', () => {
    const preds = predictBleeds(ANCHOR, [], ANCHOR, 7);
    const recorded = new Set<string>();
    expect(preds.filter((p) => !recorded.has(p.placeboStart))).toHaveLength(7);
  });
});

describe('overlappingPeriodStart', () => {
  it('近い日付の記録があれば同じ出血とみなす', () => {
    expect(overlappingPeriodStart(['2026-10-15'], '2026-10-18', 3)).toBe('2026-10-15');
  });

  it('遡って記録しても重複させない（順序に依存しない）', () => {
    // 18日を記録したあとに15日を記録する場合。差は -3 だが同じ出血
    expect(overlappingPeriodStart(['2026-10-18'], '2026-10-15', 3)).toBe('2026-10-18');
  });

  it('離れていれば別の周期として扱う', () => {
    expect(overlappingPeriodStart(['2026-10-15'], '2026-10-19', 3)).toBeNull();
    expect(overlappingPeriodStart(['2026-10-15'], '2026-11-12', 3)).toBeNull();
  });

  it('記録がなければ null', () => {
    expect(overlappingPeriodStart([], '2026-10-15', 3)).toBeNull();
  });
});

describe('bleedDuration', () => {
  const period = (start: string, end: string | null) => ({ start_date: start, end_date: end });

  it('記録が無ければ既定の4日（3〜5日の中央）', () => {
    expect(bleedDuration([])).toEqual({ days: 4, observed: false });
  });

  it('終了が記録されていない周期は数えない', () => {
    expect(bleedDuration([period('2026-09-25', null)])).toEqual({ days: 4, observed: false });
  });

  it('開始日と終了日の両端を含めて数える', () => {
    // 9/25 から 9/28 なら4日間
    expect(observedDurations([period('2026-09-25', '2026-09-28')])).toEqual([4]);
  });

  it('実測があれば中央値を使う', () => {
    const ps = [
      period('2026-09-25', '2026-09-27'),
      period('2026-10-23', '2026-10-27'),
      period('2026-11-20', '2026-11-24'),
    ];
    expect(bleedDuration(ps)).toEqual({ days: 5, observed: true });
  });

  it('極端な値は数え間違いとみなして混ぜない', () => {
    const ps = [
      period('2026-09-25', '2026-09-25'), // 1日 → 範囲外
      period('2026-10-23', '2026-11-20'), // 29日 → 範囲外
      period('2026-11-20', '2026-11-23'), // 4日
    ];
    expect(observedDurations(ps)).toEqual([4]);
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
