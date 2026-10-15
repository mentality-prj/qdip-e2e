/** Public, credential-free real HTTP smoke against isolated Doctor P1 audit staging. */
const ORIGIN="https://doctor-p1-audit-stage-20261015-production.up.railway.app";
function check(v,name){if(!v)throw Error(name);}
async function hit(path,opts={}){
  const res=await fetch(ORIGIN+path,{
    redirect:"manual",signal:AbortSignal.timeout(15000),...opts
  });return res;
}
async function main(){
  let ready=false;
  for(let attempt=0;attempt<18;attempt++){
    try{
      const r=await hit("/readyz");
      if(r.status===200){ready=true;break;}
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,5000));
  }
  check(ready,"STAGE_NOT_READY");
  console.log("DOCTOR_P1_AUDIT_READY=PASS");
  const session=await hit("/api/session");
  const info=await session.json();
  check(session.status===200&&info.authenticated===false&&info.user===null,
        "ANON_SESSION_INVALID");
  const payload=JSON.stringify({
    model_base64:"YQ==",operation:"validate",time_limit_seconds:1,
  });
  const anonymous=await hit("/api/doctor",{
    method:"POST",headers:{Origin:ORIGIN,"Content-Type":"application/json"},
    body:payload
  });
  check(anonymous.status===401,"ANON_DOCTOR_NOT_DENIED");
  console.log("DOCTOR_P1_AUDIT_ANON_401=PASS");
  const logout=await hit("/auth/logout",{
    method:"POST",headers:{Origin:"https://not-valid.example.test"}
  });
  check(logout.status===403,"CROSS_ORIGIN_LOGOUT_NOT_DENIED");
  console.log("DOCTOR_P1_AUDIT_CSRF_403=PASS");
  const bogus=await hit("/auth/callback?state=forged-state&code=forged-code");
  check(bogus.status===400,"FORGED_OAUTH_CALLBACK_NOT_DENIED");
  console.log("DOCTOR_P1_AUDIT_FORGED_CALLBACK_400=PASS");
  const start=await hit("/auth/login?lang=uk");
  check(start.status===303,"OAUTH_START_INVALID");
  const loc=new URL(start.headers.get("location")||"");
  check(loc.searchParams.get("code_challenge_method")==="S256",
        "PKCE_MISSING");
  console.log("DOCTOR_P1_AUDIT_PKCE=PASS");
  console.log("DOCTOR_P1_AUDIT_EXTERNAL_HTTP=PASS");
}
main().catch(err=>{
 const m=err instanceof Error&&/^[A-Z0-9_]{5,80}$/.test(err.message)
   ?err.message:"REDACTED_HTTP_FAILURE";
 console.error("DOCTOR_P1_AUDIT_EXTERNAL_HTTP=FAIL:"+m);
 process.exitCode=1;
});
