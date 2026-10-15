/** Independent actual Chromium/mobile Doctor P1 accessibility smoke.
 * Browser-only, anonymous and non-invasive. No credentials, screenshot or trace.
 * Tests a PINNED separate Railway preview, never production or Zitadel accounts.
 */
import {chromium, request} from "@playwright/test";

const SITE=process.env.DOCTOR_P1_A11Y_URL ?? "https://doctor.qdip.ai";
if(!/^https:\/\/[a-z0-9.-]+$/.test(SITE)) throw Error("SITE_CONFIGURATION_INVALID");
const widths=[320,375,390,430,768,1280];
function check(v,name){if(!v)throw Error(name);}
async function main(){
  const browser=await chromium.launch({headless:true});
  const http=await request.newContext({ignoreHTTPSErrors:false});
  try {
    const ready=await http.get(SITE+"/readyz",{timeout:20000});
    check(ready.status()===200,"STAGING_NOT_READY");
    console.log("DOCTOR_P1_MOBILE_SECCOMP_READYZ=PASS");
    for(const width of widths){
      const context=await browser.newContext({
        viewport:{width,height:844},
        isMobile:width<=430,hasTouch:width<=430,
        deviceScaleFactor:width<=430?2:1,
        ignoreHTTPSErrors:false,serviceWorkers:"block",
      });
      const page=await context.newPage();
      try{
        const response=await page.goto(SITE+"/uk",{
          waitUntil:"domcontentloaded",timeout:25000,
        });
        check(response?.status()===200,"MOBILE_HTTP_"+width);
        await page.locator("#doctor-form").waitFor({state:"visible"});
        const sizing=await page.evaluate(()=>{
          const doc=document.documentElement;
          return {viewport:doc.clientWidth,scroll:doc.scrollWidth,
             body:document.body.scrollWidth,
             heading:document.querySelector("#hero-title").getBoundingClientRect().width};
        });
        check(sizing.scroll<=sizing.viewport+1,
          "MOBILE_HORIZONTAL_SCROLL_"+width);
        check(sizing.heading>0,"MOBILE_HERO_HIDDEN_"+width);
        for(const id of ["locale-switch","doctor-form","model-file","operation","run"]){
          check(await page.locator("#"+id).count()===1,"MOBILE_MISSING_"+id+"_"+width);
        }
        check((await page.locator("#run").isDisabled()),"MOBILE_ANONYMOUS_RUN_"+width);
        check(await page.locator("#form-error").getAttribute("role")==="alert",
          "MOBILE_ERROR_LIVE_REGION_"+width);
        // The first Tab must offer a keyboard skip link; Enter should transfer
        // browser focus to the workspace before the main form controls.
        await page.keyboard.press("Tab");
        const first=await page.evaluate(()=>({
          active:document.activeElement?.className,
          label:document.activeElement?.textContent?.trim(),
        }));
        check(first.active==="skip-link","MOBILE_SKIP_LINK_NOT_FIRST_"+width);
        check(first.label==="Перейти до робочого простору",
          "MOBILE_SKIP_LINK_TRANSLATION_"+width);
        await page.keyboard.press("Enter");
        const target=await page.evaluate(()=>document.activeElement?.id);
        check(target==="workspace","MOBILE_SKIP_TARGET_NOT_FOCUSED_"+width);
        await page.locator("#model-file").focus();
        const focus=await page.evaluate(()=>{
          const label=document.querySelector(".file-target");
          const css=getComputedStyle(label);
          return {style:css.outlineStyle,width:parseFloat(css.outlineWidth)};
        });
        check(focus.style!=="none"&&focus.width>=2,
          "MOBILE_FILE_FOCUS_INVISIBLE_"+width);
        console.log("DOCTOR_P1_MOBILE_"+width+"=PASS");
      }finally{await context.close();}
    }
    const reduced=await browser.newContext({viewport:{width:390,height:844},
      reducedMotion:"reduce",ignoreHTTPSErrors:false});
    const page=await reduced.newPage();
    try{
      await page.goto(SITE+"/en",{waitUntil:"domcontentloaded"});
      const behavior=await page.evaluate(()=>getComputedStyle(document.documentElement).scrollBehavior);
      check(behavior==="auto","MOBILE_REDUCED_MOTION_NOT_RESPECTED");
      console.log("DOCTOR_P1_MOBILE_REDUCED_MOTION=PASS");
    }finally{await reduced.close();}
    const anon=await http.post(SITE+"/api/doctor",{
      headers:{Origin:SITE,"Content-Type":"application/json"},
      data:{model_base64:"YQ==",operation:"validate",time_limit_seconds:1},
    });
    check(anon.status()===401,"MOBILE_ANONYMOUS_DOCTOR_NOT_DENIED");
    console.log("DOCTOR_P1_MOBILE_ANONYMOUS_401=PASS");
    console.log("DOCTOR_P1_REAL_CHROMIUM_MOBILE_ACCESSIBILITY=PASS");
  }finally{await http.dispose();await browser.close();}
}
main().catch(err=>{
  const name=err instanceof Error&&/^[A-Z0-9_]{5,90}$/.test(err.message)
    ?err.message:"BROWSER_FAILURE_REDACTED";
  console.error("DOCTOR_P1_REAL_CHROMIUM_MOBILE_ACCESSIBILITY=FAIL:"+name);
  process.exitCode=1;
});
