/** Credential-free external OAuth client preflight. No authorization codes or tokens. */
import { randomBytes, createHash } from "node:crypto";
const SITE="https://doctor.qdip.ai";
const CLIENT="395230152310721329";
const CALLBACK=SITE+"/auth/callback";
const deny=(name)=>{throw Error(name)};
async function main(){
 const res=await fetch(SITE+"/.well-known/oauth-protected-resource/mcp",{signal:AbortSignal.timeout(12000)});
 if(res.status!==200)deny("MCP_RESOURCE_DISCOVERY_HTTP");
 const r=await res.json();
 if(r.resource!==SITE+"/mcp"||r.authorization_servers?.length!==1)
   deny("MCP_RESOURCE_METADATA_MISMATCH");
 const issuer=r.authorization_servers[0];
 const oidc=await fetch(issuer+"/.well-known/openid-configuration",{signal:AbortSignal.timeout(12000)});
 if(oidc.status!==200)deny("ZITADEL_OIDC_DISCOVERY_HTTP");
 const configuration=await oidc.json();
 console.log("DOCTOR_ZITADEL_RFC9207_ISS_SUPPORTED="+
   (configuration.authorization_response_iss_parameter_supported===true?"YES":"NO"));
 console.log("DOCTOR_ZITADEL_DYNAMIC_CLIENT_REGISTRATION="+
   (typeof configuration.registration_endpoint==="string"?"AVAILABLE":"NOT_ADVERTISED"));
 console.log("DOCTOR_ZITADEL_PUBLIC_PKCE_TOKEN_AUTH="+
   (configuration.token_endpoint_auth_methods_supported?.includes("none")?"ADVERTISED":"NOT_ADVERTISED"));
 const authorization=new URL(configuration.authorization_endpoint);
 if(authorization.protocol!=="https:"||authorization.origin!==new URL(issuer).origin)
   deny("ZITADEL_AUTHORIZATION_HOST");
 const verifier=randomBytes(32).toString("base64url");
 const challenge=createHash("sha256").update(verifier).digest("base64url");
 const audience=(r.scopes_supported||[]).find(x=>x.endsWith(":aud"));
 const role=(r.scopes_supported||[]).find(x=>x.endsWith(":doctor_user"));
 const required=(r.scopes_supported||[]).find(x=>!x.startsWith("urn:")&&x!=="offline_access")||"openid";
 if(!audience||!role)deny("MCP_AUTH_SCOPES_MISSING");
 for(const [key,value] of Object.entries({
  client_id:CLIENT,redirect_uri:CALLBACK,response_type:"code",
  code_challenge:challenge,code_challenge_method:"S256",
  state:randomBytes(20).toString("base64url"),
  nonce:randomBytes(20).toString("base64url"),
  scope:["openid",required,audience,role].join(" "),
 })){authorization.searchParams.set(key,value);}
 const start=await fetch(authorization,{redirect:"manual",signal:AbortSignal.timeout(15000)});
 if(![302,303].includes(start.status))deny("ZITADEL_EXTERNAL_CLIENT_NOT_REDIRECTED_"+start.status);
 const target=new URL(start.headers.get("location")||"",issuer);
 if(!["https:"].includes(target.protocol)||!target.hostname)deny("ZITADEL_REDIRECT_INVALID");
 if(target.origin===SITE&&target.pathname==="/auth/callback")
   deny("ZITADEL_RETURNED_EARLY_OAUTH_ERROR");
 console.log("DOCTOR_EXTERNAL_CLIENT_ID_REGISTERED_FLOW_PREFLIGHT=PASS");
 console.log("DOCTOR_EXTERNAL_CLIENT_REDIRECT_REGISTERED=UNCONFIRMED_UNTIL_AUTH_CODE");
 console.log("DOCTOR_EXTERNAL_CLIENT_JWT_ISSUANCE=NOT_TESTED");
}
main().catch(error=>{
 const e=error instanceof Error&&/^[A-Z0-9_]{4,100}$/.test(error.message)
  ?error.message:"REDACTED_ERROR";
 console.error("DOCTOR_EXTERNAL_CLIENT_ID_REGISTERED_FLOW_PREFLIGHT=FAIL:"+e);
 process.exitCode=1;
});
