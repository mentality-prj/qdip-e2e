/** One-shot public independent staging smoke for Doctor P1 Security PR #31.
 * Only our ephemeral Railway service. Never uses Zitadel test credentials.
 */
const BASE="https://doctor-p1-security-stage-20261015-production.up.railway.app";
const PINNED="7e849f4cb4c8000b8c6c18716f7d832a73f33426";
function check(value,step){if(!value)throw Error(step); console.log("DOCTOR_P1_SECURITY_"+step+"=PASS")}
async function call(path,options={}){
 return fetch(BASE+path,{redirect:"manual",signal:AbortSignal.timeout(15000),...options});
}
async function main(){
 const ready=await call("/readyz");
 check(ready.status===200,"SECCOMP_READY");
 const health=await call("/healthz");
 check(health.status===200,"HEALTH");
 const anonymous=await call("/api/session");
 const user=await anonymous.json();
 check(anonymous.status===200&&user.authenticated===false&&user.user===null,"ANON_SESSION");
 const body=JSON.stringify({model_base64:"YQ==",operation:"validate",time_limit_seconds:1});
 const unauthorized=await call("/api/doctor",{method:"POST",headers:{"Content-Type":"application/json",Origin:BASE},body});
 check(unauthorized.status===401,"ANON_SOLVE_401");
 const mcp=await call("/mcp",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"jsonrpc":"2.0","id":1,"method":"tools/list"}'});
 check(mcp.status===401,"ANON_MCP_401");
 const first=await call("/auth/login?lang=uk");
 const location=first.headers.get("location")||"";
 const uri=new URL(location);
 const state=uri.searchParams.get("state");
 check(first.status===303&&uri.searchParams.get("code_challenge_method")==="S256"&&
       uri.searchParams.get("redirect_uri")===BASE+"/auth/callback"&&
       typeof state==="string"&&state.length>32,"OAUTH_PKCE_SHAPE");
 let success=1;
 for(let i=1;i<120;i++){
   const res=await call("/auth/login?lang=en");
   if(res.status===303) success++;
   else throw Error("OAUTH_BEFORE_BOUND_INVALID");
 }
 check(success===120,"OAUTH_FIRST_120_ALLOWED");
 const full=await call("/auth/login");
 check(full.status===429&&(await full.json()).error==="oauth_login_rate_limited","OAUTH_121_RATE_LIMIT");
 const malformed=await call("/auth/callback?state="+encodeURIComponent(state)+"&code=forged");
 check(malformed.status===400,"OAUTH_UNBOUND_STATE_DENIED");
 for(const lang of ["en","uk","pl"]){
  const r=await call("/"+lang);
  check(r.status===200&&(await r.text()).includes('<html lang="'+lang+'">'),"LOCALE_"+lang.toUpperCase());
 }
 console.log("DOCTOR_P1_SECURITY_SOURCE_SHA="+PINNED);
 console.log("DOCTOR_P1_SECURITY_EXTERNAL_SMOKE=PASS");
 console.log("DOCTOR_P1_SECURITY_LIVE_ROLELESS_USER=NOT_TESTED");
}
main().catch(e=>{const msg=String(e?.message||"FAIL");console.error("DOCTOR_P1_SECURITY_EXTERNAL_SMOKE=FAIL:"+
 (/^[A-Z0-9_]{3,80}$/.test(msg)?msg:"REDACTED"));process.exitCode=1;});
