import type { AllDayEvent, CalendarBackend } from './backend.js';
import { CALENDAR_SUMMARY, toApiEvent } from './backend.js';
import { seal } from './signing.js';

/** GAS はコールドスタートで数秒かかることがあるので、少しだけ待って1度やり直す。 */
const RETRIES = 2;
const RETRY_DELAY_MS = 1200;

interface GasResponse {
  ok: boolean;
  error?: string;
  calendarId?: string;
  eventId?: string;
}

/**
 * カレンダー書き込みを Google Apps Script のウェブアプリに委ねる。
 *
 * こうすると Google 側の OAuth 設定 (クライアント作成・同意画面の公開・
 * refresh token の失効管理) が一切要らなくなる。GAS はスクリプトの
 * 所有者の権限で動くため。LINE の署名検証は Workers 側に残るので、
 * GAS 単体構成の弱点は踏まない。
 */
export class GasCalendar implements CalendarBackend {
  constructor(
    private readonly endpoint: string,
    private readonly secret: string,
  ) {}

  async ensureCalendar(timezone: string): Promise<string> {
    const res = await this.call({ op: 'ensureCalendar', summary: CALENDAR_SUMMARY, timezone });
    if (!res.calendarId) throw new Error('GAS did not return a calendarId');
    return res.calendarId;
  }

  async upsert(calendarId: string, event: AllDayEvent): Promise<string> {
    await this.call({ op: 'upsert', calendarId, event: toApiEvent(event) });
    return event.id;
  }

  async remove(calendarId: string, eventId: string): Promise<void> {
    await this.call({ op: 'remove', calendarId, eventId });
  }

  private async call(body: Record<string, unknown>): Promise<GasResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAY_MS);
      try {
        return await this.callOnce(body);
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error('GAS call failed');
  }

  private async callOnce(body: Record<string, unknown>): Promise<GasResponse> {
    const envelope = await seal(body, this.secret, Date.now());

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
      // GAS の /exec は 302 でコンテンツを返す
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`GAS endpoint returned ${res.status}`);

    const parsed = (await res.json()) as GasResponse;
    // 本文にイベントの中身は含めない (ログに健康情報を残さないため)
    if (!parsed.ok) throw new Error(`GAS rejected the request: ${parsed.error ?? 'unknown'}`);
    return parsed;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
