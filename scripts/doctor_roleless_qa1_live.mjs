/** Negative real Zitadel browser authorization, Doctor P1.
 * qa1@qdip.ai must authenticate at Zitadel but have NO doctor_user role.
 * No screenshots, traces, tokens, URLs with authorization codes, or PII logs.
 * Exactly one password attempt. Never auto-rerun on push.
 */
import { chromium, request } from "@playwright/test";
const SITE = "https://doctor.qdip.ai";
const ACCOUNT = "qa1@qdip.ai";
const PASSWORD = process.env.QDIP_E2E_ZITADEL_QA1_PASSWORD;
function check(ok, stage) { if (!ok) throw Error(stage); }
async function findField(page, candidates, timeout=12000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {
    for(const selector of candidates) {
      const field=page.locator(selector).first();
      if(await field.isVisible().catch(()=>false))return field;
    }
    await page.waitForTimeout(250);
  }
  return null;
}
async function main() {
  check(typeof PASSWORD==="string" && PASSWORD.length>0,
        "QA1_PASSWORD_SECRET_NOT_BOUND");
  const anon=await request.newContext({ignoreHTTPSErrors:false});
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({
    ignoreHTTPSErrors:false, serviceWorkers:"block",
    viewport:{width:1280,height:800},acceptDownloads:false,
  });
  try {
    const pre=await anon.get(SITE+"/api/session");
    check(pre.status()===200 && (await pre.json()).authenticated===false,
          "QA1_PRECONDITION_ANONYMOUS_FAILED");
    console.log("DOCTOR_QA1_INITIAL_ANONYMOUS=PASS");
    const auth=await anon.get(SITE+"/auth/login?lang=uk",{maxRedirects:0});
    check(auth.status()===303, "QA1_OAUTH_PKCE_REDIRECT_MISSING");
    const target=new URL(auth.headers()["location"]||"");
    check(target.protocol==="https:"&&target.origin!==SITE
          &&target.searchParams.get("code_challenge_method")==="S256"
          &&target.searchParams.get("redirect_uri")===SITE+"/auth/callback",
          "QA1_OAUTH_PKCE_PARAMETERS_INVALID");
    console.log("DOCTOR_QA1_REAL_PKCE_REDIRECT=PASS");

    const page=await context.newPage();
    page.setDefaultTimeout(12000);
    const initial=await page.goto(SITE+"/auth/login?lang=uk",{
      waitUntil:"domcontentloaded",timeout:30000,
    });
    check(Boolean(initial) && new URL(page.url()).origin!==SITE,
          "QA1_REAL_ZITADEL_LOGIN_PAGE_NOT_REACHED");
    const username=await findField(page,[
      'input[autocomplete="username"]','input[name="loginName"]',
      'input[name="loginname"]','input[name="username"]',
      'input[name="email"]','input[type="email"]','input[type="text"]',
    ]);
    check(Boolean(username),"QA1_ZITADEL_USERNAME_INPUT_UNAVAILABLE");
    await username.fill(ACCOUNT);
    let password=await findField(page,[
      'input[autocomplete="current-password"]','input[type="password"]',
    ],1200);
    if(!password) {
      await username.press("Enter");
      password=await findField(page,[
        'input[autocomplete="current-password"]','input[type="password"]',
      ]);
    }
    check(Boolean(password),"QA1_ZITADEL_PASSWORD_INPUT_UNAVAILABLE");
    const callback=page.waitForResponse(response=>{
      try {
        const uri=new URL(response.url());
        return uri.origin===SITE && uri.pathname==="/auth/callback";
      }catch{return false;}
    },{timeout:40000});
    await password.fill(PASSWORD);
    await password.press("Enter");
    // Reaching the Doctor OAuth callback requires a code from Zitadel;
    // an invalid password never reaches this point. Status 403 is mandatory.
    let response;
    try {response=await callback;}
    catch {throw Error("QA1_ZITADEL_AUTHENTICATION_NOT_CONFIRMED");}
    check(response.status()===403,"QA1_DOCTOR_AUTHORIZATION_NOT_FORBIDDEN");
    const body=await response.text();
    check(body.toLowerCase().includes("<!doctype html>"),
          "QA1_DOCTOR_AUTHORIZATION_ERROR_PAGE_MISSING");
    console.log("DOCTOR_QA1_REAL_ZITADEL_CODE_RETURNED=PASS");
    console.log("DOCTOR_QA1_DOCTOR_OAUTH_403=PASS");

    const session=await context.request.get(SITE+"/api/session");
    check(session.status()===200,"QA1_SESSION_ENDPOINT_FAILED");
    const user=await session.json();
    check(user.authenticated===false && user.user===null,
          "QA1_UNAUTHORIZED_SESSION_CREATED");
    console.log("DOCTOR_QA1_NO_DOCTOR_SESSION=PASS");
    const protectedModel=await context.request.post(SITE+"/api/doctor",{
      headers:{Origin:SITE,"Content-Type":"application/json"},
      data:{model_base64:"e30=",operation:"validate",time_limit_seconds:1},
    });
    check(protectedModel.status()===401,"QA1_SOLVER_WAS_ACCESSIBLE");
    console.log("DOCTOR_QA1_SOLVER_DENIED_401=PASS");
    const mcp=await context.request.post(SITE+"/mcp",{
      headers:{"Content-Type":"application/json"},
      data:{jsonrpc:"2.0",id:1,method:"tools/list"},
    });
    check(mcp.status()===401,"QA1_MCP_WAS_ACCESSIBLE");
    console.log("DOCTOR_QA1_MCP_DENIED_401=PASS");

    // No session ever issued for QA1; without OAuth token it cannot be a
    // different authorized identity from a stale default-test-user context.
    const cookies=await context.cookies(SITE);
    check(!cookies.some(c=>c.name==="__Host-doctor_session"),
          "QA1_DOCTOR_SESSION_COOKIE_ISSUED");
    console.log("DOCTOR_QA1_NO_SESSION_COOKIE=PASS");
    console.log("DOCTOR_P1_REAL_ROLELESS_ZITADEL_QA1_E2E=PASS");
  } finally {
    await anon.dispose();await context.close();await browser.close();
  }
}
main().catch(error=>{
  const stage=error instanceof Error&&/^[A-Z0-9_]{5,90}$/.test(error.message)
    ?error.message:"QA1_BROWSER_ERROR_REDACTED";
  console.error("DOCTOR_P1_REAL_ROLELESS_ZITADEL_QA1_E2E=FAIL:"+stage);
  process.exitCode=1;
});
