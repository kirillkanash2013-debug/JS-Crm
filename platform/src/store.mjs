// Storage behind one small interface: D1 in production, memory in tests.
const now = () => new Date().toISOString();

export class D1Store {
  constructor(db) { this.db = db; }
  async createTenant(t) {
    await this.db.prepare('INSERT INTO tenants (id,name,plan,social_limit,status,paid_until,created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(t.id, t.name, t.plan, t.socialLimit, 'active', t.paidUntil, now()).run();
    return this.tenant(t.id);
  }
  async tenant(id) {
    const r = await this.db.prepare('SELECT * FROM tenants WHERE id=?').bind(id).first();
    return r && {id: r.id, name: r.name, plan: r.plan, socialLimit: r.social_limit, status: r.status, paidUntil: r.paid_until, integrationTokenEnc: r.integration_token_enc ?? null};
  }
  async extendTenant(id, paidUntil) { await this.db.prepare('UPDATE tenants SET paid_until=?, status=? WHERE id=?').bind(paidUntil, 'active', id).run(); }
  async setIntegrationTokenEnc(id, enc) { await this.db.prepare('UPDATE tenants SET integration_token_enc=? WHERE id=?').bind(enc, id).run(); }
  async putToken(hash, tenantId, kind) {
    await this.db.prepare('INSERT INTO access_tokens (hash,tenant_id,kind,created_at) VALUES (?,?,?,?)').bind(hash, tenantId, kind, now()).run();
  }
  async tokenTenant(hash, kind) {
    const r = await this.db.prepare('SELECT tenant_id FROM access_tokens WHERE hash=? AND kind=? AND revoked_at IS NULL').bind(hash, kind).first();
    return r ? r.tenant_id : null;
  }
  async revokeTokens(tenantId, kind) {
    await this.db.prepare('UPDATE access_tokens SET revoked_at=? WHERE tenant_id=? AND kind=? AND revoked_at IS NULL').bind(now(), tenantId, kind).run();
  }
  async chat(chatId) {
    const r = await this.db.prepare('SELECT tenant_id,state FROM chats WHERE chat_id=?').bind(String(chatId)).first();
    return r ? {tenantId: r.tenant_id, state: r.state} : null;
  }
  async setChat(chatId, tenantId, state) {
    await this.db.prepare('INSERT INTO chats (chat_id,tenant_id,state,updated_at) VALUES (?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET tenant_id=excluded.tenant_id, state=excluded.state, updated_at=excluded.updated_at')
      .bind(String(chatId), tenantId, state, now()).run();
  }
  async unbindChat(chatId) { await this.db.prepare('DELETE FROM chats WHERE chat_id=?').bind(String(chatId)).run(); }
  async chatForTenant(tenantId) { const r = await this.db.prepare('SELECT chat_id FROM chats WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 1').bind(tenantId).first(); return r ? r.chat_id : null; }
  async settings(tenantId) {
    const r = await this.db.prepare('SELECT * FROM settings WHERE tenant_id=?').bind(tenantId).first();
    return r ? {keitaroUrl: r.keitaro_url, keitaroKeyEnc: r.keitaro_key_enc, keitaroSub: r.keitaro_sub, timezone: r.timezone, currency: r.currency, onboardedAt: r.onboarded_at} : {};
  }
  async saveSettings(tenantId, patch) {
    const s = {...await this.settings(tenantId), ...patch};
    await this.db.prepare('INSERT INTO settings (tenant_id,keitaro_url,keitaro_key_enc,keitaro_sub,timezone,currency,onboarded_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET keitaro_url=excluded.keitaro_url, keitaro_key_enc=excluded.keitaro_key_enc, keitaro_sub=excluded.keitaro_sub, timezone=excluded.timezone, currency=excluded.currency, onboarded_at=excluded.onboarded_at')
      .bind(tenantId, s.keitaroUrl ?? null, s.keitaroKeyEnc ?? null, s.keitaroSub ?? null, s.timezone ?? null, s.currency ?? null, s.onboardedAt ?? null).run();
  }
  async payment(id) {
    const r = await this.db.prepare('SELECT tenant_id FROM payments WHERE id=?').bind(id).first();
    return r ? {tenantId: r.tenant_id} : null;
  }
  async recordPayment(p) {
    await this.db.prepare('INSERT INTO payments (id,tenant_id,provider,amount,currency,created_at) VALUES (?,?,?,?,?,?)')
      .bind(p.id, p.tenantId, p.provider, String(p.amount ?? ''), p.currency ?? null, now()).run();
  }
  async createInvite(i) {
    await this.db.prepare('INSERT INTO invites (id,hash,plan,days,note,created_at,expires_at) VALUES (?,?,?,?,?,?,?)')
      .bind(i.id, i.hash, i.plan, i.days, i.note ?? null, now(), i.expiresAt).run();
  }
  async invite(hash) {
    const r = await this.db.prepare('SELECT * FROM invites WHERE hash=?').bind(hash).first();
    return r && inviteRow(r);
  }
  // Atomic: only one caller can mark an unused code as used.
  async claimInvite(hash, tenantId, chatId) {
    const r = await this.db.prepare('UPDATE invites SET used_at=?, tenant_id=?, used_by_chat=? WHERE hash=? AND used_at IS NULL AND revoked_at IS NULL')
      .bind(now(), tenantId, String(chatId), hash).run();
    return (r.meta?.changes ?? r.changes ?? 0) === 1;
  }
  async listInvites(limit) {
    const r = await this.db.prepare('SELECT * FROM invites ORDER BY created_at DESC LIMIT ?').bind(limit).all();
    return (r.results || []).map(inviteRow);
  }
  async revokeInvite(id) {
    const r = await this.db.prepare('UPDATE invites SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL').bind(now(), id).run();
    return (r.meta?.changes ?? r.changes ?? 0) === 1;
  }
  async createAgent(tenantId, name) { const id = crypto.randomUUID().slice(0, 8); await this.db.prepare('INSERT INTO agents (id,tenant_id,name,created_at) VALUES (?,?,?,?)').bind(id, tenantId, name, now()).run(); return {id, name}; }
  async listAgents(tenantId) { const r = await this.db.prepare('SELECT id,name FROM agents WHERE tenant_id=? ORDER BY name').bind(tenantId).all(); return (r.results || []).map(a => ({id: a.id, name: a.name})); }
  async social(tenantId, userId) { const r = await this.db.prepare('SELECT user_id AS userId, label, agent_id AS agentId FROM socials WHERE tenant_id=? AND user_id=?').bind(tenantId, String(userId)).first(); return r ? {userId: r.userId, label: r.label, agentId: r.agentId} : null; }
  async addSocial(tenantId, userId, label) { await this.db.prepare('INSERT INTO socials (tenant_id,user_id,label,seen_at) VALUES (?,?,?,?)').bind(tenantId, String(userId), label ?? null, now()).run(); }
  async setSocialLabel(tenantId, userId, label) { await this.db.prepare('UPDATE socials SET label=? WHERE tenant_id=? AND user_id=?').bind(label, tenantId, String(userId)).run(); }
  async assignSocial(tenantId, userId, agentId) { await this.db.prepare('UPDATE socials SET agent_id=? WHERE tenant_id=? AND user_id=?').bind(agentId, tenantId, String(userId)).run(); }
  async listSocials(tenantId) { const r = await this.db.prepare('SELECT user_id AS userId, label, agent_id AS agentId FROM socials WHERE tenant_id=?').bind(tenantId).all(); return (r.results || []).map(s => ({userId: s.userId, label: s.label, agentId: s.agentId})); }
  async deleteSocial(tenantId, userId) { await this.db.prepare('DELETE FROM socials WHERE tenant_id=? AND user_id=?').bind(tenantId, String(userId)).run(); }
}

const inviteRow = r => ({id: r.id, plan: r.plan, days: r.days, note: r.note, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, usedAt: r.used_at, tenantId: r.tenant_id, usedByChat: r.used_by_chat});

export class MemoryStore {
  constructor() { this.tenants = new Map(); this.tokens = new Map(); this.chats = new Map(); this.prefs = new Map(); this.payments = new Map(); this.invites = new Map(); this.agents = new Map(); this.socialsMap = new Map(); }
  async createTenant(t) { this.tenants.set(t.id, {id: t.id, name: t.name, plan: t.plan, socialLimit: t.socialLimit, status: 'active', paidUntil: t.paidUntil}); return this.tenant(t.id); }
  async tenant(id) { const t = this.tenants.get(id); return t ? {integrationTokenEnc: null, ...t} : null; }
  async extendTenant(id, paidUntil) { Object.assign(this.tenants.get(id), {paidUntil, status: 'active'}); }
  async setIntegrationTokenEnc(id, enc) { const t = this.tenants.get(id); if (t) t.integrationTokenEnc = enc; }
  async putToken(hash, tenantId, kind) { this.tokens.set(hash, {tenantId, kind, revoked: false}); }
  async tokenTenant(hash, kind) { const t = this.tokens.get(hash); return t && t.kind === kind && !t.revoked ? t.tenantId : null; }
  async revokeTokens(tenantId, kind) { for (const t of this.tokens.values()) if (t.tenantId === tenantId && t.kind === kind) t.revoked = true; }
  async chat(chatId) { const c = this.chats.get(String(chatId)); return c ? {...c} : null; }
  async setChat(chatId, tenantId, state) { this.chats.set(String(chatId), {tenantId, state}); }
  async unbindChat(chatId) { this.chats.delete(String(chatId)); }
  async chatForTenant(tenantId) { for (const [cid, c] of this.chats) if (c.tenantId === tenantId) return cid; return null; }
  async settings(tenantId) { return {...(this.prefs.get(tenantId) || {})}; }
  async saveSettings(tenantId, patch) { this.prefs.set(tenantId, {...(this.prefs.get(tenantId) || {}), ...patch}); }
  async payment(id) { return this.payments.get(id) || null; }
  async recordPayment(p) { this.payments.set(p.id, {tenantId: p.tenantId}); }
  async createInvite(i) { this.invites.set(i.hash, {id: i.id, plan: i.plan, days: i.days, note: i.note ?? null, createdAt: now(), expiresAt: i.expiresAt, revokedAt: null, usedAt: null, tenantId: null, usedByChat: null}); }
  async invite(hash) { const i = this.invites.get(hash); return i ? {...i} : null; }
  async claimInvite(hash, tenantId, chatId) {
    const i = this.invites.get(hash);
    if (!i || i.usedAt || i.revokedAt) return false;
    Object.assign(i, {usedAt: now(), tenantId, usedByChat: String(chatId)});
    return true;
  }
  async listInvites(limit) { return [...this.invites.values()].reverse().slice(0, limit).map(i => ({...i})); }
  async revokeInvite(id) {
    const i = [...this.invites.values()].find(x => x.id === id);
    if (!i || i.usedAt || i.revokedAt) return false;
    i.revokedAt = now(); return true;
  }
  async createAgent(tenantId, name) { const id = crypto.randomUUID().slice(0, 8); this.agents.set(id, {id, tenantId, name}); return {id, name}; }
  async listAgents(tenantId) { return [...this.agents.values()].filter(a => a.tenantId === tenantId).map(a => ({id: a.id, name: a.name})); }
  async social(tenantId, userId) { const s = this.socialsMap.get(tenantId + ':' + userId); return s ? {userId: s.userId, label: s.label, agentId: s.agentId} : null; }
  async addSocial(tenantId, userId, label) { this.socialsMap.set(tenantId + ':' + String(userId), {tenantId, userId: String(userId), label: label ?? null, agentId: null}); }
  async setSocialLabel(tenantId, userId, label) { const s = this.socialsMap.get(tenantId + ':' + userId); if (s) s.label = label; }
  async assignSocial(tenantId, userId, agentId) { const s = this.socialsMap.get(tenantId + ':' + userId); if (s) s.agentId = agentId; }
  async listSocials(tenantId) { return [...this.socialsMap.values()].filter(s => s.tenantId === tenantId).map(s => ({userId: s.userId, label: s.label, agentId: s.agentId})); }
  async deleteSocial(tenantId, userId) { this.socialsMap.delete(tenantId + ':' + String(userId)); }
}
