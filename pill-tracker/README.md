# Pill Tracker

LINE公式アカウントに「飲んだ」「生理が来た」と送ると Google カレンダーに記録され、
消退出血の予測と飲み忘れの検知をしてくれる bot。

設計の背景と判断の理由は [../docs/pill-tracker-design.md](../docs/pill-tracker-design.md) に。

- **レジメン**: ドロエチ配合錠 24+4（実薬24錠 + プラセボ4錠 = 28日1シート）
- **実行環境**: Cloudflare Workers + D1（LINE受信・記録・予測・通知）
- **記録先**: Google カレンダー（書き込みは GAS に委譲。専用カレンダーを自動作成）

```
LINE ──▶ Cloudflare Workers ──▶ D1 (記録の正本)
          │  署名検証            │
          │  予測・通知          ▼
          └────────────▶ GAS ──▶ Google カレンダー
                    共有シークレット   (OAuth不要)
```

**なぜ2つに分けているか。** Workers から直接 Google カレンダーに書くには OAuth
クライアントの作成・同意画面の公開・refresh token の失効管理が要る（同意画面が
「テスト」状態だと refresh token が7日で切れる）。GAS はスクリプト所有者の権限で
動くのでそれが全部要らない。一方 GAS 単体だと `doPost` がリクエストヘッダを読めず
`x-line-signature` を検証できない。**受信は Workers、カレンダー書き込みは GAS**
と分けると、両方の弱点を踏まずに済む。

> ⚠️ 予測は過去の記録から算出した目安です。医学的な判断・避妊効果の確認には使えません。
> 飲み忘れたときの対応は bot からは案内しません（添付文書と主治医の指示に従ってください）。

## 使い方

| 送る言葉 | 動作 |
|---|---|
| `飲んだ` / `のんだ` / `💊` / `OK` | 今日の服薬を記録 |
| `昨日飲んだ` / `8/12 飲んだ` | 過去日を遡って記録 |
| `生理が来た` | 消退出血の開始を記録 |
| `生理終わった` | 継続中の記録を閉じる |
| `新しいシート` | **その日を1錠目にする**（シート起点の設定） |
| `予測` / `次いつ` | 次のプラセボ期間と出血予測 |
| `状況` | 今日の記録状況・連続日数・シート位置 |
| `取り消し` | 直近1件を取り消す |
| `リマインド 21:00` | 服薬リマインドの時刻を変更 |
| `同期` | カレンダーをDBから貼り直す（消してしまったときの復旧） |

通知に付くクイックリプライのボタンを押せば、タップ1回で記録できる。

## 通知

| 通知 | タイミング | 条件 |
|---|---|---|
| 服薬リマインド | 設定時刻（既定 21:00） | 今日の記録がない |
| 飲み忘れ検知 | リマインドの2時間後 | まだ記録がない |
| 飲み忘れ（最終） | 23:30 | まだ記録がない・**実薬日のみ** |
| プラセボ期間の予告 | シート Day 24 の 09:00 | — |
| 消退出血の事前通知 | 予測日の3日前 09:00 | — |
| 出血なしアラート | シート Day 1 の 09:00 | 2シート続けて記録なし |

追い打ちの回数を実薬日とプラセボ日で分けてある。プッシュは28日あたり約40通で、
LINE の無料枠（月200通）に収まる。

## セットアップ

### 1. LINE

このリポジトリの luma-watch / night-museum-watch が使っているチャネルとは
**別に新規作成する**。バレーの通知と服薬・生理の会話が同じトークに混ざらず、
無料枠（月200通）もチャネル単位なので互いに食い合わない。

1. [LINE Developers Console](https://developers.line.biz/console/) で Messaging API チャネルを作成
2. Bot を自分の LINE に友だち追加（これをしないと Push が届かない）
3. **Messaging API** タブで自動応答（Auto-reply messages）を Disable にする
4. 控えるもの:
   - **チャネルシークレット**（Basic settings）→ `LINE_CHANNEL_SECRET`
   - **チャネルアクセストークン(long-lived)**（Messaging API）→ `LINE_ACCESS_TOKEN`
   - **Your user ID**（Basic settings）→ `ALLOWED_LINE_USER_ID`

> userId はプロバイダー単位で共通なので、既存の bot と同じプロバイダー内に
> 作れば `LINE_USER_ID` と同じ値になる。

### 2. Google カレンダー（GAS 側）

Google Cloud プロジェクトも OAuth クライアントも**不要**。

1. <https://script.google.com/> で新規プロジェクトを作り、`gas/Code.gs` の中身を貼る
2. 左メニュー **サービス（＋）** から **Calendar API** を追加する
   （内部名は `Calendar`。これがないとイベントIDを指定できず、冪等な書き込みが崩れる）
3. **プロジェクトの設定 → スクリプト プロパティ** に `SHARED_SECRET` を追加。
   値は32文字以上のランダム文字列（Workers 側にも同じ値を入れる）

   ```bash
   openssl rand -hex 32   # これを SHARED_SECRET に使う
   ```
4. **デプロイ → 新しいデプロイ → 種類: ウェブアプリ**
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**
   - 発行された `/exec` URL を控える（これが `GAS_CALENDAR_URL`）
5. 初回デプロイ時にカレンダーへのアクセス許可を求められるので承認する

   ここで **「このアプリは Google で確認されていません」** という警告が出るが、
   これは想定どおりの挙動。Calendar が機微なスコープに分類されているため、
   審査を通していないスクリプトを認可すると必ず表示される。審査が必要になるのは
   他人に配布するアプリの場合で、ここでは自分のアカウントで自分のスクリプトを
   承認しているだけ（警告に出る developer のアドレスが自分自身になっているはず）。

   **詳細 → 〈プロジェクト名〉(安全ではないページ) に移動 → 許可** で進む。
   一度承認すれば、スコープを増やさない限り再表示されない。

   > これは Workers から直接 OAuth する構成で問題になる
   > 「同意画面がテスト状態だと refresh token が7日で失効する」とは別の話。
   > GAS は認可を内部で持つため、この構成で期限切れは起きない。

> ⚠️ **再デプロイのときは「デプロイを管理 → 既存のデプロイを編集」を使う。**
> 「新しいデプロイ」を作ると URL が変わり、Workers から届かなくなる。

> URL は「全員」に公開されるが、リクエストは共有シークレットの HMAC 署名と
> タイムスタンプで検証しており、署名のないリクエストは弾かれる。
> 専用カレンダー「ピル・生理記録」は初回の書き込み時に自動作成される。

#### 疎通確認

Cloudflare をさわる前に、GAS 側だけを単体で確認しておく。

```bash
cd pill-tracker
GAS_CALENDAR_URL='https://script.google.com/macros/s/AKfy.../exec' \
GAS_SHARED_SECRET='...' \
  npm run check-gas
```

カレンダーの作成 → 書き込み → 同じIDでの再書き込み（重複しないこと）→ 削除 →
署名なしリクエストの拒否、までを順に確認して、失敗したら原因の候補を出す。
ここが通れば、あとで LINE がつながらなくても原因は Cloudflare 側だと切り分けられる。

### 3. Cloudflare

```bash
cd pill-tracker
npm install

# D1 を作り、出力された database_id を wrangler.toml に書く
npx wrangler d1 create pill_tracker
npx wrangler d1 migrations apply pill_tracker --remote

# シークレット (リポジトリには置かない)
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_ACCESS_TOKEN
npx wrangler secret put ALLOWED_LINE_USER_ID
npx wrangler secret put GAS_CALENDAR_URL     # GAS の /exec URL
npx wrangler secret put GAS_SHARED_SECRET    # GAS と同じ値

npx wrangler deploy
```

デプロイで出た URL の `/webhook` を、LINE Developers Console の
**Webhook URL** に設定して「検証」を押す。

### 4. 使いはじめ

シートの1錠目を飲む日に、LINEで **「新しいシート」** と送る。
その日が Day 1 になり、先6か月ぶんのプラセボ期間と出血予測が
カレンダーに書き出される。

> シートの起点（=服薬中であること）は健康情報なので、リポジトリにも
> 設定ファイルにも書かない。LINE から送って D1 にだけ持たせる設計にしてある。

### 5. iPhone標準カレンダーで見る

iPhone の「設定 → カレンダー → アカウント」に Google アカウントを追加し、
「ピル・生理記録」の表示を ON にする。プッシュ同期なのでほぼリアルタイムで反映される。

## 開発

```bash
npm test          # ドメインロジックの単体テスト
npm run typecheck
npm run dev       # ローカル起動 (.dev.vars に環境変数を置く)
```

テストは「壊れても静かに間違え続ける」2箇所に集中させてある:
メッセージ解析（`src/domain/parse.ts`）と 24+4 の暦計算・予測
（`src/domain/sheet.ts`, `src/domain/predict.ts`）。

## 設計上のポイント

- **DBが正本、カレンダーは投影**。カレンダーを手で編集しても、DBから再同期すれば戻る
- **シート位置は暦日で計算する**（`sheet_anchor` からの mod 28）。服用実績の本数を
  数える実装だと、飲み忘れのたびに予測が1日ずつズレていく
- **学習するのは周期長ではなくラグ**。24+4 は周期が28日で確定しているので、
  「プラセボ開始 → 出血開始」の日数の中央値だけを学習する
- **出血が来ない月は欠測扱い**。「周期が延びた」とは解釈しない
- **カレンダーのイベントIDは日付から決まる**ので、何度書き込んでも重複しない
- **Webhookの署名を検証する**。GAS 単体だと `doPost` がヘッダを読めずこれができない。
  受信を Workers に置くことで担保している
- **カレンダー書き込みだけ GAS に委譲**。Google 側の OAuth 設定と
  refresh token の失効管理をまるごと回避している
