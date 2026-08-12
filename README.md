# Luma Watch — AI木曜会 バレーしよう会 通知bot / Night Museum Watch

[lu.ma/aimokuyokai](https://lu.ma/aimokuyokai) を15分ごとに監視し、
イベント名が `AI木曜会┃第○回バレーしよう会` にマッチする新規イベントを
検出したら **LINE と メール** で通知します。

このリポジトリではもう1つ、横浜「ナイトミュージアム (MYSTERY OF TUTANKHAMEN)」の
月替わりチケットの販売開始**時刻**が公表されたタイミングを検知して通知するbotも
動いています。詳細は [Night Museum Watch](#night-museum-watch) を参照してください。

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

## Night Museum Watch

横浜のナイトミュージアム「MYSTERY OF TUTANKHAMEN」は asoview 上で月替わりのチケット
詳細ページ (`https://www.asoview.com/channel/ticket/w1aENKVx1j/ticketXXXXXXXXXX`) が
毎月作られる形式で、URL は月ごとに変わる。[scripts/check-night-museum.mjs](scripts/check-night-museum.mjs) は:

1. チャンネルの一覧ページ [`/channel/tickets/w1aENKVx1j/`](https://www.asoview.com/channel/tickets/w1aENKVx1j/) から
   「9月分」かつ「ナイトミュージアム」を含むリンクを探す
2. 見つかった詳細ページの「販売期間」欄を取得する
3. 期間の開始側 (`〜` より前) に `HH:MM` の時刻が含まれていれば
   「販売開始時刻が公表された」と判定し、**LINE と メール** で通知する
4. 一度通知した内容は [state/night_museum_state.json](state/night_museum_state.json) に保存し、再通知しない

[.github/workflows/night-museum-watch.yml](.github/workflows/night-museum-watch.yml) が
これを実行する (LINE/Gmailのsecretsは共通で流用)。luma-watch (24時間365日、常時ループし続ける)
とはスケジュールの考え方が異なり、こちらは**1日1回だけ起動し、その中で15分間隔×22回
(約5.5時間) チェックしたら終わる**。cronは `0 0 * * *` (UTC 0:00 = JST 9:00) に設定してあり、
毎日その時刻から5.5時間だけ監視する (その日の残り18.5時間は何もしない)。時刻を変えたい場合は
ワークフローファイルの `cron` を編集する。

luma-watch と違い、こちらは**9月分の販売開始時刻の通知が届いたら役目は終わり**なので、
`scripts/check-night-museum.mjs` が通知を送った回はプロセスを終了コード `20` で終わらせ、
ワークフロー側がそれを検知して:

1. ループ (15分間隔のポーリング) を止める
2. `gh workflow disable night-museum-watch.yml` で自分自身を無効化する (以降のcron起動も止まる)

…という形で自動的に監視を終了する。もし自動無効化に失敗した場合は
`Settings → Actions → night-museum-watch.yml` から手動で Disable workflow するか、
`.github/workflows/night-museum-watch.yml` を削除する。

> 注: asoview のページ構造の想定 (`販売期間` ラベルの直後の要素に期間テキストが入っている、
> 一覧ページのリンクに月とキーワードが含まれている) を元にスクレイピングしている。
> 実際のマークアップが想定と異なる場合は動かないことがあるため、初回は
> `Actions → Night Museum Watch → Run workflow` で手動実行しログを確認することを推奨。
> `9月分のチケットページはまだ一覧に見つかりません。` と出る場合はページ未公開、
> `開始時刻はまだ未公表のようです。` と出る場合はページはあるが時刻欄が未確定という状態。
