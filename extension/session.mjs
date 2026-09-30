// Runs locally in Ads Manager's MAIN world. Returns credentials only to the
// extension service worker; never exports scripts, cookies, or request bodies.
export function inspectAdsSession() {
  const u=new URL(location.href);
  if(u.protocol!=="https:" || !["adsmanager.facebook.com","business.facebook.com","www.facebook.com"].includes(u.hostname) ||
    (u.hostname!=="adsmanager.facebook.com" && !/^\/adsmanager(?:\/|$)/.test(u.pathname))) throw new Error("Откройте Ads Manager.");
  let userId="",displayName="";
  const candidates=[],seen=new Set();
  const diagnostics={userModuleAvailable:false,adsModuleAvailable:false,scriptCount:0,inlineBytesScanned:0,candidateCount:0};
  const add=(v,source)=>{
    if(typeof v!=="string" || !/^EA[A-Za-z0-9_-]{18,4094}$/.test(v) || seen.has(v) || candidates.length>=2)return;
    seen.add(v);candidates.push({token:v,source});
  };
  try {
    if(typeof globalThis.require==="function"){
      const current=globalThis.require("CurrentUserInitialData");
      diagnostics.userModuleAvailable=!!current;
      if(/^\d{3,30}$/.test(String(current?.USER_ID || ""))) {
        userId=String(current.USER_ID);displayName=String(current.NAME || "").slice(0,150);
      }
    }
  }catch{}
  try {
    if(typeof globalThis.require==="function"){
      const ads=globalThis.require("AdsPEGlobal");
      diagnostics.adsModuleAvailable=!!ads;
      add(ads?.accessToken,"AdsPEGlobal.accessToken");add(ads?.access_token,"AdsPEGlobal.access_token");
    }
  }catch{}
  for(const script of document.querySelectorAll("script:not([src])")){
    const source=script.textContent || "";
    diagnostics.scriptCount++;
    if(source.length>1000000 || diagnostics.inlineBytesScanned+source.length>4000000)continue;
    diagnostics.inlineBytesScanned+=source.length;
    // Only explicit credential fields in already loaded scripts; no generic
    // string/token search, no lazy network requests or session reconstruction.
    if(!userId){
      const user=source.match(/"USER_ID"\s*:\s*"(\d{3,30})"/);
      if(user)userId=user[1];
    }
    for(const m of source.matchAll(/"(?:accessToken|access_token)"\s*:\s*"(EA[A-Za-z0-9_-]{18,4094})"/g))add(m[1],"loaded-script-field");
  }
  diagnostics.candidateCount=candidates.length;
  return {userId,displayName,candidates,diagnostics};
}
