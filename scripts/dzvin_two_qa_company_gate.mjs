/**
 * Manual-only two-account Dzvin dev authorization qualification.
 * Uses existing qdip-e2e TEST1/TEST2 GitHub secrets. Never prints credentials,
 * auth codes, cookies, tokens, subject IDs or company IDs.
 * No production target, no MongoDB writes, no role changes and no retries.
 */
import { chromium } from "@playwright/test";

const SITE = process.env.DZVIN_DEV_ORIGIN;
const users = [
  {
    name: "QA1",
    email: process.env.QDIP_E2E_ZITADEL_TEST1_LOGIN,
    password: process.env.QDIP_E2E_ZITADEL_TEST1_PASSWORD,
  },
  {
    name: "QA2",
    email: process.env.QDIP_E2E_ZITADEL_TEST2_LOGIN,
    password: process.env.QDIP_E2E_ZITADEL_TEST2_PASSWORD,
  },
];

function requireStage(value, code) {
  if (!value) throw new Error(code);
}

function assertPreflight() {
  requireStage(
    SITE === "https://mentality-web.vercel.app",
    "DZVIN_DEV_ORIGIN_UNEXPECTED",
  );
  const emails = new Set();
  for (const user of users) {
    requireStage(
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email || ""),
      user.name + "_LOGIN_UNBOUND",
    );
    requireStage(
      typeof user.password === "string" && user.password.length > 0,
      user.name + "_PASSWORD_UNBOUND",
    );
    emails.add(user.email.toLowerCase());
  }
  requireStage(users[0].email.toLowerCase() === "qa1@qdip.ai", "QA1_ACCOUNT_MISMATCH");
  requireStage(users[1].email.toLowerCase() === "qa2@qdip.ai", "QA2_ACCOUNT_MISMATCH");
  requireStage(emails.size === 2, "QA_USERS_NOT_DISTINCT");
}

async function findField(page, selectors, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const field = page.locator(selector).first();
      if (await field.isVisible().catch(() => false)) return field;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function loginAndResolveCompany(browser, user) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    await page.goto(SITE + "/en/auth", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const username = await findField(page, [
      'input[autocomplete="username"]',
      'input[name="loginName"]',
      'input[name="loginname"]',
      'input[name="username"]',
      'input[name="email"]',
      'input[type="email"]',
      'input[type="text"]',
    ]);
    requireStage(username, user.name + "_ZITADEL_USERNAME_FIELD_MISSING");
    await username.fill(user.email);
    let password = await findField(
      page,
      ['input[autocomplete="current-password"]', 'input[type="password"]'],
      1200,
    );
    if (!password) {
      await username.press("Enter");
      password = await findField(page, [
        'input[autocomplete="current-password"]',
        'input[type="password"]',
      ]);
    }
    requireStage(password, user.name + "_ZITADEL_PASSWORD_FIELD_MISSING");
    await password.fill(user.password);
    await password.press("Enter");

    let session = null;
    for (let attempt = 0; attempt < 22; attempt++) {
      await page.waitForTimeout(1300);
      const response = await context.request.get(SITE + "/api/auth/session", {
        maxRedirects: 0,
        timeout: 9000,
      }).catch(() => null);
      if (response?.status() === 200) {
        session = await response.json().catch(() => null);
        if (session?.id) break;
      }
    }
    requireStage(session?.id, user.name + "_DZVIN_SESSION_NOT_ESTABLISHED");
    requireStage(
      session.email?.toLowerCase() === user.email.toLowerCase(),
      user.name + "_SESSION_IDENTITY_MISMATCH",
    );
    const cookies = await context.cookies(SITE);
    requireStage(
      cookies.some((cookie) => cookie.name === "auth-tokens" && cookie.httpOnly),
      user.name + "_HTTPONLY_AUTH_COOKIE_MISSING",
    );
    console.log(user.name + "_REAL_ZITADEL_DZVIN_SESSION=PASS");

    const response = await context.request.get(SITE + "/api/backend/companies/mine", {
      maxRedirects: 0,
    });
    requireStage(response.status() === 200, user.name + "_COMPANY_LIST_UNAVAILABLE");
    const companies = await response.json();
    requireStage(Array.isArray(companies), user.name + "_COMPANY_LIST_INVALID");
    if (companies.length === 1) {
      const expectedName = user.name === "QA1" ? "TechCorp Solutions" : "QDIP Gate2 QA Isolation B";
      requireStage(companies[0]?.name === expectedName, user.name + "_TEST_COMPANY_UNEXPECTED");
    }
    const ids = companies.map(item => item?.id);
    requireStage(ids.every(id => /^[a-f0-9]{24}$/i.test(id || "")),
      user.name + "_COMPANY_ID_INVALID");
    // Emit only a privacy-safe category, never company identifiers or names.
    const category = ids.length === 0 ? "ZERO" : ids.length === 1 ? "ONE" : "MULTIPLE";
    console.log(user.name + "_COMPANY_FIXTURE_CATEGORY=" + category);
    if (ids.length === 1) console.log(user.name + "_SINGLE_COMPANY_MEMBERSHIP=PASS");
    return { context, subject: session.id, companyId: ids[0] ?? null, companyCount: ids.length };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function denyForeignAccess(actor, companyId, label) {
  const own = await actor.context.request.get(
    SITE + "/api/backend/companies/" + actor.companyId,
    { maxRedirects: 0 },
  );
  requireStage(own.status() === 200, label + "_OWN_COMPANY_NOT_READABLE");
  for (const suffix of [
    "",
    "/groups",
    "/employees",
    "/invites",
    "/access-scopes",
    "/salary-grades",
    "/analytics/mood",
  ]) {
    const denied = await actor.context.request.get(
      SITE + "/api/backend/companies/" + companyId + suffix,
      { maxRedirects: 0 },
    );
    requireStage(
      [403, 404].includes(denied.status()),
      label + "_FOREIGN_COMPANY_READ_NOT_DENIED",
    );
    requireStage(
      (denied.headers()["cache-control"] || "").includes("no-store"),
      label + "_DENIAL_CACHE_CONTROL_MISSING",
    );
  }
  const forged = await actor.context.request.get(
    SITE + "/api/backend/companies/" + companyId + "/groups",
    {
      maxRedirects: 0,
      headers: { "x-company-id": companyId, "x-company-role": "superuser" },
    },
  );
  requireStage(
    [403, 404].includes(forged.status()),
    label + "_FORGED_COMPANY_HEADER_NOT_DENIED",
  );
  const selector = await actor.context.request.post(SITE + "/api/company-context", {
    maxRedirects: 0,
    headers: { Origin: SITE },
    form: { companyId, locale: "en" },
  });
  requireStage(selector.status() === 403, label + "_FOREIGN_COMPANY_SWITCH_NOT_DENIED");
  requireStage(
    !selector.headers()["set-cookie"],
    label + "_FOREIGN_COMPANY_SWITCH_SET_COOKIE",
  );
  console.log(label + "_BIDIRECTIONAL_COMPANY_ISOLATION=PASS");
}


/**
 * Gate 2 stage 2: read-only security boundary probes on actual member sessions.
 * Never submit a valid, authorized mutation to the populated TechCorp demo.
 * Origin-denied requests are stopped by the Next.js BFF before reaching MongoDB.
 */
async function expectNoStoreDenied(response, label, statuses = [403, 404]) {
  requireStage(statuses.includes(response.status()), label + "_DENIAL_STATUS_UNEXPECTED");
  requireStage(
    (response.headers()["cache-control"] || "").includes("no-store"),
    label + "_DENIAL_CACHE_POLICY_MISSING",
  );
}

async function assertMemberBoundary(actor, foreignCompanyId, label) {
  const api = actor.context.request;
  const own = actor.companyId;
  const sessionResponse = await api.get(SITE + "/api/auth/session");
  requireStage(sessionResponse.status() === 200, label + "_CURRENT_SESSION_UNAVAILABLE");
  const session = await sessionResponse.json();
  requireStage(session.id === actor.subject, label + "_SESSION_SUBJECT_CHANGED");
  requireStage(session.companyId === own, label + "_SESSION_COMPANY_MISMATCH");
  requireStage(session.role === "user", label + "_UNEXPECTED_PLATFORM_ADMIN_ROLE");
  requireStage(session.companyRole === "employee", label + "_UNEXPECTED_COMPANY_PRIVILEGE");

  // A normal company member may not use any manager or company-admin read endpoints.
  for (const suffix of [
    "/analytics/mood",
    "/employees",
    "/access-scopes",
    "/salary-grades",
  ]) {
    await expectNoStoreDenied(
      await api.get(SITE + "/api/backend/companies/" + own + suffix),
      label + "_OWN_PRIVILEGED_READ",
      [403],
    );
  }
  await expectNoStoreDenied(
    await api.get(SITE + "/api/backend/companies"),
    label + "_GLOBAL_COMPANY_ENUMERATION",
    [403],
  );
  await expectNoStoreDenied(
    await api.get(SITE + "/api/backend/companies/" + own + "/access-scopes", {
      headers: { "x-company-id": own, "x-company-role": "superuser" },
    }),
    label + "_FORGED_OWN_ROLE",
    [403],
  );
  console.log(label + "_CANONICAL_MEMBER_ROLE_BOUNDARY=PASS");

  // A stale/hostile tenant-selection cookie must not grant another company.
  await actor.context.addCookies([{
    name: "dzvin-active-company",
    value: foreignCompanyId,
    url: SITE,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  }]);
  try {
    const stale = await api.get(SITE + "/api/auth/session");
    requireStage(stale.status() === 200, label + "_STALE_SELECTION_LOST_SESSION");
    const resolved = await stale.json();
    requireStage(resolved.id === actor.subject, label + "_STALE_SELECTION_CHANGED_IDENTITY");
    requireStage(resolved.companyId !== foreignCompanyId, label + "_STALE_SELECTION_TENANT_LEAK");
    await expectNoStoreDenied(
      await api.get(SITE + "/api/backend/companies/" + foreignCompanyId + "/groups"),
      label + "_STALE_SELECTION_FOREIGN_ACCESS",
    );
  } finally {
    await actor.context.clearCookies({ name: "dzvin-active-company" });
  }
  console.log(label + "_STALE_TENANT_COOKIE_BOUNDARY=PASS");

  const origin = SITE;
  const invalid = await api.post(SITE + "/api/company-context", {
    headers: { origin },
    form: { companyId: "not-an-object-id", locale: "en" },
    maxRedirects: 0,
  });
  requireStage(invalid.status() === 400, label + "_INVALID_TENANT_ID_ACCEPTED");
  requireStage(!invalid.headers()["set-cookie"], label + "_INVALID_TENANT_SET_COOKIE");

  const csrf = await api.post(SITE + "/api/company-context", {
    headers: { origin: "https://attacker.invalid" },
    form: { companyId: own, locale: "en" },
    maxRedirects: 0,
  });
  requireStage(csrf.status() === 403, label + "_COMPANY_SWITCH_CSRF_ACCEPTED");
  requireStage(!csrf.headers()["set-cookie"], label + "_CSRF_SET_COOKIE");

  // These requests MUST be rejected by the BFF origin check *before* backend writes.
  // Never even probe a would-be write against the populated TechCorp demo.
  // If a CSRF regression makes a request reach Mongo, only the disposable B fixture is targeted.
  const disposableCompanyId = label === "QA1" ? foreignCompanyId : own;
  for (const path of [
    "/api/backend/companies/" + disposableCompanyId + "/groups",
  ]) {
    await expectNoStoreDenied(
      await api.post(SITE + path, {
        headers: { origin: "https://attacker.invalid" },
        data: { name: "DENY-GATE2-BEFORE-MONGO", type: "team" },
      }),
      label + "_MUTATION_CSRF",
      [403],
    );
  }
  await expectNoStoreDenied(
    await api.get(SITE + "/api/backend/auth/validate-token"),
    label + "_IDENTITY_PROXY_ALLOWLIST",
    [400],
  );
  console.log(label + "_CSRF_AND_PROXY_ALLOWLIST=PASS");
}

async function assertUnauthenticatedBoundary(browser, aId, bId) {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    for (const path of [
      "/api/auth/session",
      "/api/backend/companies/mine",
      "/api/backend/companies/" + aId,
      "/api/backend/companies/" + bId + "/invites",
    ]) {
      const response = await context.request.get(SITE + path, { maxRedirects: 0 });
      requireStage(response.status() === 401, "ANONYMOUS_COMPANY_READ_NOT_BLOCKED");
      requireStage(
        (response.headers()["cache-control"] || "").includes("no-store"),
        "ANONYMOUS_RESPONSE_CACHE_POLICY_MISSING",
      );
    }
    console.log("DZVIN_ANONYMOUS_COMPANY_BOUNDARY=PASS");
  } finally {
    await context.close();
  }
}

async function assertConcurrentTenantIsolation(a, b) {
  // Same x-request-id across two distinct identity sessions is intentional:
  // request-scoped memoization must always include the bearer identity and tenant.
  const requestId = "dzvin-qa-pair-cache-isolation";
  const checks = [
    [a, a.companyId, 200],
    [b, b.companyId, 200],
    [a, b.companyId, 403],
    [b, a.companyId, 403],
  ];
  const results = await Promise.all(checks.map(async ([actor, companyId, expected]) => {
    const response = await actor.context.request.get(
      SITE + "/api/backend/companies/" + companyId,
      { headers: { "x-request-id": requestId }, maxRedirects: 0 },
    );
    return { status: response.status(), expected, cache: response.headers()["cache-control"] || "" };
  }));
  for (const result of results) {
    requireStage(
      result.expected === 200 ? result.status === 200 : [403, 404].includes(result.status),
      "CONCURRENT_COMPANY_RESPONSE_WRONG",
    );
    requireStage(result.cache.includes("no-store"), "CONCURRENT_CACHE_CONTROL_MISSING");
  }
  console.log("DZVIN_CONCURRENT_CROSS_ACCOUNT_CACHE_BOUNDARY=PASS");
}

async function main() {
  assertPreflight();
  console.log("DZVIN_QA_PAIR_SECRET_BINDING=PASS");
  const browser = await chromium.launch({ headless: true });
  let a, b;
  try {
    a = await loginAndResolveCompany(browser, users[0]);
    b = await loginAndResolveCompany(browser, users[1]);
    requireStage(a.subject !== b.subject, "DZVIN_QA_SUBJECTS_NOT_DISTINCT");
    requireStage(a.companyCount === 1, "QA1_SINGLE_DISPOSABLE_COMPANY_FIXTURE_MISSING");
    requireStage(b.companyCount === 1, "QA2_SINGLE_DISPOSABLE_COMPANY_FIXTURE_MISSING");
    requireStage(a.companyId !== b.companyId, "DZVIN_QA_COMPANIES_NOT_DISTINCT");
    await denyForeignAccess(a, b.companyId, "QA1");
    await denyForeignAccess(b, a.companyId, "QA2");
    await assertMemberBoundary(a, b.companyId, "QA1");
    await assertMemberBoundary(b, a.companyId, "QA2");
    await assertUnauthenticatedBoundary(browser, a.companyId, b.companyId);
    await assertConcurrentTenantIsolation(a, b);
    console.log("DZVIN_REAL_QA1_QA2_COMPANY_GATE=PASS");
    console.log("DZVIN_GATE2_TWO_ACCOUNT_BOUNDARIES=PASS");
  } finally {
    await Promise.all([a?.context.close(), b?.context.close()]);
    await browser.close();
  }
}

main().catch((error) => {
  const reason = error instanceof Error && /^[A-Z0-9_]{5,100}$/.test(error.message)
    ? error.message : "REDACTED_BROWSER_OR_NETWORK_ERROR";
  console.error("DZVIN_REAL_QA1_QA2_COMPANY_GATE=FAIL:" + reason);
  process.exitCode = 1;
});
