/** Real external HTTP OAuth resource-discovery and rejection E2E.
 * Credential free: intentionally does NOT claim a successful third-party
 * OAuth consent/token exchange without a registered Zitadel OAuth client.
 */
const BASE=process.env.DOCTOR_P1_MCP_ORIGIN || "https://doctor.qdip.ai";
if(!/^https:\/\/[a-z0-9.-]+$/.test(BASE))throw Error("INVALID_BASE_ORIGIN");
function check(ok,code){if(!ok)throw Error(code)}
async function call(path,opts={}){
 return fetch(BASE+path,{redirect:"manual",signal:AbortSignal.timeout(15000),...opts});
}
async function main(){
 let ready=false;
 for(let i=0;i<24;i++){
  try{const r=await call("/readyz");if(r.status===200){ready=true;break;}}catch{}
  await new Promise(res=>setTimeout(res,5000));
 }
 check(ready,"WORKER_NOT_READY");
 console.log("DOCTOR_EXTERNAL_MCP_SECCOMP_READY=PASS");

 for(const path of ["/.well-known/oauth-protected-resource",
                    "/.well-known/oauth-protected-resource/mcp"]){
   const r=await call(path);
   check(r.status===200,"RESOURCE_METADATA_HTTP_INVALID");
   const data=await r.json();
   check(data.resource===BASE+"/mcp"&&
        Array.isArray(data.authorization_servers)&&
        data.authorization_servers.length===1&&
        data.authorization_servers[0].startsWith("https://")&&
        Array.isArray(data.scopes_supported)&&
        data.scopes_supported.some(s=>s.includes("doctor_user"))&&
        data.scopes_supported.some(s=>s.endsWith(":aud")),
        "RESOURCE_METADATA_INVALID");
 }
 console.log("DOCTOR_EXTERNAL_MCP_DISCOVERY=PASS");

 const envelope={jsonrpc:"2.0",id:1,method:"tools/list"};
 for(const bearer of ["", "Bearer opaque-untrusted-access-token",
                      "Bearer invalid.jwt.signature", "Basic fake",
                      "Bearer fake,another"]){
  const headers={
    "Content-Type":"application/json",
    "Accept":"application/json, text/event-stream",
    "MCP-Protocol-Version":"2026-07-28",
  };
  if(bearer)headers.Authorization=bearer;
  const r=await call("/mcp",{method:"POST",headers,body:JSON.stringify(envelope)});
  check(r.status===401,"INVALID_MCP_BEARER_NOT_DENIED");
  const challenge=r.headers.get("www-authenticate")||"";
  check(challenge.includes('resource_metadata="'+BASE+
          '/.well-known/oauth-protected-resource/mcp"'),
        "RESOURCE_CHALLENGE_MISSING");
  const result=await r.json();
  check(result.error==="unauthorized","UNAUTH_ERROR_CONTRACT_WRONG");
 }
 console.log("DOCTOR_EXTERNAL_MCP_BEARER_NEGATIVES=PASS");
 const anon=await call("/api/session");
 const info=await anon.json();
 check(anon.status===200&&info.authenticated===false,
       "MCP_ANON_BROWSER_SESSION_LEAK");
 console.log("DOCTOR_EXTERNAL_MCP_ANONYMOUS_ISOLATION=PASS");
 console.log("DOCTOR_EXTERNAL_MCP_REAL_HTTP_NEGATIVES=PASS");
 console.log("DOCTOR_EXTERNAL_MCP_LIVE_EXTERNAL_CLIENT_CONSENT=NOT_TESTED");
}
main().catch(e=>{
 const x=e instanceof Error&&/^[A-Z0-9_]{5,85}$/.test(e.message)?e.message:"REDACTED";
 console.error("DOCTOR_EXTERNAL_MCP_REAL_HTTP_NEGATIVES=FAIL:"+x);
 process.exitCode=1;
});
