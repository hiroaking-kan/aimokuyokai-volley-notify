import test from 'node:test';
import assert from 'node:assert/strict';

import { findLink, extractLabeledValue, hasStartClockTime } from './parse.mjs';

const BASE = 'https://www.asoview.com/channel/tickets/w1aENKVx1j/';

test('findLink: 条件に合うリンクを絶対URLで返す', () => {
  const html = `
    <a href="/channel/ticket/w1aENKVx1j/ticket54068">（2026年8月分）　【ナイトミュージアム】TUTANKHAMEN 展</a>
    <a href="/channel/ticket/w1aENKVx1j/ticket55123">（2026年9月分）　【ナイトミュージアム】TUTANKHAMEN 展</a>
    <a href="/channel/ticket/w1aENKVx1j/ticket11111">昼間通常入館券</a>`;

  const link = findLink(html, {
    baseUrl: BASE,
    hrefContains: '/channel/ticket/',
    textPatterns: [/9月分/, /ナイトミュージアム/],
  });

  assert.equal(link.url, 'https://www.asoview.com/channel/ticket/w1aENKVx1j/ticket55123');
});

test('findLink: 条件を満たすリンクが無ければ null', () => {
  const html = `<a href="/channel/ticket/x/ticket1">（2026年8月分）【ナイトミュージアム】</a>`;
  const link = findLink(html, {
    baseUrl: BASE,
    hrefContains: '/channel/ticket/',
    textPatterns: [/9月分/, /ナイトミュージアム/],
  });
  assert.equal(link, null);
});

test('findLink: パターンは AND (片方しか合わないものは拾わない)', () => {
  const html = `<a href="/channel/ticket/x/ticket1">（2026年9月分）　水族館ナイトツアー</a>`;
  const link = findLink(html, {
    baseUrl: BASE,
    hrefContains: '/channel/ticket/',
    textPatterns: [/9月分/, /ナイトミュージアム/],
  });
  assert.equal(link, null);
});

test('extractLabeledValue: dt/dd 形式', () => {
  const html = `<dl>
    <dt>対象年齢</dt><dd>指定無し</dd>
    <dt>販売期間</dt><dd>2026年8月22日 10:00〜2026年9月30日 19:00</dd>
  </dl>`;
  assert.equal(
    extractLabeledValue(html, '販売期間'),
    '2026年8月22日 10:00〜2026年9月30日 19:00'
  );
});

test('extractLabeledValue: table 形式', () => {
  const html = `<table><tr><th>販売期間</th><td>2026年8月22日 10:00〜2026年9月30日 19:00</td></tr></table>`;
  assert.equal(
    extractLabeledValue(html, '販売期間'),
    '2026年8月22日 10:00〜2026年9月30日 19:00'
  );
});

test('extractLabeledValue: ラベルと値が同じ要素にある形式', () => {
  const html = `<div><p>販売期間: 2026年8月22日 10:00〜2026年9月30日 19:00</p></div>`;
  assert.equal(
    extractLabeledValue(html, '販売期間'),
    '2026年8月22日 10:00〜2026年9月30日 19:00'
  );
});

test('extractLabeledValue: 改行や余白が入っていても潰して返す', () => {
  const html = `<dl><dt>  販売期間  </dt><dd>
      2026年8月22日 10:00
      〜2026年9月30日 19:00
  </dd></dl>`;
  assert.equal(
    extractLabeledValue(html, '販売期間'),
    '2026年8月22日 10:00 〜2026年9月30日 19:00'
  );
});

test('extractLabeledValue: ラベルが無ければ null', () => {
  const html = `<dl><dt>対象年齢</dt><dd>指定無し</dd></dl>`;
  assert.equal(extractLabeledValue(html, '販売期間'), null);
});

test('hasStartClockTime: 開始側に時刻が無ければ false', () => {
  assert.equal(hasStartClockTime('2026年8月22日〜2026年9月30日 19:00'), false);
});

test('hasStartClockTime: 開始側に時刻があれば true', () => {
  assert.equal(hasStartClockTime('2026年8月22日 10:00〜2026年9月30日 19:00'), true);
});

test('hasStartClockTime: 波ダッシュの表記ゆれを吸収する', () => {
  assert.equal(hasStartClockTime('2026年8月22日 10:00～2026年9月30日 19:00'), true);
  assert.equal(hasStartClockTime('2026年8月22日～2026年9月30日 19:00'), false);
});

test('hasStartClockTime: null / 空文字は false', () => {
  assert.equal(hasStartClockTime(null), false);
  assert.equal(hasStartClockTime(''), false);
});
