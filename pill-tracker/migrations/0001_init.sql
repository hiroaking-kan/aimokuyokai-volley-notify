-- 利用者設定。当面ひとりだが最初から user_id を持たせる。
CREATE TABLE IF NOT EXISTS users (
  line_user_id       TEXT PRIMARY KEY,
  timezone           TEXT    NOT NULL DEFAULT 'Asia/Tokyo',
  day_start_hour     INTEGER NOT NULL DEFAULT 4,
  regimen            TEXT    NOT NULL DEFAULT '24+4',
  sheet_anchor       TEXT,
  last_synced_anchor TEXT,
  reminder_time      TEXT    NOT NULL DEFAULT '21:00',
  nudge_after_min    INTEGER NOT NULL DEFAULT 120,
  period_notice_days INTEGER NOT NULL DEFAULT 3,
  google_calendar_id TEXT,
  created_at         TEXT    NOT NULL
);

-- 服薬記録。論理日ごとに1件で、UNIQUE が二重送信を弾く。
CREATE TABLE IF NOT EXISTS doses (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  local_date        TEXT NOT NULL,
  taken_at          TEXT NOT NULL,
  source            TEXT NOT NULL,
  calendar_event_id TEXT,
  UNIQUE (user_id, local_date)
);
CREATE INDEX IF NOT EXISTS idx_doses_user_date ON doses (user_id, local_date);

-- 生理(消退出血)記録。end_date が NULL なら継続中。
CREATE TABLE IF NOT EXISTS periods (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  start_date        TEXT NOT NULL,
  end_date          TEXT,
  calendar_event_id TEXT,
  UNIQUE (user_id, start_date)
);
CREATE INDEX IF NOT EXISTS idx_periods_user_start ON periods (user_id, start_date);

-- カレンダーへ先出しした予測。placebo_start が決定論的なキーになる。
CREATE TABLE IF NOT EXISTS predictions (
  user_id           TEXT NOT NULL,
  placebo_start     TEXT NOT NULL,
  predicted_date    TEXT NOT NULL,
  band              INTEGER NOT NULL,
  confidence        TEXT NOT NULL,
  calendar_event_id TEXT,
  computed_at       TEXT NOT NULL,
  PRIMARY KEY (user_id, placebo_start)
);

-- LINE は同じイベントを再送してくる。
CREATE TABLE IF NOT EXISTS processed_events (
  webhook_event_id TEXT PRIMARY KEY,
  processed_at     TEXT NOT NULL
);

-- 同じ通知を二度打たない。
CREATE TABLE IF NOT EXISTS sent_notifications (
  user_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,
  local_date TEXT NOT NULL,
  sent_at    TEXT NOT NULL,
  PRIMARY KEY (user_id, kind, local_date)
);
