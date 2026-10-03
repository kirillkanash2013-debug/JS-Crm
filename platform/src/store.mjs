// Storage behind one small interface: D1 in production, memory in tests.
const now = () => new Date().toISOString();

export class D1Store {
  constructor(db) { this.db = db; }
  async statsSnapshot(tenantId){return this.db.prepare('SELECT enc,completed_at AS completedAt FROM stats_snapshots WHERE tenant_id=?').bind(tenantId).first();}
  async claimStatsCycle(tenantId,owner){const r=await this.db.prepare('INSERT INTO stats_snapshots(tenant_id,lock_owner,lease_until) VALUES(?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET lock_owner=excluded.lock_owner,lease_until=excluded.lease_until WHERE stats_snapshots.lease_until<?').bind(tenantId,owner,Date.now()+600000,Date.now()).run();return r.meta?.changes===1;}
  async saveStatsSnapshot(tenantId,owner,enc,completedAt){const r=await this.db.prepare('UPDATE stats_snapshots SET enc=?,completed_at=? WHERE tenant_id=? AND lock_owner=? AND lease_until>?').bind(enc,completedAt,tenantId,owner,Date.now()).run();return r.meta?.changes===1;}
  async releaseStatsCycle(tenantId,owner){await this.db.prepare('UPDATE stats_snapshots SET lock_owner=NULL,lease_until=0 WHERE tenant_id=? AND lock_owner=?').bind(tenantId,owner).run();}
  async createStarsOrder(o){await this.db.prepare('INSERT INTO stars_orders(id,chat_id,tenant_id,plan,amount,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(o.id,String(o.chatId),o.tenantId||null,o.plan,o.amount,now(),o.expiresAt).run();}
  async starsOrder(id){return this.db.prepare('SELECT id,chat_id AS chatId,tenant_id AS tenantId,plan,amount,expires_at AS expiresAt FROM stars_orders WHERE id=?').bind(id).first();}
  async claimOwner(id,chatId){const r=await this.db.prepare('UPDATE tenants SET owner_chat_id=? WHERE id=? AND (owner_chat_id IS NULL OR owner_chat_id=?)').bind(String(chatId),id,String(chatId)).run();return r.meta?.changes===1;}
  async commitPayment(p,t,token){
    const exists=await this.payment(p.id);if(exists)return {tenant:await this.tenant(exists.tenantId),duplicate:true};
    const statements=[];
    if(!p.renewal)statements.push(this.db.prepare("INSERT INTO tenants(id,name,plan,social_limit,status,paid_until,created_at,integration_token_enc) SELECT ?,?,?,?,'active',?,?,? WHERE NOT EXISTS(SELECT 1 FROM payments WHERE id=?)").bind(t.id,t.name,t.plan,t.socialLimit,t.paidUntil,now(),token?.enc??null,p.id));
    statements.push(this.db.prepare('INSERT OR IGNORE INTO payments(id,tenant_id,provider,amount,currency,created_at,applied) VALUES(?,?,?,?,?,?,0)').bind(p.id,t.id,p.provider,String(p.amount??''),p.currency??null,now()));
    if(p.renewal)statements.push(this.db.prepare("UPDATE tenants SET paid_until=date(CASE WHEN paid_until>=? THEN paid_until ELSE ? END, ?),status='active' WHERE id=? AND EXISTS(SELECT 1 FROM payments WHERE id=? AND tenant_id=? AND applied=0)").bind(p.today,p.today,'+'+p.days+' days',t.id,p.id,t.id));
    if(token)statements.push(this.db.prepare("INSERT OR IGNORE INTO access_tokens(hash,tenant_id,kind,created_at) SELECT ?,?,'integration',? WHERE EXISTS(SELECT 1 FROM payments WHERE id=? AND tenant_id=? AND applied=0)").bind(token.hash,t.id,now(),p.id,t.id));
    statements.push(this.db.prepare('UPDATE payments SET applied=1 WHERE id=? AND tenant_id=? AND applied=0').bind(p.id,t.id));
    const results=await this.db.batch(statements),applied=results.at(-1).meta?.changes===1;
    const payment=await this.payment(p.id);return {tenant:await this.tenant(payment.tenantId),duplicate:!applied};
  }
  async claimUpdate(id){const r=await this.db.prepare("INSERT INTO webhook_updates(id,state,lease_until,updated_at) VALUES(?,'processing',?,?) ON CONFLICT(id) DO UPDATE SET state='processing',lease_until=excluded.lease_until,updated_at=excluded.updated_at WHERE webhook_updates.state!='done' AND webhook_updates.lease_until<?").bind(String(id),Date.now()+300000,now(),Date.now()).run();return r.meta?.changes===1;}
  async finishUpdate(id,success){await this.db.prepare('UPDATE webhook_updates SET state=?,lease_until=?,updated_at=? WHERE id=?').bind(success?'done':'retry',success?Date.now()+7*864e5:0,now(),String(id)).run();}
  async setServiceMessages(tenantId,on){await this.saveSettings(tenantId,{});await this.db.prepare('UPDATE settings SET service_messages=? WHERE tenant_id=?').bind(on?1:0,tenantId).run();}
  async setStatsMessage(tenantId,id){await this.saveSettings(tenantId,{});await this.db.prepare('UPDATE settings SET stats_msg_id=? WHERE tenant_id=?').bind(String(id),tenantId).run();}
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
  async chatForTenant(tenantId) { const r = await this.db.prepare('SELECT c.chat_id FROM chats c JOIN tenants t ON t.id=c.tenant_id WHERE c.tenant_id=? AND (t.owner_chat_id IS NULL OR c.chat_id=t.owner_chat_id) ORDER BY c.updated_at DESC LIMIT 1').bind(tenantId).first(); return r ? r.chat_id : null; }
  async settings(tenantId) {
    const r = await this.db.prepare('SELECT * FROM settings WHERE tenant_id=?').bind(tenantId).first();
    return r ? {statsMsgId:r.stats_msg_id??null,serviceMessages:r.service_messages??1,keitaroUrl: r.keitaro_url, keitaroKeyEnc: r.keitaro_key_enc, keitaroSub: r.keitaro_sub, timezone: r.timezone, currency: r.currency, onboardedAt: r.onboarded_at, notifyOnUpdate: r.notify_on_update ? 1 : 0, refreshMinutes: r.refresh_minutes ?? null} : {};
  }
  async saveSettings(tenantId, patch) {
    const s = {...await this.settings(tenantId), ...patch};
    await this.db.prepare('INSERT INTO settings (tenant_id,keitaro_url,keitaro_key_enc,keitaro_sub,timezone,currency,onboarded_at,notify_on_update,refresh_minutes) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET keitaro_url=excluded.keitaro_url, keitaro_key_enc=excluded.keitaro_key_enc, keitaro_sub=excluded.keitaro_sub, timezone=excluded.timezone, currency=excluded.currency, onboarded_at=excluded.onboarded_at, notify_on_update=excluded.notify_on_update, refresh_minutes=excluded.refresh_minutes')
      .bind(tenantId, s.keitaroUrl ?? null, s.keitaroKeyEnc ?? null, s.keitaroSub ?? null, s.timezone ?? null, s.currency ?? null, s.onboardedAt ?? null, s.notifyOnUpdate ? 1 : 0, s.refreshMinutes ?? null).run();
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
  async deleteAgent(tenantId, agentId) { await this.db.prepare('UPDATE socials SET agent_id=NULL WHERE tenant_id=? AND agent_id=?').bind(tenantId, agentId).run(); await this.db.prepare('DELETE FROM agents WHERE tenant_id=? AND id=?').bind(tenantId, agentId).run(); }
  async listAgents(tenantId) { const r = await this.db.prepare('SELECT id,name FROM agents WHERE tenant_id=? ORDER BY name').bind(tenantId).all(); return (r.results || []).map(a => ({id: a.id, name: a.name})); }
  async social(tenantId, userId) { const r = await this.db.prepare('SELECT user_id AS userId, label, agent_id AS agentId, notify_msg_id AS notifyMsgId, fb_name AS fbName, rk, rk_personal AS rkPersonal, bm, fp, collected_at AS collectedAt FROM socials WHERE tenant_id=? AND user_id=?').bind(tenantId, String(userId)).first(); return r ? socialRow(r) : null; }
  async addSocial(tenantId, userId, label) { await this.db.prepare('INSERT INTO socials (tenant_id,user_id,label,seen_at) VALUES (?,?,?,?)').bind(tenantId, String(userId), label ?? null, now()).run(); }
  async setSocialLabel(tenantId, userId, label) { await this.db.prepare('UPDATE socials SET label=? WHERE tenant_id=? AND user_id=?').bind(label, tenantId, String(userId)).run(); }
  async setSocialNotifyMsg(tenantId, userId, msgId) { await this.db.prepare('UPDATE socials SET notify_msg_id=? WHERE tenant_id=? AND user_id=?').bind(msgId == null ? null : String(msgId), tenantId, String(userId)).run(); }
  async setSocialStats(tenantId, userId, {rk, rkPersonal, bm, fp, collectedAt, fbName}) { await this.db.prepare('UPDATE socials SET fb_name=COALESCE(?,fb_name), rk=?, rk_personal=?, bm=?, fp=?, collected_at=? WHERE tenant_id=? AND user_id=?').bind(fbName ?? null, rk ?? null, rkPersonal ?? null, bm ?? null, fp ?? null, collectedAt ?? null, tenantId, String(userId)).run(); }
  async assignSocial(tenantId, userId, agentId) { await this.db.prepare('UPDATE socials SET agent_id=? WHERE tenant_id=? AND user_id=?').bind(agentId, tenantId, String(userId)).run(); }
  async listSocials(tenantId) { const r = await this.db.prepare('SELECT user_id AS userId, label, agent_id AS agentId, notify_msg_id AS notifyMsgId, fb_name AS fbName, rk, rk_personal AS rkPersonal, bm, fp, collected_at AS collectedAt FROM socials WHERE tenant_id=?').bind(tenantId).all(); return (r.results || []).map(socialRow); }
  async deleteSocial(tenantId, userId) { await this.db.prepare('DELETE FROM socials WHERE tenant_id=? AND user_id=?').bind(tenantId, String(userId)).run(); }
}

const inviteRow = r => ({id: r.id, plan: r.plan, days: r.days, note: r.note, createdAt: r.created_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, usedAt: r.used_at, tenantId: r.tenant_id, usedByChat: r.used_by_chat});
const socialRow = s => ({userId: s.userId, label: s.label, agentId: s.agentId, notifyMsgId: s.notifyMsgId ?? null, fbName: s.fbName ?? null, rk: s.rk ?? null, rkPersonal: s.rkPersonal ?? null, bm: s.bm ?? null, fp: s.fp ?? null, collectedAt: s.collectedAt ?? null});

export class MemoryStore {
  constructor() { this.tenants = new Map(); this.tokens = new Map(); this.chats = new Map(); this.prefs = new Map(); this.payments = new Map(); this.invites = new Map(); this.agents = new Map(); this.socialsMap = new Map(); }
  async statsSnapshot(tenantId){return this.snapshots?.get(tenantId)||null;}
  async claimStatsCycle(tenantId,owner){this.snapshots??=new Map();const r=this.snapshots.get(tenantId)||{};if(r.leaseUntil>Date.now())return false;this.snapshots.set(tenantId,{...r,owner,leaseUntil:Date.now()+600000});return true;}
  async saveStatsSnapshot(tenantId,owner,enc,completedAt){const r=this.snapshots.get(tenantId);if(r?.owner!==owner||r.leaseUntil<=Date.now())return false;Object.assign(r,{enc,completedAt});return true;}
  async releaseStatsCycle(tenantId,owner){const r=this.snapshots.get(tenantId);if(r?.owner===owner){r.owner=null;r.leaseUntil=0;}}
  async createStarsOrder(o){this.starsOrders??=new Map();this.starsOrders.set(o.id,{...o,chatId:String(o.chatId)});}
  async starsOrder(id){return this.starsOrders?.get(id)||null;}
  async claimOwner(id,chatId){const t=this.tenants.get(id);if(!t||(t.ownerChatId&&t.ownerChatId!==String(chatId)))return false;t.ownerChatId=String(chatId);return true;}
  async commitPayment(p,t,token){
    const exists=this.payments.get(p.id);if(exists)return {tenant:{...this.tenants.get(exists.tenantId)},duplicate:true};
    if(p.renewal){const old=this.tenants.get(t.id);const d=new Date((old.paidUntil>=p.today?old.paidUntil:p.today)+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+p.days);old.paidUntil=d.toISOString().slice(0,10);old.status='active';}
    else this.tenants.set(t.id,{...t,status:'active',integrationTokenEnc:token?.enc??null});
    if(token)this.tokens.set(token.hash,{tenantId:t.id,kind:'integration',revoked:false});
    this.payments.set(p.id,{tenantId:t.id});return {tenant:{...this.tenants.get(t.id)},duplicate:false};
  }
  async claimUpdate(id){this.updates??=new Map();const previous=this.updates.get(String(id));if(previous&&(previous.state==='done'||previous.until>Date.now()))return false;this.updates.set(String(id),{state:'processing',until:Date.now()+300000});return true;}
  async finishUpdate(id,success){this.updates.set(String(id),{state:success?'done':'retry',until:0});}
  async setServiceMessages(tenantId,on){await this.saveSettings(tenantId,{serviceMessages:on?1:0});}
  async setStatsMessage(tenantId,id){await this.saveSettings(tenantId,{statsMsgId:String(id)});}
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
  async deleteAgent(tenantId, agentId) { for (const s of this.socialsMap.values()) if (s.tenantId === tenantId && s.agentId === agentId) s.agentId = null; const a = this.agents.get(agentId); if (a && a.tenantId === tenantId) this.agents.delete(agentId); }
  async listAgents(tenantId) { return [...this.agents.values()].filter(a => a.tenantId === tenantId).map(a => ({id: a.id, name: a.name})); }
  async social(tenantId, userId) { const s = this.socialsMap.get(tenantId + ':' + userId); return s ? socialRow(s) : null; }
  async addSocial(tenantId, userId, label) { this.socialsMap.set(tenantId + ':' + String(userId), {tenantId, userId: String(userId), label: label ?? null, agentId: null, notifyMsgId: null, fbName: null, rk: null, rkPersonal: null, bm: null, fp: null, collectedAt: null}); }
  async setSocialLabel(tenantId, userId, label) { const s = this.socialsMap.get(tenantId + ':' + userId); if (s) s.label = label; }
  async setSocialNotifyMsg(tenantId, userId, msgId) { const s = this.socialsMap.get(tenantId + ':' + userId); if (s) s.notifyMsgId = msgId == null ? null : String(msgId); }
  async setSocialStats(tenantId, userId, {rk, rkPersonal, bm, fp, collectedAt, fbName}) { const s = this.socialsMap.get(tenantId + ':' + userId); if (s) Object.assign(s, {rk: rk ?? null, rkPersonal: rkPersonal ?? null, bm: bm ?? null, fp: fp ?? null, collectedAt: collectedAt ?? null, fbName: fbName ?? s.fbName ?? null}); }
  async assignSocial(tenantId, userId, agentId) { const s = this.socialsMap.get(tenantId + ':' + userId); if (s) s.agentId = agentId; }
  async listSocials(tenantId) { return [...this.socialsMap.values()].filter(s => s.tenantId === tenantId).map(socialRow); }
  async deleteSocial(tenantId, userId) { this.socialsMap.delete(tenantId + ':' + String(userId)); }
}
