# Pill Tracker

LINE公式アカウントに「飲んだ」「生理が来た」と送ると Google カレンダーに記録され、
消退出血の予測と飲み忘れの検知をしてくれる bot。

設計の背景と判断の理由は [../docs/pill-tracker-design.md](../docs/pill-tracker-design.md) に。

- **レジメン**: ドロエチ配合錠 24+4（実薬24錠 + プラセボ4錠 = 28日1シート）
- **実行環境**: Cloudflare Workers + D1
- **記録先**: Google カレンダー（専用カレンダー「ピル・生理記録」を自動作成）

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

1. [LINE Developers Console](https://developers.line.biz/console/) で Messaging API チャネルを作成
2. Bot を自分の LINE に友だち追加（これをしないと Push が届かない）
3. **Messaging API** タブで自動応答をすべて Disable にする
4. 控えるもの: チャネルシークレット / チャネルアクセストークン(long-lived) / 自分の userId

### 2. Google カレンダー

1. Google Cloud で OAuth クライアント（デスクトップアプリ）を作成
2. スコープ `https://www.googleapis.com/auth/calendar` で一度だけ認可を通し、
   **refresh token** を取得する
3. 専用カレンダー「ピル・生理記録」は初回の書き込み時に自動作成される

> サービスアカウント方式ではなく refresh token 方式を使っている。Workers 上で
> RS256 署名が不要になり、カレンダーの所有者が自分のアカウントのままになるため。

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
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN

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
- **Webhookの署名を検証する**。GAS の `doPost` ではヘッダが読めずこれができない
