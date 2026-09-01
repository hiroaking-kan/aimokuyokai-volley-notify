const API = 'https://api.line.me/v2/bot';

export interface QuickReplyItem {
  label: string;
  data: string;
}

export class LineClient {
  constructor(private readonly accessToken: string) {}

  /** 応答メッセージ。replyToken の有効期間が短いので同期で先に送る。 */
  async reply(replyToken: string, text: string, quickReplies: QuickReplyItem[] = []): Promise<void> {
    await this.post('/message/reply', {
      replyToken,
      messages: [buildMessage(text, quickReplies)],
    });
  }

  /** プッシュ。無料枠 (月200通) にカウントされるのはこちらだけ。 */
  async push(to: string, text: string, quickReplies: QuickReplyItem[] = []): Promise<void> {
    await this.post('/message/push', {
      to,
      messages: [buildMessage(text, quickReplies)],
    });
  }

  /**
   * 表示名を取る。複数人で使うとき、カレンダー名を見分けるために要る。
   * 取れなくても致命的ではないので null を返す。
   */
  async displayName(userId: string): Promise<string | null> {
    try {
      const res = await fetch(`${API}/profile/${encodeURIComponent(userId)}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { displayName?: string };
      return body.displayName ?? null;
    } catch {
      return null;
    }
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${API}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // 本文にメッセージ内容は含めない (ログに健康情報を残さないため)
      throw new Error(`LINE API ${path} failed: ${res.status}`);
    }
  }
}

function buildMessage(text: string, quickReplies: QuickReplyItem[]) {
  const message: Record<string, unknown> = { type: 'text', text };
  if (quickReplies.length > 0) {
    message.quickReply = {
      items: quickReplies.map((q) => ({
        type: 'action',
        action: { type: 'postback', label: q.label, data: q.data, displayText: q.label },
      })),
    };
  }
  return message;
}
