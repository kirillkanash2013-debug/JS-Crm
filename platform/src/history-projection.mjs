// Source-local calendar dates only: no ingestion-day or inferred timezone fallback.
export function eventDay(fact) {
 const value=fact.kind==='registration'?fact.registration_at:fact.kind==='ftd'?fact.ftd_at:fact.conversion_at;
 const match=/^(\d{4}-\d{2}-\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)$/.exec(String(value||''));
 if(!match)return null;
 const time=String(value).slice(11,19).split(':').map(Number);if(time[0]>23||time[1]>59||time.length>2&&time[2]>59)return null;
 const day=match[1],date=new Date(day+'T00:00:00Z');
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===day?day:null;
}
// Exact decimal addition; never combine currencies or coerce missing payout to zero.
function decimal(value) {
 const m=/^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(value).replace(/^([+-]?)\./,(_,sign)=>sign+'0.'));
 if(!m)return null;
 const exponent=Number(m[4]||0);if(Math.abs(exponent)>100)return null;
 const fraction=m[3]||'',scale=fraction.length-exponent;
 return {n:BigInt((m[1]==='-'?'-':'')+m[2]+fraction)*(scale<0?10n**BigInt(-scale):1n),scale:Math.max(0,scale)};
}
function add(a,b){const scale=Math.max(a.scale,b.scale);return {n:a.n*10n**BigInt(scale-a.scale)+b.n*10n**BigInt(scale-b.scale),scale};}
function format({n,scale}){const sign=n<0n?'-':'',digits=(n<0n?-n:n).toString().padStart(scale+1,'0');return sign+(scale?(digits.slice(0,-scale)+'.'+digits.slice(-scale)).replace(/\.?0+$/,''):digits);}
export function projectDailyFacts(events,{from,to}={}) {
 const groups=new Map();let undated=0;
 for(const event of events){
  const f=event.fact,day=eventDay(f);if(!day){undated++;continue;}if(from&&day<from||to&&day>to)continue;
  const key=JSON.stringify([day,event.campaign_id||null,event.state,f.currency]);
  let g=groups.get(key);if(!g){g={day,campaign_id:event.campaign_id||null,attribution:event.state,currency:f.currency??null,reg:0,ftd:0,revenue_events:0,unknown_amounts:0,sum:{n:0n,scale:0}};groups.set(key,g);}
  if(f.kind==='registration')g.reg++;
  if(f.kind==='ftd'){
   g.ftd++;g.revenue_events++;const amount=f.amount==null?null:decimal(f.amount);
   if(amount)g.sum=add(g.sum,amount);else g.unknown_amounts++;
  }
 }
 const days=[...groups.values()].map(({sum,...g})=>({...g,revenue:{amount:!g.revenue_events||g.unknown_amounts?null:format(sum),currency:g.currency,known_amount:g.revenue_events?format(sum):null,unknown_amounts:g.unknown_amounts}}));
 days.sort((a,b)=>JSON.stringify([a.day,a.campaign_id,a.attribution,a.currency]).localeCompare(JSON.stringify([b.day,b.campaign_id,b.attribution,b.currency])));
 return {days,undated};
}
