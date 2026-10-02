import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
test("MV3 entry points and minimal permissions match installed package",()=>{
  const m=JSON.parse(fs.readFileSync(path.join(root,"manifest.json"),"utf8"));
  assert.equal(m.manifest_version,3);assert.equal(m.background.type,"module");
  for(const name of [m.background.service_worker,m.action.default_popup])assert(fs.existsSync(path.join(root,name)));
  assert.deepEqual(m.optional_host_permissions,["https://graph.facebook.com/*","https://adsmanager.facebook.com/*","https://business.facebook.com/*","https://www.facebook.com/*","https://*.facebook.com/*","https://*/*"]);
  assert.deepEqual(m.optional_permissions,["cookies"]);
  assert(m.permissions.includes("webRequest"));
  for(const forbidden of ["cookies","proxy","debugger","webRequestBlocking"])assert(!m.permissions.includes(forbidden));
  const html=fs.readFileSync(path.join(root,"panel.html"),"utf8");
  assert(!/\son\w+=/.test(html));assert(!/<script[^>]+src=["\']https?:/.test(html));
  for(const name of ["panel.mjs","panel.css"])assert(html.includes(name));
});
