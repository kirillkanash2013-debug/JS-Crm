// Transport-independent report contract. Never publish a truncated financial report.
export const rowsOf = raw => Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.data?.rows) ? raw.data.rows : null;
export async function fetchKeitaroReport(post, {from, to, timezone, subIndex = 4, conversionsOnly=false, pageLimit=1000, maxPages=100, budgetMs=240000, extraColumns=[], resume=false, startOffset=0, anchor=null} = {}) {
  if (!Number.isInteger(subIndex) || subIndex < 1 || subIndex > 30) return {result:'unreachable',reason:'invalid_sub_index'};
  if(!Number.isInteger(pageLimit)||pageLimit<1||pageLimit>1000||!Number.isInteger(maxPages)||maxPages<1||maxPages>100||!Number.isInteger(budgetMs)||budgetMs<1||budgetMs>240000)return {result:'unreachable',reason:'invalid_report_bounds'};
  if(!Array.isArray(extraColumns)||extraColumns.some(c=>!OPTIONAL_CONVERSION_COLUMNS.includes(c)))return {result:'unreachable',reason:'invalid_source_columns'};
  if(!Number.isSafeInteger(startOffset)||startOffset<0||startOffset>0&&(!resume||!conversionsOnly||typeof anchor!=='string')||resume&&!conversionsOnly)return {result:'unreachable',reason:'invalid_report_checkpoint'};
  const sub='sub_id_'+subIndex, range={from,to,timezone}, limit=pageLimit;
  const deadline=Date.now()+budgetMs;
  const read=async (path,payload)=>{
    const all=[], fingerprints=new Set();let offset=resume?startOffset:0,nextAnchor=anchor;
    const partial=reason=>resume?{result:'incomplete',reason,rows:all,nextOffset:offset,anchor:nextAnchor}:{result:'incomplete',reason};
    for(let page=0;page<maxPages;page++){
      if(Date.now()>=deadline)return partial('report_deadline');
      // Re-read one boundary row to detect offset drift or a provider ignoring offset.
      const overlap=resume&&page===0&&startOffset>0;
      let r;try{r=await boundedPost(post,path,{...payload,limit,offset:overlap?offset-1:offset},deadline-Date.now());}catch(e){if(resume)return partial('source_request_failed');throw e;}
      if(r.result!=='ok')return resume?partial(r.reason||'source_request_failed'):r;
      let rows=rowsOf(r.json);
      if(!rows||rows.length>limit)return partial('unexpected_rows');
      const fingerprint=JSON.stringify(rows);
      if(rows.length && fingerprints.has(fingerprint))return partial('pagination_repeated');
      fingerprints.add(fingerprint);
      const received=rows.length;
      if(overlap){
        if(!rows.length||conversionAnchor(rows[0])!==anchor)return partial('checkpoint_boundary_changed');
        rows=rows.slice(1);
      }
      all.push(...rows);offset+=rows.length;
      if(rows.length)nextAnchor=conversionAnchor(rows.at(-1));
      const rawTotal=r.json?.total ?? r.json?.total_count ?? r.json?.data?.total;
      const total=rawTotal==null?NaN:Number(rawTotal);
      if(Number.isFinite(total)&&offset>=total||received<limit&&!Number.isFinite(total))return {result:'ok',rows:all,nextOffset:offset,anchor:nextAnchor};
      if(!rows.length)return partial('pagination_stalled');
    }
    return partial('pagination_limit');
  };
  const build=conversionsOnly?{result:'ok',rows:[]}:await read('/admin_api/v1/report/build',{range,columns:['campaign_id','campaign',sub,'offer'],metrics:['clicks','campaign_unique_clicks','conversions','sales','sale_revenue'],grouping:['campaign_id','campaign',sub,'offer'],filters:[]});
  if(build.result!=='ok')return build;
  const log=await read('/admin_api/v1/conversions/log',{range,columns:['conversion_id','sub_id','campaign_id','campaign','offer','revenue','status','click_datetime','postback_datetime',sub,...extraColumns],filters:[],sort:[{name:'postback_datetime',order:'ASC'},{name:'conversion_id',order:'ASC'}]});
  if(log.result!=='ok')return resume?{...log,rows:undefined,complete:false,conversions:log.rows||[]}:log;
  return {result:'ok',complete:true,report:build.rows,conversions:log.rows,capabilities:conversionCapabilities(log.rows,subIndex),...(resume?{nextOffset:log.nextOffset,anchor:log.anchor}:{})};
}

// Money and attribution corrections do not change a page boundary identity.
const conversionAnchor=r=>JSON.stringify([r.conversion_id??r.sub_id,r.postback_datetime,r.status,r.offer]);

export const OPTIONAL_CONVERSION_COLUMNS=['sale_datetime','country_code','currency','revenue_currency','payout_currency','tid','params'];
export function conversionCapabilities(rows,subIndex){
 const fields=['conversion_id','click_datetime','postback_datetime','sub_id_'+subIndex,...OPTIONAL_CONVERSION_COLUMNS];
 return {sample_rows:rows.length,fields:Object.fromEntries(fields.map(f=>[f,{returned:rows.some(r=>Object.hasOwn(r,f)),non_null:rows.some(r=>r[f]!==null&&r[f]!==undefined&&r[f]!=='')}]))};
}
async function boundedPost(post,path,payload,budgetMs){
 if(budgetMs<=0)return {result:'incomplete',reason:'report_deadline'};
 let timer;try{return await Promise.race([post(path,payload),new Promise(resolve=>{timer=setTimeout(()=>resolve({result:'incomplete',reason:'report_deadline'}),budgetMs);})]);}finally{clearTimeout(timer);}
}
// Read-only, bounded schema probe. HTTP errors are classified, never returned verbatim.
export async function probeKeitaroConversions(post,{day,timezone,subIndex=4,budgetMs=20000}={}){
 if(!Number.isInteger(subIndex)||subIndex<1||subIndex>30)return {result:'unreachable',reason:'invalid_sub_index'};
 const deadline=Date.now()+Math.min(Math.max(budgetMs,1),20000),sub='sub_id_'+subIndex;
 const base=['conversion_id','sub_id','click_datetime','postback_datetime',sub,'status','revenue'];
 const request=columns=>boundedPost(post,'/admin_api/v1/conversions/log',{range:{from:day,to:day,timezone},columns,limit:1,offset:0,filters:[],sort:[{name:'conversion_id',order:'DESC'}]},deadline-Date.now());
 const baseline=await request(base);if(baseline.result!=='ok')return {result:baseline.result,status:baseline.status,reason:baseline.reason};
 const rows=rowsOf(baseline.json);if(!rows)return {result:'incomplete',reason:'unexpected_rows'};
 const columns={};for(const field of OPTIONAL_CONVERSION_COLUMNS){
  const r=await request([...base,field]);
  columns[field]=r.result==='ok'&&rowsOf(r.json)!==null?'accepted':r.status===400||r.status===406?'unsupported':'unknown';
  if(r.result==='ok'&&rowsOf(r.json))rows.push(...rowsOf(r.json));
  if(Date.now()>=deadline)break;
 }
 return {result:'ok',read_only:true,columns,observed:conversionCapabilities(rows,subIndex)};
}
