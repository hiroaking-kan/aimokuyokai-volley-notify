-- 飲み忘れの追い打ちを「N分おきに最大M回」に置き換える。
--
-- これまでは「2時間後に1回」「3時間後に1回」という2段構えだったが、
-- 同じことを2つの設定で表現していて分かりにくく、短い間隔で何度も
-- 追いかけたい場合に表現できなかった。
--
-- 上限が必要なのは LINE の無料枠が月200通(アカウント全体)のため。
-- 記録しないまま放置されると枠を使い切り、以降の通知が一切
-- 届かなくなる。飲み忘れ防止の仕組みとして本末転倒なので上限を持つ。
ALTER TABLE users ADD COLUMN repeat_every_min INTEGER DEFAULT 10;
ALTER TABLE users ADD COLUMN repeat_max INTEGER DEFAULT 3;

-- nudge_after_min と final_nudge_after_min は上の2列に置き換わり、
-- 参照されなくなる。既存の値を壊さないよう、列自体は残しておく。
