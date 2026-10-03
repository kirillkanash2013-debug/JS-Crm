// Client dashboard page. Data arrives through the summary API so the page
// can refresh itself; until the collector reports, it shows setup progress.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function dashboardSummary(tenant, settings, collector) {
  return {
    client: tenant.name, plan: tenant.plan, paidUntil: tenant.paidUntil,
    steps: [
      {title: 'Подписка оплачена', done: true},
      {title: 'Keitaro подключён', done: !!settings.keitaroKeyEnc, optional: !settings.keitaroUrl && !!settings.onboardedAt},
      {title: 'Настройки в боте заполнены', done: !!settings.onboardedAt},
      {title: 'Соц подключён в плагине', done: !!collector?.socials}
    ],
    timezone: settings.timezone || null,
    collector: collector || null
  };
}

function dataBlock(c) {
  if (!c) return '<p>Данные появятся после подключения соца в плагине и первого сбора.</p>';
  const spend = Object.entries(c.totals || {}).map(([cur, v]) => esc(v + ' ' + cur)).join(' · ') || '—';
  const socials = (c.connections || []).map(s => '<li class="done">' + esc(s.label) + ' — ' + esc(s.mode) + '</li>').join('');
  return '<p>Соцев: ' + esc(c.socials) + ' · расход за сегодня: ' + spend + (c.observedAt ? ' · последний сбор: ' + esc(c.observedAt) : '') + '</p>' + (socials ? '<ol>' + socials + '</ol>' : '');
}

export function dashboardPage(summary) {
  const steps = summary.steps.map(s => '<li class="' + (s.done ? 'done' : s.optional ? 'skip' : '') + '">' + esc(s.title) + (s.optional ? ' — пропущено' : '') + '</li>').join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>JS Control</title><style>
:root{--bg:#0c111b;--card:#141d2c;--line:#29364b;--text:#edf2fa;--muted:#aab8cc;--accent:#8fff8a}
@media (prefers-color-scheme:light){:root{--bg:#f5f7fb;--card:#fff;--line:#dde3ee;--text:#111827;--muted:#556275;--accent:#1a8f3a}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,sans-serif}main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px;font-size:24px}p{color:var(--muted);margin:0 0 20px}section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin-bottom:16px}
ol{margin:0;padding-left:22px}li{margin:6px 0;color:var(--muted)}li.done{color:var(--text)}li.done::marker{color:var(--accent)}li.skip{text-decoration:line-through}
</style></head><body><main><h1>${esc(summary.client)}</h1><p>Тариф ${esc(summary.plan)} · оплачено до ${esc(summary.paidUntil)}${summary.timezone ? ' · ' + esc(summary.timezone) : ''}</p>
<section><h2>Подключение</h2><ol>${steps}</ol></section>
<section><h2>Данные</h2>${dataBlock(summary.collector)}</section>
</main></body></html>`;
}
