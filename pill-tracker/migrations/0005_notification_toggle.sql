-- 通知の対象を「役割」ではなく「実際にピルを飲んでいるか」で決める。
--
-- これまでは allowed_users に載っているかで判定していたため、
-- 「使えるのに通知だけ来ない」という状態が起きた。本来、通知が要るのは
-- 服薬している人であって、許可リストに載っている人ではない。
--
-- NULL     … 自動判定（シート起点が設定されていれば送る）
-- 1 / 0    … 明示的にオン / オフ（自動判定より優先）
ALTER TABLE users ADD COLUMN notifications_enabled INTEGER;

-- 移行時点の挙動を保つ。いま通知が届いていない人（＝利用者として
-- 登録されていない管理者）は、シート起点が残っていても静かにオフのまま。
UPDATE users
   SET notifications_enabled = 0
 WHERE line_user_id NOT IN (SELECT line_user_id FROM allowed_users);
