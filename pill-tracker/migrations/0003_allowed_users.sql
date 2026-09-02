-- 許可リストをシークレットからDBへ移す。
--
-- シークレット1本に全員ぶんを詰めていると、追加のたびに全員ぶんを
-- 打ち直すことになり、抜けても何も警告が出ないまま誰かが締め出される。
-- 行として持てば追加は1件の挿入で済み、他の人を巻き添えにしない。
--
-- ALLOWED_LINE_USER_ID は「管理者」の定義として残す。
-- 管理者だけが人を追加・削除でき、DBが空でも締め出されない。
CREATE TABLE IF NOT EXISTS allowed_users (
  line_user_id TEXT PRIMARY KEY,
  added_by     TEXT,
  added_at     TEXT NOT NULL
);
