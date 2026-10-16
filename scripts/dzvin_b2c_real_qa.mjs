/**
 * One-shot live B2C acceptance with pre-existing QA1/QA2 Zitadel users.
 * Only the allowlisted dev-branch Vercel domain; no production writes.
 * QA1 writes exactly one nonpersonal test diary note, then archives it.
 * Output stage codes only: no tokens, credentials, subject IDs, notes or cookies.
 */
import { chromium } from "@playwright/test";

const SITE = "https://mentality-web.vercel.app";
const ACTUAL_ACCOUNTS = [
  { name: "QA1", email: process.env.QDIP_E2E_ZITADEL_TEST1_LOGIN, password: process.env.QDIP_E2E_ZITADEL_TEST1_PASSWORD },
  { name: "QA2", email: process.env.QDIP_E2E_ZITADEL_TEST2_LOGIN, password: process.env.QDIP_E2E_ZITADEL_TEST2_PASSWORD },
];

function requireStage(condition, code) {
  if (!condition) throw new Error(code);
}
function result(code) {
  console.log(code + "=PASS");
}

async function findField(page, selectors, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const input = page.locator(selector).first();
      if (await input.isVisible().catch(() => false)) return input;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function login(browser, user) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    serviceWorkers: "block",
    acceptDownloads: false,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(SITE + "/uk/auth", { waitUntil: "domcontentloaded", timeout: 30000 });
    const username = await findField(page, [
      'input[autocomplete="username"]', 'input[name="loginName"]',
      'input[name="loginname"]', 'input[name="username"]',
      'input[name="email"]', 'input[type="email"]', 'input[type="text"]',
    ]);
    requireStage(username, user.name + "_USERNAME_FIELD_MISSING");
    await username.fill(user.email);
    let password = await findField(
      page, ['input[autocomplete="current-password"]', 'input[type="password"]'], 1200,
    );
    if (!password) {
      await username.press("Enter");
      password = await findField(page, ['input[autocomplete="current-password"]', 'input[type="password"]']);
    }
    requireStage(password, user.name + "_PASSWORD_FIELD_MISSING");
    await password.fill(user.password);
    await password.press("Enter");
    let session = null;
    for (let i = 0; i < 22; i++) {
      await page.waitForTimeout(1300);
      const response = await context.request.get(SITE + "/api/auth/session", {
        maxRedirects: 0, timeout: 9000,
      }).catch(() => null);
      if (response?.status() === 200) {
        session = await response.json().catch(() => null);
        if (session?.id) break;
      }
    }
    requireStage(session?.id, user.name + "_SESSION_NOT_ESTABLISHED");
    requireStage(session.email?.toLowerCase() === user.email.toLowerCase(), user.name + "_SESSION_IDENTITY_MISMATCH");
    const cookies = await context.cookies(SITE);
    requireStage(cookies.some((c) => c.name === "auth-tokens" && c.httpOnly), user.name + "_HTTPONLY_COOKIE_MISSING");
    result(user.name + "_ZITADEL_SESSION");
    return { context, page, name: user.name };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function verifyUi(actor) {
  const { page, context, name } = actor;
  const progress = await page.goto(SITE + "/uk/my-progress", { waitUntil: "domcontentloaded", timeout: 30000 });
  requireStage(progress?.status() === 200, name + "_PROGRESS_HTTP_ERROR");
  await page.getByRole("heading", { name: "Твої записи" }).waitFor({ timeout: 18000 })
    .catch(() => { throw new Error(name + "_PROGRESS_PLACEHOLDER_OR_RENDER_FAILURE"); });
  await page.getByRole("heading", { name: "Твої поточні цілі" }).waitFor()
    .catch(() => { throw new Error(name + "_PROGRESS_GOALS_SECTION_MISSING"); });
  requireStage(await page.getByRole("link", { name: "Відкрити щоденник" }).isVisible(), name + "_PROGRESS_DIARY_LINK_MISSING");
  requireStage(await page.getByRole("link", { name: "Переглянути записи настрою" }).isVisible(), name + "_PROGRESS_MOOD_LINK_MISSING");
  result(name + "_PROGRESS_B2C_RENDER");

  for (const [path, label] of [
    ["/api/backend/goals", "GOALS"],
    ["/api/backend/user-statistics/mood", "MOOD_STATISTICS"],
  ]) {
    const r = await context.request.get(SITE + path, { maxRedirects: 0, timeout: 15000 });
    requireStage(r.status() === 200, name + "_" + label + "_BACKEND_STATUS_" + r.status());
    result(name + "_" + label + "_AUTH_READ");
  }

  await page.getByRole("link", { name: "Відкрити щоденник" }).click();
  await page.waitForURL((u) => u.pathname.endsWith("/diary"), { timeout: 15000 });
  await page.locator('textarea[name="note"]').waitFor({ timeout: 15000 });
  requireStage(
    await page.getByRole("link", { name: "Повернутися до мого дня" }).isVisible(),
    name + "_DIARY_MYDAY_RETURN_LINK_MISSING",
  );
  result(name + "_PROGRESS_TO_DIARY");

  const diaryResponse = await context.request.get(SITE + "/api/backend/diary/user", { maxRedirects: 0 });
  requireStage(diaryResponse.status() === 200, name + "_DIARY_BACKEND_STATUS_" + diaryResponse.status());
  const records = await diaryResponse.json().catch(() => null);
  requireStage(Array.isArray(records), name + "_DIARY_RESPONSE_INVALID");
  result(name + "_DIARY_AUTH_READ");

  const moodPage = await page.goto(SITE + "/uk/mood-tracker", { waitUntil: "domcontentloaded", timeout: 30000 });
  requireStage(moodPage?.status() === 200, name + "_MOOD_TRACKER_HTTP_ERROR");
  await page.getByRole("heading", { name: "Трекер настрою" }).waitFor({ timeout: 15000 })
    .catch(() => { throw new Error(name + "_MOOD_TRACKER_RENDER_FAILURE"); });
  result(name + "_MOOD_TRACKER_RENDER");

  await page.goto(SITE + "/uk/my-day", { waitUntil: "domcontentloaded", timeout: 30000 });
  requireStage(new URL(page.url()).pathname.endsWith("/my-day"), name + "_MYDAY_REDIRECTED");
  requireStage(await page.locator("article").count() > 0, name + "_MYDAY_CONTENT_MISSING");
  result(name + "_MYDAY_RENDER");
}

async function diaries(context) {
  const response = await context.request.get(SITE + "/api/backend/diary/user", { maxRedirects: 0 });
  requireStage(response.status() === 200, "DIARY_VERIFY_GET_" + response.status());
  const entries = await response.json();
  requireStage(Array.isArray(entries), "DIARY_VERIFY_NOT_ARRAY");
  return entries;
}

async function writeVerifyAndIsolate(a, b, marker) {
  await a.page.goto(SITE + "/uk/diary", { waitUntil: "domcontentloaded" });
  await a.page.locator('textarea[name="note"]').fill(marker);
  // Record all same-origin diary POST outcomes without logging URL, payload,
  // credentials, personal content or user identifiers.
  const observedPostStatuses = [];
  a.page.on("response", (response) => {
    try {
      const url = new URL(response.url());
      if (response.request().method() === "POST"
          && url.origin === SITE && url.pathname.includes("diary")) {
        observedPostStatuses.push(response.status());
      }
    } catch { /* Ignore unrelated browser responses. */ }
  });
  await a.page.getByRole("button", { name: "Зберегти запис" }).click();

  // An API read after the click is a durable acknowledgment of actual write.
  // The draft in a textarea is NOT evidence of saving; a failed toast probe
  // must not hide a successful backend write.
  let ownEntries = [];
  let saved;
  for (let attempt = 0; attempt < 25; attempt++) {
    ownEntries = await diaries(a.context);
    saved = ownEntries.find((entry) => entry.content === marker && !entry.isActive);
    if (saved) break;
    await a.page.waitForTimeout(500);
  }
  console.log("QA1_DIARY_POST_STATUS=" + (observedPostStatuses.join("_") || "NOT_CAPTURED"));
  console.log("QA1_DIARY_FORM_CLEARED=" + String(await a.page.locator('textarea[name="note"]').inputValue() === ""));
  requireStage(saved, "QA1_DIARY_BACKEND_PERSISTENCE_MISSING");
  result("QA1_DIARY_BACKEND_WRITE_CONFIRMED");

  await a.page.reload({ waitUntil: "domcontentloaded" });
  result("QA1_DIARY_BACKEND_PERSISTENCE_AFTER_RELOAD");
  const hasCreatedAt = typeof saved.createdAt === "string" && Number.isFinite(Date.parse(saved.createdAt));
  const activeEntries = ownEntries.filter((entry) => !entry.isActive);
  const sortedEntries = [...activeEntries].sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bTime - aTime;
  });
  const visibleInFirstPage = sortedEntries.slice(0, 10).some((entry) => entry.content === marker);
  const visible = await a.page.getByText(marker, { exact: true }).isVisible().catch(() => false);
  if (!visible) {
    const historyLoadError = await a.page.getByText("Не вдалося завантажити історію щоденника. Онови сторінку та спробуй ще раз.").isVisible().catch(() => false);
    const noEntries = await a.page.getByText("У тебе поки немає записів").isVisible().catch(() => false);
    const filteredEmpty = await a.page.getByText("За вибраними фільтрами записів немає").isVisible().catch(() => false);
    console.log("QA1_DIARY_RELOAD_DIAGNOSTIC=" + [
      hasCreatedAt ? "HAS_DATE" : "MISSING_DATE",
      visibleInFirstPage ? "IN_FIRST_PAGE" : "OUTSIDE_FIRST_PAGE",
      historyLoadError ? "LOAD_ERROR" : "NO_LOAD_ERROR",
      noEntries ? "EMPTY_SERVER_STATE" : "NO_EMPTY_SERVER_STATE",
      filteredEmpty ? "EMPTY_FILTER_STATE" : "NO_EMPTY_FILTER_STATE",
    ].join("_"));
    throw new Error("QA1_DIARY_SAVE_NOT_VISIBLE_AFTER_RELOAD");
  }
  result("QA1_DIARY_PERSISTENCE_AFTER_RELOAD");

  const otherEntries = await diaries(b.context);
  requireStage(otherEntries.every((entry) => entry.content !== marker), "QA2_CAN_READ_QA1_PRIVATE_DIARY");
  result("QA1_QA2_PRIVATE_DIARY_ISOLATION");
}

async function cleanupQaEntry(actor, marker) {
  if (!actor || !marker) return;
  try {
    const ownEntries = await diaries(actor.context);
    const matches = ownEntries.filter((entry) => entry.content === marker && !entry.isActive);
    for (const entry of matches) {
      requireStage(typeof entry.id === "string" && /^[a-f0-9]{24}$/i.test(entry.id), "QA_DIARY_CLEANUP_RECORD_ID_INVALID");
      const archived = await actor.context.request.patch(
        SITE + "/api/backend/diary/" + entry.id + "/activate",
        { maxRedirects: 0, headers: { origin: SITE } },
      );
      requireStage([200, 204].includes(archived.status()), "QA_DIARY_CLEANUP_ARCHIVE_FAILED");
    }
    result("QA1_DIARY_TEST_NOTE_ARCHIVED");
  } catch {
    console.error("QA1_DIARY_TEST_NOTE_CLEANUP_FAILED");
    process.exitCode = 1;
  }
}

async function main() {
  requireStage(process.env.DZVIN_DEV_ORIGIN === SITE, "DEV_ORIGIN_NOT_ALLOWLISTED");
  // This final qualification is strictly read-only; earlier QA1 write probes are
  // tracked separately while their save-acknowledgment issue is investigated.
  requireStage(ACTUAL_ACCOUNTS[0].email?.toLowerCase() === "qa1@qdip.ai", "QA1_ACCOUNT_MISMATCH");
  requireStage(ACTUAL_ACCOUNTS[1].email?.toLowerCase() === "qa2@qdip.ai", "QA2_ACCOUNT_MISMATCH");
  requireStage(ACTUAL_ACCOUNTS.every((u) => typeof u.password === "string" && u.password.length > 0), "QA_TEST_CREDENTIALS_NOT_CONFIGURED");
  const browser = await chromium.launch();
  let qa1, qa2;
  try {
    qa1 = await login(browser, ACTUAL_ACCOUNTS[0]);
    qa2 = await login(browser, ACTUAL_ACCOUNTS[1]);
    await verifyUi(qa1);
    await verifyUi(qa2);

    const qa1Entries = await diaries(qa1.context);
    const qa2Entries = await diaries(qa2.context);
    const archivedTestEntries = qa1Entries.filter(
      (entry) => typeof entry.content === "string"
        && entry.content.startsWith("dzvin-b2c-qa-"),
    );
    requireStage(archivedTestEntries.length > 0, "QA1_ISOLATION_FIXTURE_MISSING");
    requireStage(
      archivedTestEntries.every((entry) => entry.isActive === true),
      "QA1_PREVIOUS_TEST_ENTRY_NOT_ARCHIVED",
    );
    requireStage(
      qa2Entries.every((entry) => archivedTestEntries.every(
        (own) => own.id !== entry.id && own.content !== entry.content,
      )),
      "QA2_CAN_READ_QA1_PRIVATE_DIARY",
    );
    result("QA1_QA2_ARCHIVED_PRIVATE_DIARY_ISOLATION");
    result("DZVIN_B2C_REAL_TWO_ACCOUNT_READ_ONLY_ACCEPTANCE");
  } finally {
    await qa2?.context.close();
    await qa1?.context.close();
    await browser.close();
  }
}

main().catch((error) => {
  const code = typeof error?.message === "string" && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message : "UNEXPECTED_TEST_FAILURE";
  console.error("DZVIN_B2C_TEST_FAIL_CODE=" + code);
  process.exitCode = 1;
});
