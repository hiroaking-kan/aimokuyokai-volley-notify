/**
 * 定期通知を送る相手かどうか。
 *
 * 通知が要るのは「ピルを飲んでいる人」であって、「許可リストに載っている人」
 * ではない。役割で決めると、運用のためにbotを使うだけの管理者に服薬リマインドが
 * 飛んだり、逆に使えるのに通知だけ来ない人が出たりする。
 *
 * 既定はシート起点の有無で判定し、明示的な設定があればそちらを優先する。
 */
export type NotificationSetting = number | null;

export interface NotificationTarget {
  notifications_enabled: NotificationSetting;
  sheet_anchor: string | null;
}

export function notificationsOn(user: NotificationTarget): boolean {
  if (user.notifications_enabled !== null) return user.notifications_enabled === 1;
  return user.sheet_anchor !== null;
}

/** なぜ届く / 届かないのかを一言で。設定画面が無いぶん、理由を必ず言えるようにする。 */
export function notificationReason(user: NotificationTarget): string {
  if (user.notifications_enabled === 1) return '「通知 オン」に設定されています';
  if (user.notifications_enabled === 0) return '「通知 オフ」に設定されています';
  return user.sheet_anchor !== null
    ? 'シートを開始しているため自動でオンです'
    : 'シートが未開始のため自動でオフです';
}
