"""Fail closed when the isolated E2E signer diverges from current Web auth.

This is a static compatibility guard, not an authentication test or Zitadel
verification. Positive authorization is asserted by Chromium against real
qdip-web and Core; live IdP login remains a separate unqualified gate.
"""
from __future__ import annotations

import os
from pathlib import Path

def validate(root: Path) -> None:
    web = (root / "observatory/src/lib/qdip-oidc.ts").read_text(encoding="utf-8")
    provision = (root / "suite/scripts/provision_tenants.py").read_text(encoding="utf-8")
    browser = (root / "suite/scripts/rr_oidc_session_browser.spec.ts").read_text(encoding="utf-8")
    matrix = (root / "suite/scripts/check_browser_report.py").read_text(encoding="utf-8")
    runner = (root / "suite/scripts/run_real_e2e.sh").read_text(encoding="utf-8")
    browser_config = (root / "suite/scripts/rr_real_playwright.config.ts").read_text(encoding="utf-8")
    checks = (
        ("cookie signing key", "QDIP_AUTH_COOKIE_SECRET" in web and
         "QDIP_AUTH_COOKIE_SECRET" in provision and "QDIP_AUTH_COOKIE_SECRET" in browser),
        ("project ID", "ZITADEL_QDIP_PROJECT_ID" in web and
         "ZITADEL_QDIP_PROJECT_ID" in provision and "ZITADEL_QDIP_PROJECT_ID" in browser),
        ("organization ID", "ZITADEL_QDIP_ORGANIZATION_ID" in web and
         "ZITADEL_QDIP_ORGANIZATION_ID" in provision and "ZITADEL_QDIP_ORGANIZATION_ID" in browser),
        ("signed cookie purpose", "seal(session, 'session-v1')" in web and
         "update('session-v1:' + payload)" in browser),
        ("role-scoped session", "roles: Role[]" in web and
         "roles: IsolatedRole[]" in browser and
         "roles: [role === 'rr' ? 'rr_operator' : 'studio']" in browser),
        ("session validates project and org", "session.projectId !== roleSettings.projectId" in web and
         "session.organizationId !== roleSettings.organizationId" in web),
        ("session validates role and TTL", "!validRoles(session.roles)" in web and
         "session.expiresAt <= Math.floor(Date.now() / 1000)" in web),
        ("positive and adversarial tests mandatory",
         "isolated signed-session browser → real Core" in matrix and
         "signed RR role with wrong project, organization, issuer or expiry is denied" in matrix),
        ("legacy signer retired",
         "QDIP_WEB_SESSION_SIGNING_SECRET" not in provision and
         "QDIP_WEB_SESSION_SIGNING_SECRET" not in browser),
        ("independent browser config is mandatory",
         "BROWSER_CONFIG_ARGS=(--config=playwright.rr-real.config.ts)" in runner and
         'pnpm exec playwright test "$SPEC" "${BROWSER_CONFIG_ARGS[@]}"' in runner and
         "cp suite/scripts/rr_real_playwright.config.ts observatory/playwright.rr-real.config.ts" in runner),
        ("browser starts anonymous, no Web default pre-signed cookie",
         "storageState: { cookies: [], origins: [] }" in browser_config and
         "oidcTestCookies" not in browser_config and
         "oidcTestConfig" not in browser_config),
        ("browser server signs with the same isolated secret",
         "'QDIP_AUTH_COOKIE_SECRET'" in browser_config and
         "env: Object.fromEntries(mandatory.map(" in browser_config and
         "reuseExistingServer: false" in browser_config),
    )
    errors = [name for name, valid in checks if not valid]
    if errors:
        raise RuntimeError("RR_E2E_OIDC_CONTRACT_MISMATCH: " + ", ".join(errors))


if __name__ == "__main__":
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise SystemExit("Only the disposable hosted E2E runner may qualify this contract")
    validate(Path(__file__).resolve().parents[2])
    print("RR_E2E_OIDC_SESSION_CONTRACT=PASS (static; live Zitadel NOT_TESTED)")
