export interface UserRow {
  line_user_id: string;
  timezone: string;
  day_start_hour: number;
  regimen: string;
  sheet_anchor: string | null;
  last_synced_anchor: string | null;
  reminder_time: string;
  nudge_after_min: number;
  /** リマインドから何分後に最終の追い打ちを送るか。NULL で送らない。 */
  final_nudge_after_min: number | null;
  period_notice_days: number;
  google_calendar_id: string | null;
  display_name: string | null;
  created_at: string;
}

export interface DoseRow {
  id: string;
  user_id: string;
  local_date: string;
  taken_at: string;
  source: string;
  calendar_event_id: string | null;
}

export interface PeriodRow {
  id: string;
  user_id: string;
  start_date: string;
  end_date: string | null;
  calendar_event_id: string | null;
}

export interface PredictionRow {
  user_id: string;
  placebo_start: string;
  predicted_date: string;
  band: number;
  confidence: string;
  calendar_event_id: string | null;
}

export class Store {
  constructor(private readonly db: D1Database) {}

  // ---- users ------------------------------------------------------------

  async getUser(userId: string): Promise<UserRow | null> {
    return this.db
      .prepare('SELECT * FROM users WHERE line_user_id = ?')
      .bind(userId)
      .first<UserRow>();
  }

  async listUsers(): Promise<UserRow[]> {
    const { results } = await this.db.prepare('SELECT * FROM users').all<UserRow>();
    return results;
  }

  async ensureUser(userId: string, timezone: string): Promise<UserRow> {
    await this.db
      .prepare(
        `INSERT INTO users (line_user_id, timezone, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT (line_user_id) DO NOTHING`,
      )
      .bind(userId, timezone, new Date().toISOString())
      .run();
    const user = await this.getUser(userId);
    if (!user) throw new Error('failed to create user');
    return user;
  }

  async updateUser(userId: string, patch: Partial<UserRow>): Promise<void> {
    const entries = Object.entries(patch).filter(([k]) => k !== 'line_user_id');
    if (entries.length === 0) return;
    const set = entries.map(([k]) => `${k} = ?`).join(', ');
    await this.db
      .prepare(`UPDATE users SET ${set} WHERE line_user_id = ?`)
      .bind(...entries.map(([, v]) => v as string | number | null), userId)
      .run();
  }

  // ---- doses ------------------------------------------------------------

  /** 記録できたら true。同じ論理日に2回目なら false (UNIQUE が弾く)。 */
  async insertDose(row: Omit<DoseRow, 'calendar_event_id'>): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO doses (id, user_id, local_date, taken_at, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, local_date) DO NOTHING`,
      )
      .bind(row.id, row.user_id, row.local_date, row.taken_at, row.source)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async getDose(userId: string, localDate: string): Promise<DoseRow | null> {
    return this.db
      .prepare('SELECT * FROM doses WHERE user_id = ? AND local_date = ?')
      .bind(userId, localDate)
      .first<DoseRow>();
  }

  async deleteDose(userId: string, localDate: string): Promise<DoseRow | null> {
    const row = await this.getDose(userId, localDate);
    if (!row) return null;
    await this.db
      .prepare('DELETE FROM doses WHERE user_id = ? AND local_date = ?')
      .bind(userId, localDate)
      .run();
    return row;
  }

  async latestDose(userId: string): Promise<DoseRow | null> {
    return this.db
      .prepare('SELECT * FROM doses WHERE user_id = ? ORDER BY local_date DESC LIMIT 1')
      .bind(userId)
      .first<DoseRow>();
  }

  /** local_date の昇順。連続日数の計算に使う。 */
  async listDoseDatesSince(userId: string, since: string): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT local_date FROM doses WHERE user_id = ? AND local_date >= ? ORDER BY local_date')
      .bind(userId, since)
      .all<{ local_date: string }>();
    return results.map((r) => r.local_date);
  }

  async setDoseEventId(userId: string, localDate: string, eventId: string): Promise<void> {
    await this.db
      .prepare('UPDATE doses SET calendar_event_id = ? WHERE user_id = ? AND local_date = ?')
      .bind(eventId, userId, localDate)
      .run();
  }

  // ---- periods ----------------------------------------------------------

  async insertPeriod(row: Omit<PeriodRow, 'calendar_event_id' | 'end_date'>): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO periods (id, user_id, start_date)
         VALUES (?, ?, ?)
         ON CONFLICT (user_id, start_date) DO NOTHING`,
      )
      .bind(row.id, row.user_id, row.start_date)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async listPeriodStarts(userId: string): Promise<string[]> {
    const { results } = await this.db
      .prepare('SELECT start_date FROM periods WHERE user_id = ? ORDER BY start_date')
      .bind(userId)
      .all<{ start_date: string }>();
    return results.map((r) => r.start_date);
  }

  /** 開始日と終了日の組。出血期間の長さを学習するのに使う。 */
  async listPeriods(userId: string): Promise<{ start_date: string; end_date: string | null }[]> {
    const { results } = await this.db
      .prepare('SELECT start_date, end_date FROM periods WHERE user_id = ? ORDER BY start_date')
      .bind(userId)
      .all<{ start_date: string; end_date: string | null }>();
    return results;
  }

  async getPeriod(userId: string, startDate: string): Promise<PeriodRow | null> {
    return this.db
      .prepare('SELECT * FROM periods WHERE user_id = ? AND start_date = ?')
      .bind(userId, startDate)
      .first<PeriodRow>();
  }

  async latestPeriod(userId: string): Promise<PeriodRow | null> {
    return this.db
      .prepare('SELECT * FROM periods WHERE user_id = ? ORDER BY start_date DESC LIMIT 1')
      .bind(userId)
      .first<PeriodRow>();
  }

  async closePeriod(userId: string, startDate: string, endDate: string): Promise<void> {
    await this.db
      .prepare('UPDATE periods SET end_date = ? WHERE user_id = ? AND start_date = ?')
      .bind(endDate, userId, startDate)
      .run();
  }

  async deletePeriod(userId: string, startDate: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM periods WHERE user_id = ? AND start_date = ?')
      .bind(userId, startDate)
      .run();
  }

  async setPeriodEventId(userId: string, startDate: string, eventId: string): Promise<void> {
    await this.db
      .prepare('UPDATE periods SET calendar_event_id = ? WHERE user_id = ? AND start_date = ?')
      .bind(eventId, userId, startDate)
      .run();
  }

  // ---- predictions ------------------------------------------------------

  async listPredictions(userId: string): Promise<PredictionRow[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM predictions WHERE user_id = ? ORDER BY placebo_start')
      .bind(userId)
      .all<PredictionRow>();
    return results;
  }

  async upsertPrediction(row: PredictionRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO predictions
           (user_id, placebo_start, predicted_date, band, confidence, calendar_event_id, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, placebo_start) DO UPDATE SET
           predicted_date = excluded.predicted_date,
           band = excluded.band,
           confidence = excluded.confidence,
           calendar_event_id = excluded.calendar_event_id,
           computed_at = excluded.computed_at`,
      )
      .bind(
        row.user_id,
        row.placebo_start,
        row.predicted_date,
        row.band,
        row.confidence,
        row.calendar_event_id,
        new Date().toISOString(),
      )
      .run();
  }

  async deletePrediction(userId: string, placeboStart: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM predictions WHERE user_id = ? AND placebo_start = ?')
      .bind(userId, placeboStart)
      .run();
  }

  async nextPrediction(userId: string, from: string): Promise<PredictionRow | null> {
    return this.db
      .prepare(
        'SELECT * FROM predictions WHERE user_id = ? AND predicted_date >= ? ORDER BY predicted_date LIMIT 1',
      )
      .bind(userId, from)
      .first<PredictionRow>();
  }

  // ---- allowed users ----------------------------------------------------

  async isAllowedUser(userId: string): Promise<boolean> {
    const row = await this.db
      .prepare('SELECT 1 AS ok FROM allowed_users WHERE line_user_id = ?')
      .bind(userId)
      .first<{ ok: number }>();
    return row !== null;
  }

  async addAllowedUser(userId: string, addedBy: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO allowed_users (line_user_id, added_by, added_at)
         VALUES (?, ?, ?) ON CONFLICT (line_user_id) DO NOTHING`,
      )
      .bind(userId, addedBy, new Date().toISOString())
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async removeAllowedUser(userId: string): Promise<boolean> {
    const res = await this.db
      .prepare('DELETE FROM allowed_users WHERE line_user_id = ?')
      .bind(userId)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  /** 一覧表示用。表示名は users 側にしか無いので突き合わせる。 */
  async listAllowedUsers(): Promise<{ line_user_id: string; display_name: string | null }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT a.line_user_id, u.display_name
           FROM allowed_users a
           LEFT JOIN users u ON u.line_user_id = a.line_user_id
          ORDER BY a.added_at`,
      )
      .all<{ line_user_id: string; display_name: string | null }>();
    return results;
  }

  // ---- idempotency ------------------------------------------------------

  /** 初めて見るイベントなら true。LINE の再送はここで落ちる。 */
  async claimWebhookEvent(eventId: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO processed_events (webhook_event_id, processed_at)
         VALUES (?, ?) ON CONFLICT (webhook_event_id) DO NOTHING`,
      )
      .bind(eventId, new Date().toISOString())
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async releaseWebhookEvent(eventId: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM processed_events WHERE webhook_event_id = ?')
      .bind(eventId)
      .run();
  }

  /** まだ送っていなければ true。cron が多重起動しても二重送信しない。 */
  async claimNotification(userId: string, kind: string, localDate: string): Promise<boolean> {
    const res = await this.db
      .prepare(
        `INSERT INTO sent_notifications (user_id, kind, local_date, sent_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (user_id, kind, local_date) DO NOTHING`,
      )
      .bind(userId, kind, localDate, new Date().toISOString())
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async releaseNotification(userId: string, kind: string, localDate: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM sent_notifications WHERE user_id = ? AND kind = ? AND local_date = ?')
      .bind(userId, kind, localDate)
      .run();
  }
}
