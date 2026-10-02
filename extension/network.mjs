// Reads only access_token from selected-tab Graph requests; never logs URLs.
export function requestCredential(details,capture,now=Date.now()) {
  if(!capture || capture.expiresAt<=now || details.tabId!==capture.tabId)return null;
  let url,initiator;
  try{url=new URL(details.url);initiator=new URL(details.initiator);}catch{return null;}
  if(url.origin!=="https://graph.facebook.com" || initiator.origin!==capture.origin)return null;
  const values=[url.searchParams.get("access_token"),...(details.requestBody?.formData?.access_token || [])];
  const token=values.find(value=>typeof value==="string" && /^EA[A-Za-z0-9_-]{18,4094}$/.test(value));
  return {token:token || null};
}
