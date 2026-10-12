"""Contract tests for the zero-leak private-Core Actions access diagnostic."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import diagnose_core_access as diagnostic


class SourceAccessDiagnosticTests(unittest.TestCase):
    def test_private_core_404_is_not_a_permission_success(self):
        self.assertEqual(
            diagnostic.classification({
                "AUTHENTICATED_ACTOR": 200,
                "PUBLIC_WEB_REPOSITORY": 200,
                "PRIVATE_CORE_REPOSITORY": 404,
                "PRIVATE_CORE_DEV_REF": 404,
                "PRIVATE_CORE_SOURCE": 404,
            }),
            "CORE_NOT_VISIBLE_TO_THIS_ACTIONS_SECRET",
        )

    def test_token_is_not_assumed_valid_from_public_web_access(self):
        self.assertEqual(
            diagnostic.classification({
                "AUTHENTICATED_ACTOR": 401,
                "PUBLIC_WEB_REPOSITORY": 200,
                "PRIVATE_CORE_REPOSITORY": 404,
            }),
            "TOKEN_INVALID_EXPIRED_OR_NOT_AUTHENTICATED",
        )

    def test_private_repo_visible_but_ref_hidden(self):
        self.assertEqual(
            diagnostic.classification({
                "AUTHENTICATED_ACTOR": 200,
                "PRIVATE_CORE_REPOSITORY": 200,
                "PRIVATE_CORE_DEV_REF": 404,
                "PRIVATE_CORE_SOURCE": 404,
            }),
            "CORE_VISIBLE_BUT_DEV_REF_NOT_READABLE",
        )

    def test_exact_private_ref_and_source_are_required(self):
        complete = dict.fromkeys((item[0] for item in diagnostic.PROBES), 200)
        self.assertEqual(diagnostic.classification(complete), "PASS")
        complete["PRIVATE_CORE_SOURCE"] = 403
        self.assertEqual(diagnostic.classification(complete), "CORE_REF_VISIBLE_BUT_CONTENTS_NOT_READABLE")


if __name__ == "__main__":
    unittest.main()
