/* Public-only VHV browser smoke suite. Never authenticate or attach production cookies.
   This qualifies only the anonymous landing at an observed deployment URL. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright');

const url = (process.env.VHV_BASE_URL || 'https://vhv.qdip.ai').replace(/\/$/, '');
const out = process.env.VHV_E2E_OUTPUT || 'reports/vhv-public-smoke';
fs.mkdirSync(out, {recursive: true});
const viewports = [
  {width:320,height:720,lang:'uk'},
  {width:375,height:812,lang:'uk'},
  {width:390,height:844,lang:'uk'},
  {width:430,height:932,lang:'uk'},
  {width:768,height:1024,lang:'uk'},
  {width:1280,height:800,lang:'uk'},
  {width:1440,height:900,lang:'en'},
  {width:375,height:812,lang:'en'}
];

async function check(browser, variant) {
  const {width,height,lang}=variant;
  const context = await browser.newContext({viewport:{width,height},deviceScaleFactor:1,locale:lang==='uk'?'uk-UA':'en-US',
    reducedMotion:'reduce',colorScheme:'light',storageState:{cookies:[],origins:[]}});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror', e=>errors.push(e.name));
  // VHV has /login, not locale-prefixed routes. Language is browser state.
  const target=url+'/login';
  try {
    const response=await page.goto(target,{waitUntil:'domcontentloaded',timeout:35000});
    if(lang==='en') {
      const switchToEnglish=page.getByRole('button',{name:'EN',exact:true});
      await switchToEnglish.waitFor({state:'visible',timeout:10000});
      // App Router may render the button before React binds its click handler.
      // Retrying the same locale selection is idempotent and avoids false E2E failures.
      let switched=false;
      for(let attempt=0;attempt<3&&!switched;attempt++) {
        await switchToEnglish.click();
        try {
          await page.waitForFunction(() =>
            document.documentElement.lang === 'en' &&
            /make time for what matters/i.test(document.querySelector('h1')?.textContent||''),
            null,{timeout:2500});
          switched=true;
        } catch {if(attempt===2) throw Error('English language toggle failed after hydration');}
      }
    }
    assert.ok(response && response.status() >= 200 && response.status() < 400,'Landing HTTP status '+response?.status());
    await page.locator('h1').first().waitFor({state:'visible',timeout:20000});
    const h1=await page.locator('h1').first().innerText();
    assert.ok(lang==='uk' ? /Знайдіть час/.test(h1) : /make time for what matters/i.test(h1),
      'Expected localized, visible value proposition; actual: '+h1.slice(0,100));
    // Prevent returning to the oversized VHV SVG mask: the original literal
    // VHV. lettering must appear beside the unchanged QDIP wordmark.
    const letters=page.locator('.product-lockup-product');
    await letters.waitFor({state:'visible',timeout:10000});
    assert.equal((await letters.innerText()).trim(),'VHV.');
    assert.equal(await page.locator('.product-lockup-vhv').count(),0,
      'Obsolete VHV image mark must not be rendered');
    await page.locator('.product-lockup-wordmark').waitFor({state:'visible',timeout:10000});
    const button=page.getByRole('button',{name:lang==='uk'?/Увійти/:/sign in|log in/i}).first();
    await button.waitFor({state:'visible',timeout:10000});
    assert.ok(await button.isEnabled(),'Zitadel sign-in CTA must be enabled');
    const submit=await button.evaluate(el=>el.closest('form')?.getAttribute('action')!==undefined);
    assert.ok(submit,'Sign-in must remain inside a real form; test must not submit it');

    const scene=page.locator('.login-scene');
    await scene.waitFor({state:'visible',timeout:10000});
    const styles=await scene.evaluate(el=>{
      const shell=getComputedStyle(el);
      const img=getComputedStyle(el.querySelector('.login-scene__image'));
      const layout=getComputedStyle(el.parentElement);
      const copy=getComputedStyle(el.parentElement.querySelector('.login-details'));
      const sceneBounds=el.getBoundingClientRect();
      const headingBounds=el.parentElement.querySelector('h1').getBoundingClientRect();
      const ctaBounds=el.parentElement.querySelector('.login-submit').getBoundingClientRect();
      return {image:img.backgroundImage,animation:img.animationName,
        position:shell.position,grid:layout.gridTemplateAreas,
        sceneTop:sceneBounds.top,headingTop:headingBounds.top,
        ctaTop:ctaBounds.top,copyZ:copy.zIndex,sceneZ:shell.zIndex};
    });
    assert.match(styles.image,/vhv-hero-approved\.webp/,'Approved artwork is missing');
    assert.equal(styles.animation,'none','Reduced motion must disable decorative movement');
    if(width<=850) {
      assert.equal(styles.position,'absolute','Mobile image must be a background, not a block');
      assert.equal(styles.grid,'"details"','Mobile must not allocate a second artwork grid row');
      assert.ok(styles.sceneTop<=styles.headingTop,'Background must start behind the heading');
      assert.ok(styles.sceneTop<styles.ctaTop,'Background must not appear only below CTA');
      assert.ok(Number(styles.copyZ)>Number(styles.sceneZ),'Sign-in content must layer above the artwork');
    }
    const artResponse=await page.request.get(url+'/vhv-hero-approved.webp',{timeout:15000});
    assert.equal(artResponse.status(),200,'Approved WebP must load');
    assert.match(artResponse.headers()['content-type']||'',/image\/webp/,'Expected actual WebP media type');
    const webp=await artResponse.body();
    assert.equal(webp.toString('ascii',0,4),'RIFF');
    assert.equal(webp.toString('ascii',8,12),'WEBP');

    const bounds=await page.evaluate(()=>({
      document:document.documentElement.scrollWidth,viewport:window.innerWidth,
      heading:document.querySelector('h1')?.getBoundingClientRect().toJSON(),
      cta:document.querySelector('form button[type="submit"]')?.getBoundingClientRect().toJSON()
    }));
    assert.ok(bounds.document<=bounds.viewport+2,'Unexpected horizontal overflow');
    assert.ok(bounds.cta && bounds.cta.width>120 && bounds.cta.height>=44,'CTA too small or missing');
    assert.ok(bounds.heading && bounds.heading.y < bounds.cta.y,'Heading should precede CTA');
    if(width<=430) assert.ok(bounds.cta.y+bounds.cta.height < height+120,
      'Mobile sign-in must not be displaced far below first screen');
    assert.deepEqual(errors,[],'Uncaught JavaScript page errors');

    await page.screenshot({path:path.join(out,'vhv-'+lang+'-'+width+'.png'),fullPage:true,
      animations:'disabled',timeout:15000});
    return {lang,width,height,status:'PASS',landing:target,webpBytes:webp.length};
  }finally{await context.close();}
}
(async()=>{
  let browser;
  const results=[];
  try {
    browser=await chromium.launch({headless:true,args:['--no-sandbox']});
    for(const viewport of viewports) {
      try{results.push(await check(browser,viewport));}
      catch(err){
        results.push({lang:viewport.lang,width:viewport.width,status:'FAIL',
          reason:String(err?.message||err).split('\n')[0].slice(0,180)});
      }
    }
  }catch(err){results.push({status:'INFRA_FAIL',reason:String(err?.message||err).split('\n')[0].slice(0,180)});}
  finally{if(browser) await browser.close();}
  const data={suite:'vhv-public-anonymous-landing-v1',deployedUrl:url,
    qualifiedSha:'UNKNOWN_DEPLOYMENT',sourceBuild:'NOT_TESTED',
    authenticatedZitadel:'NOT_TESTED',postgres:'NOT_TESTED',
    results};
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(data,null,2)+'\n');
  console.log('VHV_PUBLIC_LANDING_E2E='+((results.length===viewports.length && results.every(r=>r.status==='PASS'))?'PASS':'FAIL'));
  for(const r of results) console.log('VHV_PUBLIC_CASE='+r.lang+'_'+r.width+':'+r.status+(r.reason?':'+r.reason:''));
  if(results.length!==viewports.length||results.some(r=>r.status!=='PASS'))process.exitCode=1;
})().catch(err=>{console.error('VHV_PUBLIC_LANDING_E2E=INFRA_FAIL',String(err));process.exitCode=1;});
