# ピル・生理記録bot 設計書

LINE公式アカウントに「飲んだ」「生理が来た」と送るだけで、服薬と生理がカレンダーに
記録され、周期から次の生理日を予測して事前に通知してくれる仕組みの設計。

- **記録先カレンダー**: Google カレンダー / iPhone標準カレンダー（両対応の設計を後述）
- **実行環境**: Cloudflare Workers 案 と Google Apps Script 案 の2案を併記
- **通知**: 毎日の服薬リマインド / 飲み忘れ検知 / 生理予測日の事前通知

> ⚠️ 免責: 本システムの予測は過去の記録から統計的に算出した目安であり、
> 医学的な判断・避妊効果の判定・妊娠可能性の判断には使用できない。

---

## 1. 全体像

```
 [あなた] ──「飲んだ」──▶ LINE公式アカウント
                              │ Webhook (HTTPS POST + 署名)
                              ▼
                    ┌───────────────────────┐
                    │  App (Webhook + Cron)  │
                    │  ・メッセージ解析       │
                    │  ・記録 / 予測計算      │
                    │  ・返信 / プッシュ通知  │
                    └───────┬───────┬───────┘
                            │       │
              (source of truth)     │ 投影 (projection)
                            ▼       ▼
                      ┌─────────┐  ┌──────────────────┐
                      │   DB    │  │ CalendarSink      │
                      │ 記録の  │  │ ├ Google Calendar │
                      │ 正本    │  │ └ ICS Feed (iOS)  │
                      └─────────┘  └──────────────────┘
```

### 設計上いちばん重要な判断: 「DBが正本、カレンダーは投影」

「カレンダーに記録される」が要件だが、**カレンダーをデータの保管場所にはしない**。

理由:
- 周期予測には過去の生理開始日を安定して読み出す必要がある。カレンダーAPIから
  イベント一覧を引いてタイトル文字列で判別する方式は、手動でイベントを編集・削除された
  瞬間に壊れる。
- 予測イベントは記録が増えるたびに書き換え・削除が必要で、「どれが自分の書いた予測か」を
  自前で追跡できないと事故る。
- 「飲み忘れ検知」は「今日まだ記録がない」という否定形のクエリで、DBなら1行のSQL。

そこで **DB に真実を持ち、カレンダーへは冪等に書き出す(projection)** 構成にする。
カレンダー側を手で消しても、DBから再同期すれば復元できる。

---

## 2. データモデル

```sql
-- 利用者設定（当面は1人だが最初からuser_idで持つ）
CREATE TABLE users (
  line_user_id     TEXT PRIMARY KEY,          -- U から始まるID
  timezone         TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  day_start_hour   INTEGER NOT NULL DEFAULT 4, -- 論理日の切り替わり時刻(後述)
  regimen          TEXT NOT NULL DEFAULT 'none', -- none | 21+7 | 24+4 | continuous
  reminder_time    TEXT,                      -- 'HH:MM' 服薬リマインド時刻。NULLで無効
  nudge_after_min  INTEGER DEFAULT 120,       -- 飲み忘れ再通知までの分数
  period_notice_days INTEGER DEFAULT 3,       -- 生理予測の何日前に通知するか
  google_calendar_id TEXT,
  ics_token        TEXT,                      -- ICS購読URL用のランダムトークン
  created_at       TEXT NOT NULL
);

-- 服薬記録（論理日ごとに1件）
CREATE TABLE doses (
  id            TEXT PRIMARY KEY,             -- 'dose-{user}-{local_date}'
  user_id       TEXT NOT NULL,
  local_date    TEXT NOT NULL,                -- 'YYYY-MM-DD' (論理日)
  taken_at      TEXT NOT NULL,                -- ISO8601 UTC 実際の記録時刻
  source        TEXT NOT NULL,                -- text | quick_reply | backfill
  calendar_event_id TEXT,
  UNIQUE (user_id, local_date)                -- 1日1回。二重送信は自然に弾かれる
);

-- 生理記録
CREATE TABLE periods (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  start_date    TEXT NOT NULL,                -- 'YYYY-MM-DD'
  end_date      TEXT,                         -- 「終わった」で埋まる。NULLなら継続中
  calendar_event_id TEXT,
  UNIQUE (user_id, start_date)
);

-- カレンダーに書いた予測イベント（差し替え・削除のために追跡する）
CREATE TABLE predictions (
  user_id       TEXT NOT NULL,
  predicted_date TEXT NOT NULL,
  low_date      TEXT NOT NULL,                -- 予測レンジ下限
  high_date     TEXT NOT NULL,                -- 予測レンジ上限
  confidence    TEXT NOT NULL,                -- high | medium | low
  calendar_event_id TEXT,
  computed_at   TEXT NOT NULL,
  PRIMARY KEY (user_id)                       -- 常に「次の1件」だけ保持
);

-- Webhook冪等性（LINEは再送してくる）
CREATE TABLE processed_events (
  webhook_event_id TEXT PRIMARY KEY,
  processed_at     TEXT NOT NULL
);

-- 送信済み通知（同じリマインドを二度打たない）
CREATE TABLE sent_notifications (
  user_id   TEXT NOT NULL,
  kind      TEXT NOT NULL,   -- reminder | nudge1 | nudge2 | period_notice | no_period_alert
  local_date TEXT NOT NULL,
  sent_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, local_date)
);
```

### 論理日 (day_start_hour) について

深夜0:30に「飲んだ」と送った場合、体感は「昨日の分」である。
`day_start_hour = 4` とし、**04:00 未満の記録は前日の日付に寄せる**。
これがないと「連続日数」の計算と飲み忘れ検知が実態とズレる。

```
localDate(now) = (JSTのnow から day_start_hour 時間引いた日付)
```

---

## 3. LINEメッセージの解釈

### 3.1 入力チャネル（3経路すべてサポート）

| 経路 | 用途 | 実装 |
|---|---|---|
| 自由テキスト | 要件そのもの。「飲んだ」等 | `message.text` を正規化してパターンマッチ |
| クイックリプライ | リマインド通知への即返信 | `postback` で `action=dose&date=...` |
| リッチメニュー | 常時表示のボタン | `postback` |

**postback を第一級で扱うのが重要**。リマインド通知に [飲んだ] ボタンを付けておけば、
日常の記録はタップ1回で終わり、日付の曖昧さも起きない。テキストはその上位互換として残す。

### 3.2 テキスト解析

正規化: NFKC → 前後空白除去 → 絵文字除去 → 小文字化。

| 意図 | パターン例 |
|---|---|
| `DOSE` | `飲んだ` `のんだ` `飲みました` `ピル` `服用` `💊` `ok` `👌` |
| `DOSE` (日付指定) | `昨日飲んだ` `一昨日飲んだ` `8/12 飲んだ` `12日に飲んだ` |
| `PERIOD_START` | `生理が来た` `生理きた` `生理` `きた` `来た` |
| `PERIOD_END` | `生理終わった` `終わった` `おわり` |
| `PREDICT` | `予測` `次いつ` `いつ` |
| `STATUS` | `状況` `履歴` `今月` |
| `UNDO` | `取り消し` `取消` `間違えた` `やっぱ違う` |
| `SETTINGS` | `設定` `リマインド 21:00` |
| `HELP` | `ヘルプ` `help` `使い方` |

パーサは **意図(intent) + 対象日(date) + 信頼度** を返す純粋関数にして、
単体テストを厚くする。ここが唯一「壊れると静かに間違える」箇所。

```ts
type ParseResult =
  | { intent: 'DOSE' | 'PERIOD_START' | 'PERIOD_END'; date: string; confident: boolean }
  | { intent: 'PREDICT' | 'STATUS' | 'UNDO' | 'HELP' | 'SETTINGS'; ... }
  | { intent: 'UNKNOWN'; raw: string };
```

### 3.3 曖昧・衝突時の挙動

- **判定不能** → 勝手に推測せず、確認のクイックリプライを返す
  （「どれを記録する？ [💊飲んだ] [🩸生理きた] [なんでもない]」）。
  記録漏れより誤記録のほうが害が大きい（周期予測が汚染される）。
- **同じ日に2回「飲んだ」** → UNIQUE制約で弾き、「今日はすでに記録済みです（8/30 21:04）」と返す。
- **生理開始を連続で送った** → 前回開始から3日以内なら「継続中」とみなし新規作成しない。
  3日超なら新しい周期として扱い、直前の周期を自動で閉じる。
- **UNDO** → 直近1件の記録をDBとカレンダーの両方から削除して確認を返す。

### 3.4 返信の例

```
💊 8/30(土) 記録しました
   今シート 9日目 / 21日連続で服用中

🩸 8/28(木) 生理開始を記録しました
   前回から 29日周期（平均 28.6日）
   次回予測: 9/26(金) ごろ ± 2日
```

---

## 4. 周期予測アルゴリズム

「学習」といってもML不要。**説明可能で、記録が少なくても破綻しない**ことを優先する。

### 4.1 基本（自然周期の場合）

1. 生理開始日の列 `d1 … dn` から周期長 `ci = d(i+1) - d(i)` を作る
2. 外れ値除去: `15 <= ci <= 60` の範囲外は破棄（記録ミス・不正データ対策）
3. 直近最大6件に **指数減衰の重み** `w = 0.8^(距離)` をかけた加重平均 `L` を出す
   （＝EWMA。最近の周期の変化に追従しつつ、1回のブレで暴れない）
4. `次回予測日 = 最終開始日 + round(L)`
5. ばらつきは **MAD（中央絶対偏差）** で表現し、`± max(1, round(MAD))` を予測レンジとする

```ts
function predictNext(starts: string[], regimen: Regimen): Prediction | null {
  if (starts.length === 0) return null;
  const last = starts.at(-1)!;

  if (regimen !== 'none') return predictFromRegimen(last, starts, regimen); // 4.2

  const cycles = diffDays(starts).filter(c => c >= 15 && c <= 60);
  if (cycles.length === 0) {
    return { date: addDays(last, 28), band: 4, confidence: 'low', basis: 'default28' };
  }
  const recent = cycles.slice(-6);
  const w = recent.map((_, i) => 0.8 ** (recent.length - 1 - i));
  const L = sum(recent.map((c, i) => c * w[i])) / sum(w);
  const mad = median(recent.map(c => Math.abs(c - L)));

  return {
    date: addDays(last, Math.round(L)),
    band: Math.max(1, Math.round(mad)),
    confidence: recent.length >= 4 ? 'high' : recent.length >= 2 ? 'medium' : 'low',
    basis: 'ewma',
  };
}
```

### 4.2 ピル服用中の場合（重要）

低用量ピル服用中の出血は消退出血なので、**統計より服薬スケジュールのほうが強い予測子**になる。
`regimen = 21+7 / 24+4` なら:

```
次の休薬期間開始日 = 現在のシート開始日 + 実薬日数
予測出血日        = 休薬期間開始日 + lag
lag = 過去の「休薬開始 → 実際の生理開始」の日数の中央値（初期値2日）
```

シート開始日は、服薬記録の連続列が7日以上途切れた直後の再開日から復元する。
この方式は記録が2周期ぶんあれば ±1日程度の精度になる。

### 4.3 コールドスタートと異常検知

| 状態 | 挙動 |
|---|---|
| 生理記録 0件 | 予測しない。「あと1回記録すると予測を出せます」と案内 |
| 1件 | 28日（またはシート周期）を仮置きし「参考値」と明示 |
| 2件 | 実測1周期ぶん。confidence=medium、レンジ広め |
| 3件以上 | 通常予測 |
| 最終開始から45日超 | 「45日以上記録がありません」と1回だけ通知（記録漏れの可能性） |

予測は **新しい生理記録が入るたびに再計算** し、カレンダー上の予測イベントを差し替える。

---

## 5. カレンダー連携

`CalendarSink` インターフェースを切り、Google と ICS の2実装を差し替え可能にする。

```ts
interface CalendarSink {
  upsertDose(userId: string, date: string, takenAt: string): Promise<string>;
  upsertPeriod(userId: string, p: Period): Promise<string>;
  upsertPrediction(userId: string, p: Prediction | null): Promise<string | null>;
  remove(eventId: string): Promise<void>;
}
```

### 5.1 イベント設計

| 種別 | 表示 | 形式 | 色 |
|---|---|---|---|
| 服薬 | `💊 ピル` | 終日 | 淡い青 |
| 生理（継続中） | `🩸 生理` | 終日・開始日のみ | 赤 |
| 生理（終了済） | `🩸 生理` | 終日・開始〜終了の複数日 | 赤 |
| 予測 | `(予測) 🩸 生理開始 ±2日` | 終日 | グレー |

**終日イベントにする理由**: 時刻付きだとタイムゾーンのズレ事故が起き、
月表示で埋もれる。実際の記録時刻は description に書けば十分。

専用カレンダー「ピル・生理記録」を新規作成して、そこにだけ書く。
これでメインカレンダーを汚さず、表示のON/OFFも自由にできる。

### 5.2 Google カレンダー

**認証**: OAuth2 の refresh token 方式を推奨。
一度ローカルで認可フローを回して refresh token を取得し、シークレットに保存する。
サーバー側は `refresh_token → access_token` の交換だけで済み、Workers上でも
JWT署名が不要になる（サービスアカウント方式はRS256署名が要る＋カレンダーの
所有者がSAになり、個人アカウントからの見え方が面倒）。

**冪等性**: Google Calendar API はイベントIDをクライアント指定できる。

```
dose:      "dose" + YYYYMMDD           → 例 dose20260830
period:    "period" + 開始日 YYYYMMDD
prediction:"pred" + userハッシュ        （常に同じIDを上書き）
```

（ID は base32hex の文字集合 `a-v0-9` に収める必要がある点に注意）

これで **insert が409を返したら「すでに書けている」** と解釈でき、
リトライや二重実行が安全になる。加えて
`extendedProperties.private = { kind: 'dose', app: 'pilltracker' }` を付けて、
自分の書いたイベントだけを後から検索・掃除できるようにする。

### 5.3 iPhone標準カレンダー

iCloudカレンダーには公式の書き込みAPIがない。現実的な選択肢は3つ。

#### 案A: Googleカレンダーを iPhone に購読させる（推奨）

iPhoneの「設定 → カレンダー → アカウント」にGoogleアカウントを追加し、
「ピル・生理記録」カレンダーの表示をONにするだけ。
アプリ側の追加実装はゼロで、**同期はほぼリアルタイム**（プッシュ同期）。
iPhone標準カレンダーアプリ上に普通に表示され、書き込みもできる。
Googleアカウントを使うことに抵抗がなければ、これが最善。

#### 案B: 自前のICSフィードを配信して購読させる

アプリが `GET /calendar/{ics_token}.ics` で iCalendar を返し、
iPhoneの「照会するカレンダーを追加」で購読する。

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//pilltracker//JP
BEGIN:VEVENT
UID:dose-20260830@pilltracker
DTSTART;VALUE=DATE:20260830
DTEND;VALUE=DATE:20260831
SUMMARY:💊 ピル
END:VEVENT
...
END:VCALENDAR
```

- Google に依存しない / 実装は文字列生成だけで簡単 / 読み取り専用なので事故らない
- ただし **更新は即時ではない**。購読カレンダーの取得間隔は iOS 側の設定依存で、
  数十分〜数時間遅れることがある。「送ったのにカレンダーに出ない」と感じやすい。
- `ics_token` を推測不能なランダム値にすること（URLを知る＝全記録が読める）。

#### 案C: CalDAV で iCloud に直接書く

Appleアプリ用パスワードを使い `caldav.icloud.com` に PUT する。
技術的には可能だが公式サポート外で、Apple ID の資格情報をサーバーに置く必要があり、
仕様変更で壊れる。**個人の健康データを扱う以上、推奨しない。**

#### 結論

**案A を第一選択、案B を Google を使いたくない場合の代替**として両方実装しておく。
`CalendarSink` を分けてあるので、環境変数でどちらか／両方を有効化できる。
案B の ICS 生成は DB から全件を吐くだけなので、実装コストは小さく、バックアップも兼ねる。

---

## 6. 通知設計

### 6.1 3種類の通知

| 通知 | タイミング | 条件 | 文面 |
|---|---|---|---|
| 服薬リマインド | `reminder_time`（例 21:00） | 今日の服薬記録がない | 「💊 ピルの時間です」+ クイックリプライ [飲んだ][あとで] |
| 飲み忘れ検知 | リマインドの `nudge_after_min` 後（例 +2時間） | まだ記録がない | 「まだ記録がありません。飲んだ？」 |
| 〃 (最終) | 論理日の終わり手前（例 翌1:00） | まだ記録がない | 「今日は記録なしのままです」 |
| 生理予測の事前通知 | 予測日の `period_notice_days` 日前 09:00 | 予測があり未通知 | 「9/26ごろ 生理予測日です（±2日）」 |
| 長期未記録アラート | 毎日09:00 | 最終生理から45日超 | 「45日以上記録がありません」 |

`sent_notifications` テーブルで `(user, kind, local_date)` を一意にし、
cronが多重起動しても二重送信しない。

### 6.2 プッシュ通知の本数見積もり

LINE公式アカウントの無料枠は月200通（プッシュ配信のみカウント。返信メッセージは対象外）。

```
服薬リマインド        30通/月
飲み忘れ再通知        ~10通/月（飲み忘れた日だけ）
生理予測の事前通知     1-2通/月
------------------------------
合計                  ~42通/月   → 無料枠内に十分収まる
```

飲み忘れ検知を「毎日必ず2回追い打ち」にすると90通/月まで増えるので、
**記録済みならスキップする条件を必ず入れる**（設計上の必須事項）。

### 6.3 cron の粒度

5分間隔で起動し、毎回「各ユーザーのローカル時刻」を計算して、
その5分枠に該当する通知だけを送る。ユーザーごとに時刻設定を変えられて、
サマータイムやタイムゾーン変更にも自然に対応できる。

---

## 7. 実装案A: Cloudflare Workers + D1

### スタック

| 層 | 技術 |
|---|---|
| ランタイム | Cloudflare Workers (TypeScript) |
| ルーティング | Hono |
| DB | Cloudflare D1 (SQLite) |
| スケジューラ | Workers Cron Triggers (`*/5 * * * *`) |
| シークレット | Workers Secrets (`wrangler secret put`) |
| デプロイ | GitHub Actions → `wrangler deploy`（mainへのpushで自動） |
| テスト | Vitest + `@cloudflare/vitest-pool-workers`（ローカルD1で実行） |
| マイグレーション | `wrangler d1 migrations` |

### ディレクトリ構成（案）

```
pill-tracker/
├── src/
│   ├── index.ts              # Hono app: /webhook, /calendar/:token.ics, scheduled()
│   ├── line/
│   │   ├── verify.ts         # x-line-signature 検証
│   │   ├── client.ts         # reply / push / richmenu
│   │   └── messages.ts       # 返信テンプレート
│   ├── domain/
│   │   ├── parse.ts          # テキスト → intent（純粋関数・テスト厚め）
│   │   ├── predict.ts        # 周期予測（純粋関数・テスト厚め）
│   │   └── logicalDate.ts    # 論理日の計算
│   ├── store/                # D1 リポジトリ層
│   ├── calendar/
│   │   ├── sink.ts           # インターフェース
│   │   ├── google.ts
│   │   └── ics.ts
│   └── jobs/notify.ts        # cronから呼ばれる通知ロジック
├── migrations/
├── test/
└── wrangler.toml
```

### 署名検証（Workersなら正しくできる）

```ts
const body = await request.text();
const sig = request.headers.get('x-line-signature') ?? '';
const key = await crypto.subtle.importKey(
  'raw', enc.encode(env.LINE_CHANNEL_SECRET),
  { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
);
const ok = await crypto.subtle.verify('HMAC', key, base64ToBytes(sig), enc.encode(body));
if (!ok) return new Response('unauthorized', { status: 401 });
```

**これが案Aの最大の利点**。他人が勝手にあなたの記録を偽造できない。

### 注意点

- Webhookは **まず200を即返し**、重い処理（カレンダー書き込み）は
  `ctx.waitUntil()` に逃がす。LINEはWebhookの遅延に厳しい。
- 返信は `replyToken`（有効期間が短い）を使うので、返信だけは同期処理で先に行う。
- 無料枠（10万リクエスト/日、D1 5GB）に対して個人利用の負荷は誤差。

---

## 8. 実装案B: Google Apps Script + スプレッドシート

### スタック

| 層 | 技術 |
|---|---|
| ランタイム | Google Apps Script (`doPost` ウェブアプリ) |
| DB | Google スプレッドシート（doses / periods / settings シート） |
| カレンダー | `CalendarApp` — **認証設定が一切不要**（同一Googleアカウント） |
| スケジューラ | 時間主導型トリガー（5分おき） |
| ICS配信 | `doGet` + `ContentService`（MIME: ICAL） |
| バージョン管理 | clasp + GitHub Actions（`clasp push`） |

### 利点

- **Googleカレンダー連携が圧倒的に楽**。OAuthもrefresh tokenも要らず、
  `CalendarApp.getCalendarById(id).createAllDayEvent('💊 ピル', date)` の1行。
- サーバー費用ゼロ、インフラ管理ゼロ。
- スプレッドシートなので、記録を自分の目で見て手で直せる。バックアップも自動。

### 欠点（正直に）

1. **`doPost` はHTTPヘッダを読めない → `x-line-signature` を検証できない。**
   これは構造的な制約。緩和策:
   - `/exec` URLに含まれるデプロイIDは長いランダム文字列なので、URL自体を秘密として扱う
   - 受信イベントの `source.userId` が自分のIDと一致しない限り、一切処理しない
   - 個人用途としては実用上の妥協点だが、**案Aより弱い**ことは認識しておく
2. 再デプロイ時、新規デプロイを作るとURLが変わる。
   必ず「デプロイを管理 → 既存デプロイを編集」で更新すること（ハマりどころ）。
3. 実行時間6分/回、トリガー合計90分/日の制限（今回の負荷なら余裕）。
4. コールドスタートで1〜3秒かかることがあり、返信がややもたつく。
5. テストが書きにくく、ロジックの回帰を自動検知しづらい。

### 案Bを選ぶべきケース

「今週中に動くものが欲しい」「Googleカレンダーだけでいい」「自分しか使わない」
なら案Bが最短。実装は正味300行程度で収まる。

---

## 9. 案A / 案B の比較

| 観点 | A: Cloudflare Workers + D1 | B: Google Apps Script |
|---|---|---|
| 初期構築の速さ | 中（1〜2日） | **速い（数時間）** |
| Googleカレンダー連携 | OAuth設定が必要 | **1行で書ける** |
| iPhone(ICS)配信 | できる | できる |
| Webhook署名検証 | **できる** | できない（構造的制約） |
| 応答速度 | **速い（〜50ms）** | 1〜3秒（コールドスタート） |
| テスト自動化 | **Vitestで容易** | 困難 |
| Gitでの管理 | **ネイティブ** | clasp経由（やや面倒） |
| 費用 | 無料枠内 | 無料 |
| 長期の保守性 | **高い** | 中（GASの制約に縛られる） |
| データの手動閲覧・修正 | SQL/管理画面が要る | **スプレッドシートで直接** |

### 推奨

- **本命は案A（Cloudflare Workers + D1）**。健康データを扱うのに署名検証ができないのは
  設計として弱く、また予測ロジックは自動テストで守る価値がある。
- ただし **案Bで1週間試してから案Aに移すのも良い戦略**。
  ドメインロジック（parse / predict）を純粋関数として書いておけば、
  そのままTypeScriptへ移植できる。データもスプレッドシート→D1でCSV移行できる。

> 補足: このリポジトリの既存bot（GitHub Actions cron）方式は、
> **Webhookを受け取れない**ため今回は使えない。Actionsは外部からのHTTP POSTを
> 待ち受けられず、`repository_dispatch` 経由にしても起動に数十秒〜数分かかり、
> LINEの `replyToken` が失効する。常時稼働のHTTPエンドポイントが必須。

---

## 10. セキュリティ・プライバシー

- 扱うのは **生理・服薬という機微な健康情報**。設計時点で以下を守る。
- ログにメッセージ本文・userIdを残さない（デバッグ時のみ、期限を切って有効化）。
- `ics_token` は128bit以上のランダム値。漏れたら再発行できるようにする。
- Googleカレンダーは「限定公開」。共有設定を絶対に「一般公開」にしない。
- LINEのチャネルシークレット / アクセストークンは環境シークレットに置き、
  リポジトリに絶対にコミットしない。
- 許可した `line_user_id` 以外からのイベントは無視する（allowlist）。
- 退会・削除の導線: 「全部消して」で全記録とカレンダーイベントを削除できるようにする。

---

## 11. 実装マイルストーン

| # | 内容 | 完了の判定 |
|---|---|---|
| M1 | Webhook受信 + 署名検証 + 「飲んだ」をDBに記録 + 返信 | LINEで送って返信が返る |
| M2 | Googleカレンダーへの服薬イベント書き込み（冪等ID） | カレンダーに💊が出る／二重送信で増えない |
| M3 | 生理の開始・終了記録 + 予測アルゴリズム + 予測イベント差し替え | 「予測」と送ると次回予測が返る |
| M4 | Cron: 服薬リマインド / 飲み忘れ検知 / 予測日事前通知 | 指定時刻に通知が届き、記録済みならスキップされる |
| M5 | ICSフィード配信 + iPhone購読 | iPhone標準カレンダーに表示される |
| M6 | リッチメニュー / クイックリプライ / UNDO / 過去日の遡り記録 | タップだけで日常運用が回る |

M1〜M3 が要件そのもの、M4 が追加要望、M5〜M6 が使い勝手。

---

## 12. 未確定事項（実装前に決めたいこと）

1. **ピルの種類**: 21錠+7日休薬 / 24錠+4日 / 連続服用 のどれか。
   → 予測アルゴリズムの分岐（4.2節）に直結する。
2. **服薬リマインドの時刻**。
3. **利用者はあなた1人か**（＝allowlist方式でよいか）。
4. Googleカレンダーを iPhone に購読させる形（案A）で問題ないか、
   それとも Google を一切使わず ICS 配信（案B）にしたいか。
5. 「生理が終わった」も記録するか（記録すれば経血期間の長さも追跡できる）。
