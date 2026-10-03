// Implementation policy, deliberately not a permanent business contract.
export const RETRY_LIMIT=3;
export const backoff=attempt=>10000*2**Math.max(0,attempt-1);
export const active=c=>(c.lifecycle_status||'active')==='active';
export {authReason,transient} from '../../shared/collection-errors.mjs';
export function lifecycle(c,status,reason=null){c.lifecycle_status=status;c.auth_issue_reason=reason;c.lifecycle_updated_at=new Date().toISOString();}
export function normalize(state){
 for(const c of Object.values(state.connections))if(!c.lifecycle_status){
  const last=state.jobs.filter(j=>j.userId===c.userId&&!j.action&&j.kind!=='import').at(-1);
  lifecycle(c,last?.state==='needs_auth'?'needs_auth':'active',last?.state==='needs_auth'?'unknown_auth_error':null);
 }
 state.cycles??=[];
 if(!state.cycles.some(c=>c.result==='processing'))state.pendingRefresh=false;
}
