/** Standalone external HTTP smoke for a pinned Doctor P1 staging SHA.
 * No user credentials, no OAuth token exchange, no model execution.
 * This does not qualify a positive Zitadel browser session.
 */
const BASE = "https://doctor-p1-repair-staging-20261015-production.up.railway.app";
const SHA = "a21bc8ec27354ee2da854a0fcd244731ba58b8ec";
const assert = (predicate, key) => {
  if (!predicate) throw Error(key);
  console.log("DOCTOR_P1_STAGE_" + key + "=PASS");
};
async function call(path, options = {}) {
  const response = await fetch(BASE + path, {redirect:"manual", signal:AbortSignal.timeout(15000),...options});
  return response;
}
async function main() {
  const readiness=await call("/readyz");
  assert(readiness.status===200,"REAL_WORKER_READY");
  const health=await call("/healthz");
  assert(health.status===200,"HEALTHZ");
  for (const lang of ["en","uk","pl"]) {
    const response=await call("/"+lang);
    assert(response.status===200 && (await response.text()).includes('<html lang="'+lang+'">'),"LOCALE_"+lang.toUpperCase());
  }
  const session=await call("/api/session");
  const payload=await session.json();
  assert(session.status===200 && payload.authenticated===false && payload.user===null,"ANONYMOUS_SESSION");
  const unauthorized=await call("/api/doctor",{
    method:"POST",headers:{"Origin":BASE,"Content-Type":"application/json"},
    body:JSON.stringify({model_base64:"e30=",operation:"validate",time_limit_seconds:2}),
  });
  assert(unauthorized.status===401,"ANONYMOUS_SOLVE_DENIED");
  const mcp=await call("/mcp",{method:"POST",headers:{"Content-Type":"application/json"},
    body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});
  assert(mcp.status===401,"ANONYMOUS_MCP_DENIED");
  const start=await call("/auth/login?lang=uk");
  const location=start.headers.get("location");
  let oidc;
  try { oidc=new URL(location); } catch { throw Error("OAUTH_REDIRECT_MALFORMED"); }
  assert(start.status===303 && oidc.protocol==="https:" &&
     oidc.searchParams.get("code_challenge_method")==="S256" &&
     oidc.searchParams.get("redirect_uri")===BASE+"/auth/callback",
     "PKCE_REDIRECT_SHAPE");
  const invalid=await call("/api/doctor",{method:"POST",headers:{"Origin":"https://evil.invalid","Content-Type":"application/json"},
    body:JSON.stringify({model_base64:"e30=",operation:"validate",time_limit_seconds:2})});
  assert([401,403].includes(invalid.status) && invalid.status!==200,"UNAUTHORIZED_ORIGIN_NO_SOLVE");
  const diagnostics=await call("/assets/diagnostics.js");
  const js=await diagnostics.text();
  assert(diagnostics.status===200 && js.includes("VERIFIED_ASSUMPTION_RELAXATION_ALTERNATIVES"),"MULTI_REPAIR_FRONTEND_PRESENT");
  console.log("DOCTOR_P1_STAGE_SOURCE_SHA="+SHA);
  console.log("DOCTOR_P1_STAGING_READINESS_AND_AUTH_DENIAL=PASS");
  console.log("DOCTOR_P1_LIVE_ZITADEL_BROWSER_AUTH=NOT_TESTED");
  console.log("DOCTOR_P1_POSITIVE_REPAIR_API=NOT_TESTED");
}
main().catch(e=>{const reason=String(e.message||"FAILED");console.error("DOCTOR_P1_STAGE=FAIL:"+ (/^[A-Z0-9_]+$/.test(reason)?reason:"REDACTED"));process.exitCode=1;});
