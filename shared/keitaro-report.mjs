// Transport-independent report contract. Never publish a truncated financial report.
export const rowsOf = raw => Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.data?.rows) ? raw.data.rows : null;
export async function fetchKeitaroReport(post, {from, to, timezone, subIndex = 4} = {}) {
  if (!Number.isInteger(subIndex) || subIndex < 1 || subIndex > 30) return {result:'unreachable',reason:'invalid_sub_index'};
  const sub='sub_id_'+subIndex, range={from,to,timezone}, limit=1000, maxPages=100;
  const deadline=Date.now()+4*60000;
  const read=async (path,payload)=>{
    const all=[], fingerprints=new Set();
    for(let page=0;page<maxPages;page++){
      if(Date.now()>=deadline)return {result:'incomplete',reason:'report_deadline'};
      const r=await post(path,{...payload,limit,offset:all.length});
      if(r.result!=='ok')return r;
      const rows=rowsOf(r.json);
      if(!rows)return {result:'incomplete',reason:'unexpected_rows'};
      const fingerprint=JSON.stringify(rows);
      if(rows.length && fingerprints.has(fingerprint))return {result:'incomplete',reason:'pagination_repeated'};
      fingerprints.add(fingerprint); all.push(...rows);
      const total=Number(r.json?.total ?? r.json?.total_count ?? r.json?.data?.total);
      if(rows.length<limit && (!Number.isFinite(total)||all.length>=total))return {result:'ok',rows:all};
      if(!rows.length)return {result:'incomplete',reason:'pagination_stalled'};
    }
    return {result:'incomplete',reason:'pagination_limit'};
  };
  const build=await read('/admin_api/v1/report/build',{range,columns:['campaign_id','campaign',sub,'offer'],metrics:['clicks','campaign_unique_clicks','conversions','sales','sale_revenue'],grouping:['campaign_id','campaign',sub,'offer'],filters:[]});
  if(build.result!=='ok')return build;
  const log=await read('/admin_api/v1/conversions/log',{range,columns:['conversion_id','sub_id','campaign_id','campaign','offer','revenue','status','click_datetime','postback_datetime',sub],filters:[],sort:[{name:'postback_datetime',order:'ASC'},{name:'conversion_id',order:'ASC'}]});
  if(log.result!=='ok')return log;
  return {result:'ok',complete:true,report:build.rows,conversions:log.rows};
}
