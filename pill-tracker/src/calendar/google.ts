import { addDays, compactYmd } from '../domain/dates.js';

const CAL_API = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export const CALENDAR_SUMMARY = 'ピル・生理記録';

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export type EventKind = 'dose' | 'placebo' | 'period' | 'prediction';

export interface AllDayEvent {
  id: string;
  kind: EventKind;
  summary: string;
  description?: string;
  /** 開始日 (含む)。 */
  start: string;
  /** 終了日 (含む)。Google の end.date は排他なので +1 して送る。 */
  endInclusive: string;
  colorId?: string;
}

/**
 * イベントIDは日付から決まる。Google はイベントIDをクライアント指定でき、
 * 使える文字は base32hex (a-v と 0-9) なので下の接頭辞はすべて収まる。
 * 何度書き込んでも重複せず、リトライも二重実行も安全になる。
 */
export const eventId = {
  dose: (date: string) => `dose${compactYmd(date)}`,
  placebo: (placeboStart: string) => `placebo${compactYmd(placeboStart)}`,
  period: (startDate: string) => `period${compactYmd(startDate)}`,
  prediction: (predictedDate: string) => `pred${compactYmd(predictedDate)}`,
};

export class GoogleCalendar {
  private accessToken: string | null = null;
  private expiresAt = 0;

  constructor(private readonly creds: GoogleCredentials) {}

  /** 専用カレンダーを作る。メインカレンダーを汚さず表示のON/OFFも自由になる。 */
  async createCalendar(timezone: string): Promise<string> {
    const res = await this.request('POST', '/calendars', {
      summary: CALENDAR_SUMMARY,
      timeZone: timezone,
    });
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  /**
   * 冪等な upsert。まず PUT し、まだ無ければ (404) id を指定して POST する。
   * 更新は1回、新規作成だけ2回のリクエストになる。
   */
  async upsert(calendarId: string, event: AllDayEvent): Promise<string> {
    const body = toGoogleEvent(event);
    const path = `/calendars/${encodeURIComponent(calendarId)}/events`;

    const updated = await this.request('PUT', `${path}/${event.id}`, body, [404, 410]);
    if (updated.ok) return event.id;

    // 409 は「別経路で作成済み」なので成功として扱う
    await this.request('POST', path, body, [409]);
    return event.id;
  }

  async remove(calendarId: string, id: string): Promise<void> {
    await this.request(
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${id}`,
      undefined,
      [404, 410],
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    tolerate: number[] = [],
  ): Promise<Response> {
    const token = await this.token();
    const res = await fetch(`${CAL_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!res.ok && !tolerate.includes(res.status)) {
      throw new Error(`Google Calendar ${method} ${path} failed: ${res.status}`);
    }
    return res;
  }

  /** refresh token を access token に交換する。isolate 内では使い回す。 */
  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.creds.clientId,
        client_secret: this.creds.clientSecret,
        refresh_token: this.creds.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`);

    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in - 60) * 1000;
    return this.accessToken;
  }
}

function toGoogleEvent(event: AllDayEvent) {
  return {
    id: event.id,
    summary: event.summary,
    ...(event.description ? { description: event.description } : {}),
    start: { date: event.start },
    end: { date: addDays(event.endInclusive, 1) },
    transparency: 'transparent',
    ...(event.colorId ? { colorId: event.colorId } : {}),
    extendedProperties: { private: { app: 'pilltracker', kind: event.kind } },
  };
}
