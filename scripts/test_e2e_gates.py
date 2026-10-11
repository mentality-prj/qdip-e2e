"""Pure contract tests: no GitHub credentials or real source repositories."""
from __future__ import annotations

import base64
import unittest
from pathlib import Path
from unittest.mock import patch

import check_browser_report
import watch_core


def report(mode: str) -> dict:
    required = check_browser_report.MATRIX[mode]
    return {
        "suites": [{"specs": [{"title": title + " full test", "ok": True} for title in required]}],
        "stats": {"skipped": 0, "unexpected": 0, "expected": len(required)},
    }


class BrowserGateTests(unittest.TestCase):
    def test_both_positive_matrices(self) -> None:
        for mode in check_browser_report.MATRIX:
            with self.subTest(mode=mode):
                self.assertTrue(check_browser_report.validate(report(mode), mode))

    def test_missing_browser_case_is_not_pass(self) -> None:
        item = report("rr-plugin-v1")
        item["suites"][0]["specs"].pop()
        self.assertFalse(check_browser_report.validate(item, "rr-plugin-v1"))

    def test_failure_is_not_pass(self) -> None:
        item = report("rr-plugin-v1")
        item["suites"][0]["specs"][0]["ok"] = False
        self.assertFalse(check_browser_report.validate(item, "rr-plugin-v1"))

    def test_skipped_or_extra_cases_are_not_pass(self) -> None:
        item = report("rr-plugin-v1")
        item["stats"]["skipped"] = 1
        self.assertFalse(check_browser_report.validate(item, "rr-plugin-v1"))
        item = report("rr-plugin-v1")
        item["suites"][0]["specs"].append({"title": "irrelevant test", "ok": True})
        self.assertFalse(check_browser_report.validate(item, "rr-plugin-v1"))

    def test_unknown_contract_never_falls_back(self) -> None:
        self.assertFalse(check_browser_report.validate(report("legacy"), "unknown"))


class IsolatedOidcContractTests(unittest.TestCase):
    def test_e2e_session_uses_current_zitadel_environment_contract(self) -> None:
        bootstrap = Path("scripts/provision_tenants.py").read_text(encoding="utf-8")
        browser = Path("scripts/rr_oidc_session_browser.spec.ts").read_text(encoding="utf-8")
        for key in (
            "QDIP_WEB_SESSION_SIGNING_SECRET",
            "QDIP_RR_ALLOWED_ZITADEL_USER_IDS",
            "ZITADEL_ISSUER",
            "ZITADEL_CLIENT_ID",
            "RR_ACTOR_ASSERTION_SECRET",
        ):
            self.assertIn(key, bootstrap)
        for key in ("QDIP_WEB_SESSION_SIGNING_SECRET", "QDIP_RR_ALLOWED_ZITADEL_USER_IDS"):
            self.assertIn(key, browser)
        for legacy in (
            "QDIP_AUTH_COOKIE_SECRET",
            "QDIP_AUTH_OPERATOR_SUBJECTS",
            "QDIP_AUTH_ALLOWED_SUBJECTS",
        ):
            self.assertNotIn(legacy, bootstrap)
            self.assertNotIn(legacy, browser)


class ContractDiscoveryTests(unittest.TestCase):
    CORE = "a" * 40
    WEB = "b" * 40

    @staticmethod
    def web_source(code: str) -> dict:
        return {"type": "file", "content": base64.b64encode(code.encode()).decode()}

    def test_password_reference_operator_is_detected_by_real_web_source(self) -> None:
        results = [
            {"type": "file"},
            self.web_source("createOperatorSession() and verifyOperatorPassword()"),
        ]
        with patch.object(watch_core, "api", side_effect=results) as mock:
            self.assertEqual(
                watch_core.rr_contract_mode(self.CORE, self.WEB, "opaque"), "rr-plugin-v1"
            )
            self.assertIn("presentation.py", mock.call_args_list[0].args[0])
            self.assertIn(self.WEB, mock.call_args_list[1].args[0])

    def test_signed_oidc_session_contract_has_dedicated_required_mode(self) -> None:
        results = [
            {"type": "file"},
            self.web_source("Password authentication retired; use Zitadel OIDC"),
        ]
        with patch.object(watch_core, "api", side_effect=results):
            self.assertEqual(
                watch_core.rr_contract_mode(self.CORE, self.WEB, "opaque"), "rr-oidc-session-v1"
            )

    def test_old_backend_selects_legacy_only_on_actual_404(self) -> None:
        with patch.object(watch_core, "api", side_effect=FileNotFoundError):
            self.assertEqual(watch_core.rr_contract_mode(self.CORE, self.WEB, "opaque"), "legacy")

    def test_unknown_web_contract_fails_closed(self) -> None:
        results = [{"type": "file"}, self.web_source("unknown login implementation")]
        with patch.object(watch_core, "api", side_effect=results):
            with self.assertRaises(RuntimeError):
                watch_core.rr_contract_mode(self.CORE, self.WEB, "opaque")

    def test_network_or_auth_error_does_not_silently_downgrade(self) -> None:
        with patch.object(watch_core, "api", side_effect=RuntimeError("GitHub authentication denied")):
            with self.assertRaises(RuntimeError):
                watch_core.rr_contract_mode(self.CORE, self.WEB, "opaque")


if __name__ == "__main__":
    unittest.main()
