// 監視したいものはここに足す。1エントリ = 1つの監視対象。
//
// ⚠️ 追加する前に、対象サイトの利用規約と robots.txt を必ず確認すること。
//    自動アクセスが禁止されている場合、頻度を落としても規約違反は解消しないので、
//    そのサイトは監視しない。詳しくは ../CLAUDE.md を参照。
//
// 各ターゲットの形:
//   id               state ファイル上のキー。一度決めたら変えない (変えると再通知される)
//   label            通知やログに出る名前
//   enabled          false にすると監視しない (役目を終えたものは false にして残す)
//   terms            規約・robots.txt を確認した結果と確認日 (必須)
//   url              最初に開くページ
//   waitForSelector  (任意) この要素が出るまで待つ。SPAで中身が遅れて描画される場合に指定
//   inspect          現在の状態を調べる関数。詳しくは下の返り値の説明を参照
//
// inspect({ html, render, helpers }) は次を返す:
//   value   いま観測された値 (文字列)。前回と変わったかの判定に使う
//   ready   通知して良い状態か (例: 時刻がまだ未定なら false)
//   detail  (任意) 通知本文に添える補足
//   url     (任意) 通知本文に載せるリンク先
//
// render(url, opts) を呼べば別ページも取得できる (一覧 → 詳細ページと辿る場合に使う)。

export const targets = [
  // 役目を終えた監視の例として残してある。書き方の参考用。
  {
    id: 'night-museum-2026-09',
    label: 'ナイトミュージアム 9月分 販売開始時刻',
    enabled: false,
    // ⚠️ 未確認。この対象を再び有効化する前に asoview.com の規約と robots.txt を読むこと。
    //    (公式サイト tutankhamen.jp 側は自動アクセス禁止との情報あり。そちらは監視しない)
    terms: '未確認 — 有効化前に要確認',
    url: 'https://www.asoview.com/channel/tickets/w1aENKVx1j/',
    waitForSelector: 'a[href*="/channel/ticket/"]',

    async inspect({ html, render, helpers }) {
      const { findLink, extractLabeledValue, hasStartClockTime } = helpers;

      // 月替わりで詳細ページのURLが変わるので、一覧から該当月のリンクを探す。
      const link = findLink(html, {
        baseUrl: 'https://www.asoview.com/channel/tickets/w1aENKVx1j/',
        hrefContains: '/channel/ticket/',
        textPatterns: [/9月分/, /ナイトミュージアム|NIGHT\s*MUSEUM|TUTANKHAMEN/i],
      });

      if (!link) {
        return { value: null, ready: false, detail: '9月分のチケットページがまだ一覧に無い' };
      }

      const detailHtml = await render(link.url);
      const period = extractLabeledValue(detailHtml, '販売期間');

      // 「8月22日〜」だけの間は待ち、「8月22日 10:00〜」になったら通知する。
      return {
        value: period,
        ready: hasStartClockTime(period),
        detail: period ? `販売期間: ${period}` : '販売期間の記載を取得できず',
        url: link.url,
      };
    },
  },
];
