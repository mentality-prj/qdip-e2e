"""Fast offline regression checks for SHA-pinned public E2E control plane."""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import watch_core
import verify_dispatch
import report_run


class RunnerIntegrityTests(unittest.TestCase):
    def test_fingerprint_ignores_generated_cache_not_tracked_mutations(self) -> None:
        with tempfile.TemporaryDirectory() as location:
            root = Path(location)
            (root / "scripts").mkdir()
            (root / "fixtures").mkdir()
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".github/workflows/real-e2e.yml").write_text("name: E2E\n")
            (root / "scripts/watch_core.py").write_text("# tracked\n")
            (root / "fixtures/rr.json").write_text("{}\n")
            subprocess.run(
                ["git", "init", "-q"], cwd=root, check=True,
                stdout=subprocess.DEVNULL,
            )
            subprocess.run(
                ["git", "add", "-A"], cwd=root, check=True,
                stdout=subprocess.DEVNULL,
            )
            with patch.object(
                watch_core, "__file__", str(root / "scripts/watch_core.py")
            ):
                pinned = watch_core.fingerprint()
                (root / "scripts/__pycache__").mkdir()
                (root / "scripts/__pycache__/watch_core.pyc").write_bytes(b"generated")
                (root / "fixtures/untracked.txt").write_text("ignored")
                self.assertEqual(watch_core.fingerprint(), pinned)
                (root / "scripts/watch_core.py").write_text("# changed\n")
                self.assertNotEqual(watch_core.fingerprint(), pinned)
                (root / "scripts/watch_core.py").unlink()
                with self.assertRaisesRegex(RuntimeError, "Missing tracked"):
                    watch_core.fingerprint()

    def test_dispatch_pins_entire_qualification_pair(self) -> None:
        core, web, suite = "a" * 40, "b" * 40, "c" * 40
        key = "d" * 64
        with patch.object(watch_core, "api", return_value={}) as mock_api:
            watch_core.dispatch("dev", core, web, "fake-token",
                                "rr-oidc-session-v1", "dev", key, suite)
        payload = mock_api.call_args.kwargs["body"]["client_payload"]
        self.assertEqual(payload["backend_sha"], core)
        self.assertEqual(payload["observatory_sha"], web)
        self.assertEqual(payload["suite_sha"], suite)
        self.assertEqual(payload["qualification_key"], key)
        self.assertEqual(payload["observatory_ref"], "dev")

    def test_core_unrelated_skip_requires_prior_pass_and_same_web_suite(self) -> None:
        prior = {"last_attempt": {
            "status": "PASS", "obs_sha": "b" * 40, "suite_sha": "c" * 40,
            "suite_fingerprint": "e" * 64,
        }}
        with patch.object(watch_core, "relevant_changes", return_value=False):
            self.assertTrue(watch_core.should_skip_unrelated(
                prior, "a" * 40, "d" * 40, "b" * 40, "c" * 40, "e" * 64, "token"
            ))
            self.assertFalse(watch_core.should_skip_unrelated(
                prior, "a" * 40, "d" * 40, "z" * 40, "c" * 40, "e" * 64, "token"
            ))
            self.assertFalse(watch_core.should_skip_unrelated(
                prior, "a" * 40, "d" * 40, "b" * 40, "f" * 40, "e" * 64, "token"
            ))
            self.assertFalse(watch_core.should_skip_unrelated(
                {"last_attempt": {**prior["last_attempt"], "status": "TEST_FAIL"}},
                "a" * 40, "d" * 40, "b" * 40, "c" * 40, "e" * 64, "token"
            ))

    def test_dispatch_provenance_checks_both_revisions_and_key(self) -> None:
        core, web, suite = "a" * 40, "b" * 40, "c" * 40
        mode = "rr-oidc-session-v1"
        key = hashlib.sha256(f"{core}:{web}:{suite}:fingerprint:{mode}".encode()).hexdigest()
        env = {
            "BACKEND_SHA": core, "BACKEND_BRANCH": "dev",
            "OBSERVATORY_SHA": web, "OBSERVATORY_REF": "dev",
            "E2E_SUITE_SHA": suite, "QUALIFICATION_KEY": key,
            "RR_E2E_CONTRACT_MODE": mode, "QDIP_READ_TOKEN": "fake",
        }
        with patch.dict(os.environ, env, clear=True), \
             patch.object(verify_dispatch, "fingerprint", return_value="fingerprint"), \
             patch.object(verify_dispatch.subprocess, "check_output", return_value=suite + "\n"), \
             patch.object(verify_dispatch, "require_reachable") as reachable:
            verify_dispatch.main()
            self.assertEqual(reachable.call_count, 2)
            reachable.assert_any_call(verify_dispatch.CORE, "dev", core, "fake")
            reachable.assert_any_call(verify_dispatch.WEB, "dev", web, "fake")
            with patch.dict(os.environ, {"OBSERVATORY_SHA": "x" * 40}):
                with self.assertRaises(RuntimeError):
                    verify_dispatch.main()

    def test_stale_completion_cannot_override_newer_test(self) -> None:
        previous = {
            "version": 1,
            "branches": {"dev": {"last_attempt": {
                "backend_sha": "a" * 40, "obs_sha": "new" * 13 + "n",
                "suite_sha": "c" * 40, "key": "d" * 64,
            }}},
        }
        response = {
            "content": base64.b64encode(json.dumps(previous).encode()).decode(),
            "sha": "fake-blob-sha",
        }
        env = {
            "GITHUB_TOKEN": "fake", "E2E_BRANCH": "dev",
            "E2E_SHA": "a" * 40, "E2E_WEB_SHA": "b" * 40,
            "E2E_SUITE_SHA": "c" * 40, "E2E_QUALIFICATION_KEY": "d" * 64,
            "E2E_JOB_STATUS": "success", "GITHUB_RUN_ID": "42",
            "E2E_PHASES_PATH": "/tmp/nonexistent-qdip-e2e-test-status",
        }
        with patch.dict(os.environ, env, clear=True), \
             patch.object(report_run, "exchange", return_value=response) as exchange, \
             redirect_stdout(io.StringIO()) as stdout:
            report_run.main()
        self.assertIn("STALE_RUN_IGNORED", stdout.getvalue())
        exchange.assert_called_once()


if __name__ == "__main__":
    unittest.main()
