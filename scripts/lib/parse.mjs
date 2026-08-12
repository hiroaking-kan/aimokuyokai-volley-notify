import * as cheerio from 'cheerio';

const squish = (s) => s.replace(/\s+/g, ' ').trim();

// 一覧ページから、リンク文言が条件に合う最初のリンクを絶対URLで返す。
// textPatterns は「すべて」満たす必要がある (例: 月 と 施設名の両方)。
export function findLink(html, { baseUrl, hrefContains, textPatterns = [] }) {
  const $ = cheerio.load(html);
  const selector = hrefContains ? `a[href*="${hrefContains}"]` : 'a[href]';
  let found = null;

  $(selector).each((_, el) => {
    if (found) return;
    const text = squish($(el).text());
    if (!textPatterns.every((p) => p.test(text))) return;
    const href = $(el).attr('href');
    if (!href) return;
    found = { url: new URL(href, baseUrl).toString(), text };
  });

  return found;
}

// 「販売期間」のようなラベルに対応する値を取り出す。
// dt/dd, th/td, ラベルと値が同じ要素に同居しているケースをまとめて面倒を見る。
export function extractLabeledValue(html, label) {
  const $ = cheerio.load(html);
  let value = null;

  $('dt, th, td, div, span, p, li').each((_, el) => {
    if (value) return;
    const $el = $(el);
    const text = squish($el.text());

    if (text === label) {
      // 隣の要素が値。dt→dd, th→td はこれで拾える。
      const candidate = squish($el.next().text());
      if (candidate) value = candidate;
      return;
    }

    // 「販売期間 2026年8月22日 10:00〜」のように1要素に同居しているケース。
    // 子要素を持つ入れ物まで拾うと後段の要素を巻き込むので、末端の要素だけ見る。
    if ($el.children().length === 0 && text.startsWith(label)) {
      const candidate = squish(text.slice(label.length).replace(/^[:：]/, ''));
      if (candidate) value = candidate;
    }
  });

  return value;
}

// 期間テキストの開始側 (〜より前) に時刻 (HH:MM) があるか。
// 「8月22日〜」だけの状態と「8月22日 10:00〜」を区別するために使う。
export function hasStartClockTime(periodText) {
  if (!periodText) return false;
  const [start] = periodText.split(/[〜~～]/);
  return /\d{1,2}:\d{2}/.test(start ?? '');
}
