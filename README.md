# Luma Watch — AI木曜会 バレーしよう会 通知bot / 汎用ウォッチャー

[lu.ma/aimokuyokai](https://lu.ma/aimokuyokai) を15分ごとに監視し、
イベント名が `AI木曜会┃第○回バレーしよう会` にマッチする新規イベントを
検出したら **LINE と メール** で通知します。

このリポジトリにはもう1つ、**任意のWebページを見張って変化を通知する汎用の仕組み**が
入っています。監視したいものが増えたら [scripts/targets.mjs](scripts/targets.mjs) に
追記するだけで足せます。詳細は [汎用ウォッチャー](#汎用ウォッチャー) を参照してください。

## 仕組み

- GitHub Actions の cron (`*/15 * * * *`) で [scripts/check.mjs](scripts/check.mjs) を実行
- Luma の内部API (`api.lu.ma/calendar/get-items`) を叩いて将来イベント一覧を取得
- 正規表現 `AI木曜会┃第\d+回バレーしよう会` でフィルタ
- [state/known_events.json](state/known_events.json) と比較して新規イベントを抽出
- 新規があれば LINE Push と Gmail SMTP で通知
- state を更新してリポジトリに自動コミット

> 注: Luma の「内部API」を使用しているため、公式の有料 API key は不要です。
> ただし非公式エンドポイントのため、Luma 側の仕様変更で動かなくなる可能性があります。
> また、登録開始 = イベント公開タイミングがほぼ同時のため、
> 「新規イベント検出」を「募集開始」とみなしています。

## セットアップ

### 1. GitHubリポジトリを作成 & push

```bash
cd /Users/hiroaki_nakane_1103/fable-test
git init
git add .
git commit -m "init: luma watch"
# GitHubで新規リポジトリ作成後:
git remote add origin git@github.com:<your-user>/luma-watch.git
git branch -M main
git push -u origin main
```

### 2. シークレットを登録

GitHub リポジトリの `Settings → Secrets and variables → Actions → New repository secret` で以下を登録。

| Secret 名 | 用途 |
|---|---|
| `LINE_TOKEN` | LINE Messaging API の Channel access token (long-lived) |
| `LINE_USER_ID` | 通知を送る相手の userId (`U` で始まる文字列) |
| `GMAIL_USER` | 送信元 Gmail アドレス |
| `GMAIL_APP_PASS` | Gmail のアプリパスワード (16桁) |
| `NOTIFY_TO` | 通知の送信先メールアドレス |

#### LINE_TOKEN と LINE_USER_ID の取り方

1. [LINE Developers Console](https://developers.line.biz/console/) でログイン
2. Provider を作成 (任意の名前)
3. 「Create a Messaging API channel」でチャンネルを作成
4. **Basic settings** タブの **Your user ID** が `LINE_USER_ID` (自分宛に送る場合)
5. **Messaging API** タブで:
   - QRコードからBotを **自分のLINEに友だち追加** (これをやらないと Push が届かない)
   - **Channel access token (long-lived)** を発行 → `LINE_TOKEN`
6. **Messaging API** タブの下のほうの自動応答系をすべて Disable に:
   - Auto-reply messages: Disabled
   - Greeting messages: Disabled (好み)

> 💡 LINE Messaging API の Push 無料枠は月200通 (2026年時点)。
> このbotの送信頻度では問題ないはずですが、上限を超えると課金が発生します。

#### Gmail アプリパスワードの取り方

1. Google アカウントの 2段階認証を有効化
2. <https://myaccount.google.com/apppasswords> でアプリパスワードを生成
3. 16桁の文字列を `GMAIL_APP_PASS` として登録 (スペースは含めない)

### 3. 動作確認

GitHub の `Actions` タブで `Luma Watch` ワークフローを開いて
`Run workflow` ボタンで手動実行できます。

ログに `Found N future events; M match pattern.` と
`Done. New notifications: 0.` が出れば成功。
state ファイルには現在の第30回イベントが既に登録済みなので、初回は通知されません。
新しい「バレーしよう会」イベントが Luma に追加されたタイミングで通知が飛びます。

## ローカル実行

```bash
npm install
# 通知なしで動作だけ確認 (env vars 未設定でskipされる)
node scripts/check.mjs

# 通知付きでテストする場合は env vars を設定:
LINE_TOKEN=xxx LINE_USER_ID=Uxxx \
GMAIL_USER=you@gmail.com GMAIL_APP_PASS=xxxx \
NOTIFY_TO=you@gmail.com \
  node scripts/check.mjs
```

## カスタマイズ

- **監視パターンを変える**: [scripts/check.mjs](scripts/check.mjs) の `NAME_PATTERN` を編集
- **監視間隔を変える**: [.github/workflows/luma-watch.yml](.github/workflows/luma-watch.yml) の `cron` を編集
  - 例: `*/5 * * * *` で5分ごと (ただしGitHub Actions cronは遅延あり)
- **別のカレンダーを監視**: [scripts/check.mjs](scripts/check.mjs) の `CALENDAR_API_ID` と `CALENDAR_SLUG` を変更

## トラブルシューティング

- **LINE が届かない** → Botを自分のLINEに友だち追加したか確認
- **Gmail でAuth失敗** → アプリパスワードを再生成 (古いものは無効になる)
- **Luma API が 4xx/5xx** → Lumaの仕様変更の可能性。ブラウザのDevTools (Network) で `api.lu.ma/calendar/get-items` のリクエストを確認し、エンドポイントやパラメータを更新

## 汎用ウォッチャー

任意のWebページを見張って、狙った箇所が変化したら **LINE と メール** で通知する仕組み。
「チケットの販売開始時刻が公表されたら教えて」のような一度きりの監視を想定している。

### 構成

| ファイル | 役割 |
|---|---|
| [scripts/targets.mjs](scripts/targets.mjs) | **監視したいものを書く場所。普段いじるのはここだけ** |
| [scripts/watch.mjs](scripts/watch.mjs) | 実行本体。状態の比較・通知・終了判定 |
| [scripts/lib/render.mjs](scripts/lib/render.mjs) | ヘッドレスブラウザでページを開いてHTMLを返す |
| [scripts/lib/parse.mjs](scripts/lib/parse.mjs) | HTMLから目的の値を取り出す純粋関数群 |
| [scripts/lib/notify.mjs](scripts/lib/notify.mjs) | LINE Push / Gmail 送信 |
| [state/watch_state.json](state/watch_state.json) | 前回観測した値。通知済みかどうかもここで管理 |

### ブラウザで開いている理由

`fetch` で取得した生HTMLを解析する方式だと、**中身をJavaScriptで描画するサイト (SPA) では
何も取れない**。実際、以前 asoview を監視していたときに対象を検知できない事象があり、
これが原因の候補だった。そのため Playwright + Chromium で実際にページを開き、
**JS実行後のDOM**を読むようにしている。その分ブラウザの起動時間はかかるが、
1日1回の実行なので問題にならない。

### 監視対象の足しかた

> ⚠️ **足す前に、対象サイトの利用規約と `robots.txt` を必ず確認する。**
> 自動アクセスが禁止されているサイトは、頻度を落としても規約違反は解消しないので
> 監視対象にしない (公式のメール通知やRSSなど別の手段を使う)。
> 確認結果は各ターゲットの `terms` フィールドに残す。詳しくは [CLAUDE.md](CLAUDE.md) を参照。

[scripts/targets.mjs](scripts/targets.mjs) の配列に1つ足すだけ。
`inspect` が返す `value` が前回と変わり、かつ `ready` が `true` のときに通知される。

```js
{
  id: 'example',              // stateのキー。変えると再通知されるので固定する
  label: '例: チケット発売時刻',
  enabled: true,              // 役目を終えたら false にして残しておく
  terms: '2026-08-12 確認: 規約に自動アクセス禁止の記載なし / robots.txt も許可',
  url: 'https://example.com/list',
  waitForSelector: '.item',   // (任意) この要素が出るまで待つ

  async inspect({ html, render, helpers }) {
    const { findLink, extractLabeledValue, hasStartClockTime } = helpers;

    // 一覧から詳細ページを探して辿ることもできる
    const link = findLink(html, {
      baseUrl: 'https://example.com/list',
      hrefContains: '/detail/',
      textPatterns: [/9月分/, /キーワード/],   // すべて満たすリンクを探す
    });
    if (!link) return { value: null, ready: false, detail: 'まだ無い' };

    const detailHtml = await render(link.url);
    const period = extractLabeledValue(detailHtml, '販売期間');

    return {
      value: period,                       // 変化の比較に使う値
      ready: hasStartClockTime(period),    // 通知して良い状態か
      detail: `販売期間: ${period}`,        // 通知本文
      url: link.url,
    };
  },
}
```

対象が増えたときは、既存のものを消さずに `enabled: false` にして残しておくと
次回の書き方の参考になる (ナイトミュージアムの例がそれ)。

### 実行スケジュールと自動終了

[.github/workflows/watch.yml](.github/workflows/watch.yml) が
**1日1回だけ起動し、その中で15分間隔×22回 (約5.5時間) チェックして終わる**。
cronは `0 0 * * *` (UTC 0:00 = JST 9:00)。残りの18.5時間は何もしない。
時刻や頻度を変えたい場合はワークフローの `cron` を編集する。

有効な監視対象がすべて通知済みになると (あるいは `enabled: true` が1つも無いと)、
`scripts/watch.mjs` は終了コード `20` で終わり、ワークフローが:

1. 15分間隔のループを止める
2. `gh workflow disable watch.yml` で自分自身を無効化する (以降のcron起動も止まる)

という形で自動的に監視を畳む。**新しい監視対象を足したあとは、Actionsタブから
`Watch` ワークフローを Enable し直す**必要がある点に注意。

### ローカルでの実行・テスト

```bash
npm install
npx playwright install chromium   # 初回のみ

# パース処理のテスト (ネットワーク不要)
npm test

# 通知なしで動作確認 (env vars 未設定ならLINE/メールはskipされる)
npm run watch
```

### トラブルシューティング

- **`有効な監視対象がありません`** → `scripts/targets.mjs` の `enabled` が全部 `false`
- **値が `null` のまま通知されない** → セレクタやラベル名がページの実物と違う可能性。
  `waitForSelector` を指定して描画待ちを確実にするか、`scripts/lib/parse.mjs` の
  抽出ロジックを実際のHTMLに合わせて調整する
- **`⚠️ Watch 失敗` が届く** → ページ取得に3回リトライしても失敗した状態。
  一過性のネットワークエラーなら次回の実行で復帰する
