"""Pure contract tests: no GitHub credentials or real source repositories."""
from __future__ import annotations

import base64
import unittest
from pathlib import Path
from unittest.mock import patch

import check_browser_report
import watch_core
import verify_dispatch


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


class IsolatedOidcFixtureTests(unittest.TestCase):
    @staticmethod
    def source(name: str) -> str:
        return (Path(__file__).parent / name).read_text(encoding="utf-8")

    def test_e2e_session_fixture_uses_current_web_229_names(self) -> None:
        provision = self.source("provision_tenants.py")
        browser = self.source("rr_oidc_session_browser.spec.ts")
        current = {
            "QDIP_WEB_SESSION_SIGNING_SECRET",
            "QDIP_RR_ALLOWED_ZITADEL_USER_IDS",
            "QDIP_STUDIO_ALLOWED_ZITADEL_USER_IDS",
        }
        for key in current:
            with self.subTest(name=key):
                self.assertIn(key, provision)
                self.assertIn(key, browser)
        for retired in (
            "QDIP_AUTH_COOKIE_SECRET",
            "QDIP_AUTH_ALLOWED_SUBJECTS",
            "QDIP_AUTH_OPERATOR_SUBJECTS",
        ):
            with self.subTest(retired=retired):
                self.assertNotIn(retired, provision)
                self.assertNotIn(retired, browser)

    def test_studio_only_subject_is_a_required_negative_browser_case(self) -> None:
        provision = self.source("provision_tenants.py")
        browser = self.source("rr_oidc_session_browser.spec.ts")
        self.assertIn('"qdip-e2e-operator"', provision)
        self.assertIn('"qdip-e2e-studio-only"', provision)
        self.assertIn("Studio-only Zitadel subject cannot access RR operator", browser)
        required = check_browser_report.MATRIX["rr-oidc-session-v1"]
        self.assertEqual(len(required), 6)
        self.assertIn("Studio-only Zitadel subject cannot access RR operator", required)
        test_report = report("rr-oidc-session-v1")
        self.assertTrue(check_browser_report.validate(test_report, "rr-oidc-session-v1"))
        test_report["suites"][0]["specs"] = [
            spec for spec in test_report["suites"][0]["specs"]
            if not spec["title"].startswith("Studio-only Zitadel subject")
        ]
        self.assertFalse(check_browser_report.validate(test_report, "rr-oidc-session-v1"))


class ActiveQualificationRefTests(unittest.TestCase):
    def test_rr_feature_tracks_current_web_feature_and_not_retired_branch(self) -> None:
        current = "feat/rr-plugin-computation-ownership"
        self.assertIn(current, watch_core.BRANCHES)
        self.assertNotIn("feat/rr-prod-01-normalized-source-import", watch_core.BRANCHES)
        self.assertEqual(watch_core.OBS_BRANCHES[current], "feat/qdip-zitadel-oidc")
        self.assertEqual(watch_core.OBS_BRANCHES["dev"], "dev")

    def test_dispatch_refuses_cross_product_branch_pair_before_any_network(self) -> None:
        environment = {
            "BACKEND_SHA": "a" * 40,
            "BACKEND_BRANCH": "feat/rr-plugin-computation-ownership",
            "OBSERVATORY_REF": "dev",
            "QDIP_READ_TOKEN": "not-a-real-token",
        }
        with patch.dict("os.environ", environment), patch.object(verify_dispatch, "get") as remote:
            with self.assertRaisesRegex(RuntimeError, "mismatched Core/Web"):
                verify_dispatch.main()
            remote.assert_not_called()


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
