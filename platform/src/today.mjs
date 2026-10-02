// Builds the «Сейчас» report (FB spend ↔ Keitaro revenue/ROI) exactly like the
// prod CRM: top totals + per-campaign block. Pure functions — the bot fetches
// FB spend (collector) and Keitaro rows (KEITARO_BRIDGE) and passes them here.
// Join key: the sub_id the client configured (settings.keitaroSub) carries the
// Facebook campaign id, matched to the collector's campaignId.

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const money = n => '$' + (Math.round(n * 100) / 100).toFixed(2);
const round2 = n => Math.round(n * 100) / 100;
const roiPct = (rev, spend) => spend > 0 ? (rev / spend - 1) * 100 : 0;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const per = (total, count) => count > 0 ? (total / count).toFixed(2) : '—';

// 'YYYY-MM-DD' → 'DD.MM.YYYY'
function fmtDate(day) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || '')); return m ? m[3] + '.' + m[2] + '.' + m[1] : String(day || ''); }

// Keitaro rows → per-FB-campaign metrics, keyed by the campaign id in sub_id_N.
// Inst = unique clicks (report/build); Reg = status 'lead', Dep/Rev = status
// 'sale' (conversions/log, authoritative). A sale whose click was on an earlier
// day than `day` is a долёт, kept apart for the bracketed → Rev/ROI.
export function aggregateKeitaro({report = [], conversions = []} = {}, {subIndex = 4, day} = {}) {
  const sub = 'sub_id_' + subIndex;
  const by = {};
  const get = id => (by[id] = by[id] || {inst: 0, reg: 0, dep: 0, rev: 0, doletDep: 0, doletRev: 0, name: '', offer: ''});
  for (const r of report) {
    const id = String(r[sub] ?? '').trim(); if (!id) continue;
    const c = get(id);
    c.inst += num(r.campaign_unique_clicks ?? r.clicks);
    if (!c.name && r.campaign) c.name = String(r.campaign);
    if (!c.offer && r.offer) c.offer = String(r.offer);
  }
  for (const r of conversions) {
    const id = String(r[sub] ?? '').trim(); if (!id) continue;
    const c = get(id);
    const status = String(r.status ?? '').toLowerCase();
    if (status === 'lead') c.reg += 1;
    else if (status === 'sale') {
      const rev = num(r.revenue), clickDay = String(r.click_datetime ?? '').slice(0, 10);
      if (day && clickDay && clickDay !== day) { c.doletDep += 1; c.doletRev += rev; }
      else { c.dep += 1; c.rev += rev; }
    }
  }
  const totals = {inst: 0, reg: 0, dep: 0, rev: 0, doletDep: 0, doletRev: 0};
  for (const c of Object.values(by)) { c.rev = round2(c.rev); c.doletRev = round2(c.doletRev); for (const k of Object.keys(totals)) totals[k] += c[k]; }
  totals.rev = round2(totals.rev); totals.doletRev = round2(totals.doletRev);
  return {byCampaign: by, totals};
}

function topBlock({day, times, spendTotal, totals}) {
  const revAll = round2(totals.rev + totals.doletRev);
  return ['<b>📊 Сейчас · ' + esc(fmtDate(day)) + '</b>',
    '<i>JS Control ' + esc(times?.fb || '—') + ' · Keitaro ' + esc(times?.keitaro || '—') + '</i>', '',
    'Spend <b>' + money(spendTotal) + '</b>',
    'Inst <b>' + Math.round(totals.inst) + '</b> · Reg <b>' + Math.round(totals.reg) + '</b>',
    'Dep <b>' + Math.round(totals.dep) + '</b>' + (totals.doletDep ? ' +' + Math.round(totals.doletDep) + ' долёт' : ''),
    'Rev <b>' + money(totals.rev) + '</b>' + (totals.doletRev ? ' → <b>' + money(revAll) + '</b>' : ''),
    'ROI <b>' + Math.round(roiPct(totals.rev, spendTotal)) + '%</b>' + (totals.doletRev ? ' → <b>' + Math.round(roiPct(revAll, spendTotal)) + '%</b>' : '')].join('\n');
}

// 🟢 profit, 🔴 loss (has spend), ⏸ paused, ⚪ idle; ⚠️ when ad errors exist.
function campIcon(c, k) {
  const paused = c.effectiveStatus && c.effectiveStatus !== 'ACTIVE';
  const base = paused ? '⏸' : c.spend > 0 ? (roiPct(k.rev, c.spend) >= 0 ? '🟢' : '🔴') : '⚪';
  return base + (c.errorAds ? ' ⚠️' : '');
}

// One campaign: name, 💰budget 💸spend 🤑rev, then inst/CPI − reg/CPR − dep/CPA (ROI%).
function campaignLines(c, k) {
  const budget = c.dailyBudget ? Math.round(num(c.dailyBudget) / 100) : 0;
  const line1 = campIcon(c, k) + ' ' + esc(c.name || c.campaignId);
  const line2 = '💰' + budget + '$ 💸' + Math.round(c.spend) + '$ 🤑' + Math.round(k.rev) + '$';
  const line3 = Math.round(k.inst) + '/' + per(c.spend, k.inst) + '$ - ' +
    Math.round(k.reg) + '/' + per(c.spend, k.reg) + '$ - ' +
    Math.round(k.dep) + (k.dep ? '/' + per(c.spend, k.dep) + '$' : '') +
    ' (' + Math.round(roiPct(k.rev, c.spend)) + '%)';
  return line1 + '\n' + line2 + '\n' + line3;
}

// Full «Сейчас» text. campaigns: collector /v1/campaigns rows (campaignId, name,
// effectiveStatus, dailyBudget, spend, errorAds?). keitaro: aggregateKeitaro().
export function buildNow({day, times, campaigns = [], keitaro, subIndex = 4}) {
  const agg = keitaro || {byCampaign: {}, totals: {inst: 0, reg: 0, dep: 0, rev: 0, doletDep: 0, doletRev: 0}};
  const empty = {inst: 0, reg: 0, dep: 0, rev: 0, doletDep: 0, doletRev: 0};
  const spendTotal = round2(campaigns.reduce((n, c) => n + num(c.spend), 0));
  const out = [topBlock({day, times, spendTotal, totals: agg.totals})];
  const active = campaigns.filter(c => num(c.spend) > 0 || c.effectiveStatus === 'ACTIVE')
    .sort((a, b) => num(b.spend) - num(a.spend)).slice(0, 25);
  if (active.length) out.push('', 'Ⓜ️ <b>Кампании сейчас:</b>',
    active.map(c => campaignLines(c, agg.byCampaign[String(c.campaignId)] || empty)).join('\n\n'));
  return out.join('\n');
}
