-- 複数人で使えるようにする。記録・予測・通知はもともと user_id 単位なので、
-- 足りないのは「誰のカレンダーか」を見分けるための表示名だけ。
ALTER TABLE users ADD COLUMN display_name TEXT;
