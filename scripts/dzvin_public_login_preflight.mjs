/** Credential-free dev OIDC navigation diagnosis. Never emit redirect query params or tokens. */
import { chromium } from "@playwright/test";

const SITE = "https://mentality-web.vercel.app";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ ignoreHTTPSErrors: false, serviceWorkers: "block" });
const page = await context.newPage();
let authorize = false, authorizeStatus = null, appErrors = 0, failedRequests = 0;
page.on("request", req => {
  try {
    const u = new URL(req.url());
    if (u.pathname.endsWith("/oauth/v2/authorize")) authorize = true;
  } catch {}
});
page.on("response", response => { try { if (new URL(response.url()).pathname.endsWith("/oauth/v2/authorize")) authorizeStatus = response.status(); } catch {} });
page.on("pageerror", () => { appErrors++; });
page.on("requestfailed", () => { failedRequests++; });
try {
  const response = await page.goto(SITE + "/en/auth", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(11000);
  const end = new URL(page.url());
  const title = (await page.title()).toLowerCase();
  const loginFields = await page.locator('input[autocomplete="username"],input[name="loginName"],input[name="loginname"],input[name="username"],input[name="email"],input[type="email"],input[type="text"]').count();
  const visibleText = (await page.locator("body").innerText().catch(() => "")).toLowerCase().slice(0, 30000);
  const categories = [
    ["invalid-redirect", /invalid.{0,25}redirect|redirect.{0,25}invalid|redirect_uri|redirect uri/],
    ["invalid-client", /invalid.{0,25}client|client.{0,25}invalid|client not found|unknown client/],
    ["no-application", /application.{0,25}not found|no application found/],
    ["authorize-error", /authorization failed|request invalid|bad request|something went wrong|error processing request/],
    ["zitadel-login-prompt", /log in|sign in|username|loginname|e-mail address/],
    ["network-error", /site can't be reached|this site can.t be reached|page not available/],
  ];
  const visibleCategory = categories.find(([, re]) => re.test(visibleText))?.[0] || "other";
  const kinds = ["vercel authentication", "authentication required", "invalid redirect", "invalid request", "error", "sign in", "login"];
  const errorKind = kinds.find(s=>title.includes(s)) || "other";
  console.log("DZVIN_BROWSER_INITIAL_STATUS=" + response?.status());
  console.log("DZVIN_BROWSER_END_HOST=" + end.hostname);
  console.log("DZVIN_BROWSER_END_PATH=" + end.pathname);
  console.log("DZVIN_BROWSER_ZITADEL_AUTHORIZE_REQUEST=" + (authorize ? "YES" : "NO"));
  console.log("DZVIN_BROWSER_ZITADEL_AUTHORIZE_STATUS=" + String(authorizeStatus));
  console.log("DZVIN_BROWSER_CONTENT_CATEGORY=" + visibleCategory);
  console.log("DZVIN_BROWSER_TITLE_CATEGORY=" + errorKind);
  console.log("DZVIN_BROWSER_USERNAME_FIELD_COUNT=" + loginFields);
  console.log("DZVIN_BROWSER_PAGE_ERRORS_COUNT=" + appErrors);
  console.log("DZVIN_BROWSER_REQUEST_FAILURES_COUNT=" + failedRequests);
} finally {
  await context.close();
  await browser.close();
}