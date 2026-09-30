// Runs locally in Ads Manager's MAIN world. Returns credentials only to the
// extension service worker; never exports scripts, cookies, or request bodies.
export function inspectAdsSession() {
  const u=new URL(location.href);
  if(u.protocol!=="https:" || !["adsmanager.facebook.com","business.facebook.com","www.facebook.com"].includes(u.hostname) ||
    (u.hostname!=="adsmanager.facebook.com" && !/^\/adsmanager(?:\/|$)/.test(u.pathname))) throw new Error("Откройте Ads Manager.");
  let userId="",displayName="";
  const candidates=[],seen=new Set();
  const diagnostics={adapterVersion:4,userModuleAvailable:false,adsModuleAvailable:false,configModuleAvailable:false,moduleChecks:[],scriptCount:0,inlineBytesScanned:0,candidateCount:0};
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
  // Different Ads Manager builds expose the configuration separately from
  // AdsPEGlobal. Check only named advertising configs, never enumerate globals.
  for(const name of ["AdsAPIConfig","AdsPEGlobal"]){
    let available=false;
    try {
      if(typeof globalThis.require==="function"){
        const config=globalThis.require(name);
        available=!!config;
        if(name==="AdsPEGlobal")diagnostics.adsModuleAvailable=available;
        if(name==="AdsAPIConfig")diagnostics.configModuleAvailable=available;
        add(config?.accessToken,name+".accessToken");
        add(config?.access_token,name+".access_token");
      }
    }catch{}
    diagnostics.moduleChecks.push({name,available});
  }
  if(globalThis.adsplugver && typeof globalThis.privateToken==="string")add(globalThis.privateToken,"fbacc-local-context");
  add(globalThis.__accessToken,"adsmanager-accessToken");
  const scripts=Array.from(document.querySelectorAll("script:not([src])"));
  scripts.sort((a,b)=>Number((b.textContent || "").includes("window.__accessToken"))-Number((a.textContent || "").includes("window.__accessToken")));
  for(const script of scripts){
    const source=script.textContent || "";
    diagnostics.scriptCount++;
    if(source.length>1000000 || diagnostics.inlineBytesScanned+source.length>4000000)continue;
    diagnostics.inlineBytesScanned+=source.length;
    // FBacc searches quoted EA values in the already loaded inline payload.
    // Only two candidates are retained; each must pass owner validation.
    if(!userId){
      const user=source.match(/"USER_ID"\s*:\s*"(\d{3,30})"/);
      if(user)userId=user[1];
    }
    // Boot payloads can wrap config JSON in a JSON string. Unwrap quotes
    // locally; only exact named credential fields are accepted.
    for(const match of source.matchAll(/["'](EA[A-Za-z0-9]{20,4094})["']/g))add(match[1],"loaded-script-ea");
    for(const payload of [source,source.replace(/\\"/g,'"')]){
      for(const m of payload.matchAll(/["'](?:accessToken|access_token)["']\s*:\s*["'](EA[A-Za-z0-9_-]{18,4094})["']/g))add(m[1],"loaded-script-field");
    }
  }
  diagnostics.candidateCount=candidates.length;
  return {userId,displayName,candidates,diagnostics};
}
