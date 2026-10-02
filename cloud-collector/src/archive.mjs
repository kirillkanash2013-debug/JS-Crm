// Per-client database: SQLite inside the client's Durable Object (10 GB each,
// no shared tables between clients). Holds the whole history in compact form:
// daily spend per campaign, current structure, a change log of names,
// statuses and budgets, and a short run log. Raw snapshots go to R2.
//
// Cost rule: a row is written only when something changed. A 15-minute run
// over unchanged data writes almost nothing (billing counts rows written).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS socials (user_id TEXT PRIMARY KEY, name TEXT, last_at TEXT, last_mode TEXT, summary TEXT)`,
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, user_id TEXT, name TEXT, currency TEXT, timezone TEXT, status TEXT,
    business_id TEXT, business_name TEXT, structure_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, level TEXT NOT NULL, account_id TEXT NOT NULL, campaign_id TEXT, adset_id TEXT,
    name TEXT, status TEXT, effective_status TEXT, daily_budget TEXT, lifetime_budget TEXT, first_seen TEXT, seen_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS objects_account ON objects (account_id, level)`,
  `CREATE TABLE IF NOT EXISTS daily_spend (date TEXT NOT NULL, campaign_id TEXT NOT NULL, account_id TEXT NOT NULL, spend REAL NOT NULL,
    currency TEXT, updated_at TEXT, PRIMARY KEY (date, campaign_id)) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS daily_spend_account ON daily_spend (account_id, date)`,
  `CREATE TABLE IF NOT EXISTS changes (at TEXT NOT NULL, object_id TEXT NOT NULL, level TEXT, field TEXT, old TEXT, new TEXT)`,
  `CREATE INDEX IF NOT EXISTS changes_object ON changes (object_id, at)`,
  `CREATE TABLE IF NOT EXISTS runs (at TEXT NOT NULL, user_id TEXT, mode TEXT, accounts INTEGER, campaigns INTEGER, spend TEXT)`
];
const TRACKED = ['name', 'status', 'effective_status', 'daily_budget', 'lifetime_budget'];
const RUN_LOG_DAYS = 90;

const rows = (sql, q, ...b) => sql.exec(q, ...b).toArray();

export class SqlArchive {
  constructor(sql, bucket = null) {
    this.sql = sql;
    this.bucket = bucket;
    for (const q of SCHEMA) sql.exec(q);
  }

  // Upserts one object; logs every changed tracked field. Unchanged → no write.
  upsertObject(level, o, at) {
    const next = {name: o.name ?? null, status: o.status ?? null, effective_status: o.effectiveStatus ?? null,
      daily_budget: o.daily_budget ?? o.dailyBudgetRaw ?? null, lifetime_budget: o.lifetime_budget ?? o.lifetimeBudgetRaw ?? null};
    // Insights-only rows carry no status; never overwrite known values with UNKNOWN.
    for (const k of ['status', 'effective_status']) if (next[k] === 'UNKNOWN') next[k] = null;
    const [old] = rows(this.sql, 'SELECT * FROM objects WHERE id=?', o.id);
    if (!old) {
      this.sql.exec(`INSERT INTO objects (id,level,account_id,campaign_id,adset_id,name,status,effective_status,daily_budget,lifetime_budget,first_seen,seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, o.id, level, o.accountId, o.campaignId ?? null, o.adsetId ?? null,
        next.name, next.status, next.effective_status, next.daily_budget == null ? null : String(next.daily_budget), next.lifetime_budget == null ? null : String(next.lifetime_budget), at, o.seenAt ?? null);
      return;
    }
    const changed = TRACKED.filter(k => next[k] != null && String(next[k]) !== String(old[k] ?? ''));
    for (const k of changed) this.sql.exec('INSERT INTO changes (at,object_id,level,field,old,new) VALUES (?,?,?,?,?,?)', at, o.id, level, k, old[k], String(next[k]));
    const seenMoved = o.seenAt && o.seenAt !== old.seen_at;
    if (!changed.length && !seenMoved) return;
    this.sql.exec(`UPDATE objects SET name=coalesce(?,name), status=coalesce(?,status), effective_status=coalesce(?,effective_status),
      daily_budget=coalesce(?,daily_budget), lifetime_budget=coalesce(?,lifetime_budget), seen_at=coalesce(?,seen_at) WHERE id=?`,
      next.name, next.status, next.effective_status, next.daily_budget == null ? null : String(next.daily_budget),
      next.lifetime_budget == null ? null : String(next.lifetime_budget), o.seenAt ?? null, o.id);
  }

  // Stores one collection result and returns the compact summary for /v1/status.
  async record(userId, snapshot, mode = snapshot.mode || 'api', label = null) {
    const at = snapshot.observedAt;
    const social = snapshot.social;
    for (const a of social.accounts) {
      const [old] = rows(this.sql, 'SELECT name,currency,timezone,status,business_id,business_name FROM accounts WHERE id=?', a.id);
      const next = [a.name, a.currency, a.timezone ?? null, a.statusRaw == null ? null : String(a.statusRaw), a.business?.id ?? null, a.business?.name ?? null];
      if (!old || JSON.stringify(Object.values(old)) !== JSON.stringify(next))
        this.sql.exec(`INSERT INTO accounts (id,user_id,name,currency,timezone,status,business_id,business_name) VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id, name=excluded.name, currency=excluded.currency, timezone=excluded.timezone,
          status=excluded.status, business_id=excluded.business_id, business_name=excluded.business_name`, a.id, userId, ...next);
    }
    for (const [accountId, s] of Object.entries(snapshot.structures || {})) {
      const [acc] = rows(this.sql, 'SELECT structure_at FROM accounts WHERE id=?', accountId);
      if (!s?.complete || acc?.structure_at === s.observedAt) continue; // cached structure: nothing new to write
      for (const [level, list] of [['campaign', s.campaigns], ['adset', s.adsets], ['ad', s.ads]])
        for (const o of list) this.upsertObject(level, {...o, seenAt: s.observedAt}, at);
      this.sql.exec('UPDATE accounts SET structure_at=? WHERE id=?', s.observedAt, accountId);
    }
    for (const r of Object.values(snapshot.reports || {})) {
      for (const c of r.campaigns || []) this.upsertObject('campaign', c, at);
      for (const m of r.metrics || []) {
        if (m.since !== m.until) continue;
        this.sql.exec(`INSERT INTO daily_spend (date,campaign_id,account_id,spend,currency,updated_at) VALUES (?,?,?,?,?,?)
          ON CONFLICT(date,campaign_id) DO UPDATE SET spend=excluded.spend, updated_at=excluded.updated_at WHERE daily_spend.spend <> excluded.spend`,
          m.since, m.campaignId, r.account.id, m.spend, m.currency, at);
      }
    }
    const summary = summarize(snapshot, mode);
    this.sql.exec(`INSERT INTO socials (user_id,name,last_at,last_mode,summary) VALUES (?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, last_at=excluded.last_at, last_mode=excluded.last_mode, summary=excluded.summary`,
      userId, label || social.user.name, at, mode, JSON.stringify(summary));
    this.sql.exec('INSERT INTO runs (at,user_id,mode,accounts,campaigns,spend) VALUES (?,?,?,?,?,?)', at, userId, mode, summary.accounts, summary.campaigns, JSON.stringify(summary.spendByCurrency));
    if (Math.random() < 0.02) this.sql.exec('DELETE FROM runs WHERE at < ?', new Date(Date.parse(at) - RUN_LOG_DAYS * 864e5).toISOString());
    await this.saveRaw(userId, snapshot);
    return summary;
  }

  // Raw snapshot, gzip, one object per social per hour (later runs overwrite):
  // raw/<user>/<date>/<HH>.json.gz. An R2 lifecycle rule can expire raw/ after N days.
  async saveRaw(userId, snapshot) {
    if (!this.bucket) return;
    const at = snapshot.observedAt;
    const body = new Response(new Blob([JSON.stringify(snapshot)]).stream().pipeThrough(new CompressionStream('gzip')));
    await this.bucket.put('raw/' + userId + '/' + at.slice(0, 10) + '/' + at.slice(11, 13) + '.json.gz', await body.arrayBuffer(),
      {httpMetadata: {contentType: 'application/json', contentEncoding: 'gzip'}});
  }

  summaries() {
    return Object.fromEntries(rows(this.sql, 'SELECT user_id, summary FROM socials').map(r => [r.user_id, JSON.parse(r.summary)]));
  }

  forget(userId) { this.sql.exec('DELETE FROM socials WHERE user_id=?', userId); }

  // Last complete structure per account, rebuilt from the database, so the
  // collector can skip re-reading it within the hour without keeping blobs.
  previous(userId) {
    const structures = {};
    for (const a of rows(this.sql, 'SELECT id,name,currency,structure_at FROM accounts WHERE user_id=? AND structure_at IS NOT NULL', userId)) {
      const list = level => rows(this.sql, 'SELECT * FROM objects WHERE account_id=? AND level=? AND seen_at=? ORDER BY id', a.id, level, a.structure_at).map(o => {
        const out = {id: o.id, accountId: o.account_id, name: o.name ?? '', status: o.status ?? '', effectiveStatus: o.effective_status ?? ''};
        if (o.campaign_id) out.campaignId = o.campaign_id;
        if (o.adset_id) out.adsetId = o.adset_id;
        if (o.daily_budget != null) out.daily_budget = o.daily_budget;
        if (o.lifetime_budget != null) out.lifetime_budget = o.lifetime_budget;
        return out;
      });
      structures[a.id] = {schemaVersion: 1, complete: true, observedAt: a.structure_at, account: {id: a.id, name: a.name, currency: a.currency},
        campaigns: list('campaign'), adsets: list('adset'), ads: list('ad')};
    }
    return {structures};
  }

  // Daily spend for dashboards and the bot. Dates are inclusive.
  report({since, until, userId}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || since > until) throw new Error('Invalid period');
    const list = rows(this.sql, `SELECT d.date, d.account_id AS accountId, a.name AS accountName, a.user_id AS userId, d.campaign_id AS campaignId,
        o.name AS campaignName, o.effective_status AS status, d.spend, d.currency
      FROM daily_spend d LEFT JOIN accounts a ON a.id=d.account_id LEFT JOIN objects o ON o.id=d.campaign_id
      WHERE d.date BETWEEN ? AND ? AND (? IS NULL OR a.user_id=?) ORDER BY d.date, d.account_id, d.campaign_id`, since, until, userId ?? null, userId ?? null);
    const totals = {};
    for (const r of list) totals[r.currency] = Math.round(((totals[r.currency] || 0) + r.spend) * 100) / 100;
    return {since, until, rows: list, totals};
  }

  // Compact per-social summary (accounts/БМ/pages counts, last collection) from
  // the last stored run — for the «соц добавлен» notification in the bot.
  socialSummary(userId) {
    const [r] = rows(this.sql, 'SELECT summary,last_at FROM socials WHERE user_id=?', String(userId));
    if (!r?.summary) return null;
    try { return {...JSON.parse(r.summary), lastAt: r.last_at}; } catch { return null; }
  }

  changes({since, objectId}) {
    return rows(this.sql, 'SELECT * FROM changes WHERE at >= ? AND (? IS NULL OR object_id=?) ORDER BY at DESC LIMIT 500', since, objectId ?? null, objectId ?? null);
  }

  // Current campaigns with today's spend — for managing them from the bot.
  campaigns({userId, date}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date');
    return rows(this.sql, `SELECT o.id AS campaignId, o.name, o.status, o.effective_status AS effectiveStatus, o.daily_budget AS dailyBudget,
        o.account_id AS accountId, a.name AS accountName, a.currency, COALESCE(d.spend,0) AS spend
      FROM objects o JOIN accounts a ON a.id=o.account_id
      LEFT JOIN daily_spend d ON d.campaign_id=o.id AND d.date=?
      WHERE o.level=? AND (? IS NULL OR a.user_id=?) ORDER BY a.name, o.name`,
      date, 'campaign', userId ?? null, userId ?? null);
  }
}

export function summarize(snapshot, mode) {
  const count = key => Object.values(snapshot.structures || {}).reduce((n, s) => n + (s?.[key]?.length || 0), 0);
  const spendByCurrency = {};
  for (const r of Object.values(snapshot.reports || {})) {
    const cur = r?.account?.currency;
    if (cur) spendByCurrency[cur] = Math.round(((spendByCurrency[cur] || 0) + (r.metrics || []).reduce((n, m) => n + (Number(m.spend) || 0), 0)) * 100) / 100;
  }
  // Split ad accounts into BM-owned (what buyers actually launch from) and the
  // social's own personal ones (rarely used). «РК» in the bot means the BM ones.
  const accounts = snapshot.social?.accounts || [];
  const rkBm = accounts.filter(a => a.business).length;
  return {source: snapshot.source, complete: snapshot.complete, observedAt: snapshot.observedAt, mode,
    accounts: accounts.length, rkBm, rkPersonal: accounts.length - rkBm,
    businesses: snapshot.social?.businesses?.length || 0, pages: snapshot.social?.fanPages?.length || 0,
    fbName: snapshot.social?.user?.name || null,
    campaigns: count('campaigns'), adsets: count('adsets'), ads: count('ads'), spendByCurrency};
}
