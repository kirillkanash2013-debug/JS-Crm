export function authReason(code){
 return ({190:'invalid_token',102:'expired_session',identity:'wrong_identity',wrong_identity:'wrong_identity',selfie:'selfie',checkpoint:'checkpoint',verification_required:'verification_required',expired_session:'expired_session',invalid_token:'invalid_token',needs_auth:'unknown_auth_error',unknown_auth_error:'unknown_auth_error'})[code]||null;
}
export function transient(code){return [1,2,4,17,32,613,80004,'network','network_error','proxy','proxy_failed','container','container_unavailable','capacity_busy','rate_limited','rate_limit','temporary_provider_failure','timeout','fetch_failed','lease_expired'].includes(code);}

// Preserve typed collection failures across the container boundary without raw provider text.
export function collectionError(error){
 const original=error?.code;
 const code=original==='busy'?'capacity_busy':typeof original==='number'||authReason(original)||transient(original)?original:!original?(['AbortError','TimeoutError'].includes(error?.name)?'timeout':'network'):'collector_failed';
 return {code,httpStatus:Number.isInteger(error?.httpStatus)?error.httpStatus:null,transient:!!error?.transient||error?.httpStatus===429||error?.httpStatus>=500||transient(code),subcode:Number.isInteger(error?.subcode)?error.subcode:null};
}
