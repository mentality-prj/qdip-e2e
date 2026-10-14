#!/usr/bin/env python3
"""Read-only, no-credentials preflight against the real public QDIP/Zitadel OIDC path.

This intentionally cannot prove a real user's login or organization grants.
No passwords, access tokens, session cookies, request URLs with nonce/state, or
unredacted upstream JSON are printed. All network operations are GET only.
"""
from __future__ import annotations

import json
import re
import sys
from http.cookiejar import CookieJar
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

SITE = "https://qdip.ai"
RR = "https://observatory.qdip.ai"
EXPECTED_CLIENT = "394566248211424533"
EXPECTED_PROJECT = "394565917515719957"
REDIRECT_URI = SITE + "/api/auth/callback/zitadel"
MAX_BODY = 200_000


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = build_opener(NoRedirect)
GOOD = set()


def check(condition: bool, stage: str) -> None:
    if not condition:
        raise AssertionError(stage)
    GOOD.add(stage)


def get(url: str, *, headers: dict[str, str] | None = None):
    req = Request(url, headers={"User-Agent": "QDIP-OIDC-Public-Preflight/1", **(headers or {})})
    try:
        response = OPENER.open(req, timeout=15)
    except HTTPError as exc:
        response = exc
    status = response.status
    meta = response.headers
    body = response.read(MAX_BODY + 1)
    response.close()
    check(len(body) <= MAX_BODY, "response_size_limit")
    return status, meta, body


def read_json(url: str, *, headers: dict[str, str] | None = None):
    status, meta, data = get(url, headers=headers)
    check(status == 200, "json_http_200")
    check("json" in (meta.get("Content-Type") or "").lower(), "json_content_type")
    value = json.loads(data.decode("utf-8"))
    check(isinstance(value, dict), "json_object")
    return meta, value


def single(params: dict[str, list[str]], key: str) -> str:
    value = params.get(key, [])
    check(len(value) == 1 and bool(value[0]), "one_" + key)
    return value[0]


def live_login() -> None:
    status, headers, _ = get(SITE + "/api/auth/login")
    check(status == 302, "login_302")
    check("no-store" in (headers.get("Cache-Control") or "").lower(), "login_no_store")
    location = headers.get("Location") or ""
    parsed = urlsplit(location)
    check(parsed.scheme == "https" and parsed.hostname and parsed.username is None and parsed.password is None, "login_https_idp")
    issuer = parsed.scheme + "://" + parsed.netloc
    check(issuer != SITE and not parsed.fragment, "external_issuer_redirect")
    query = parse_qs(parsed.query, keep_blank_values=True)
    check(single(query, "client_id") == EXPECTED_CLIENT, "correct_oidc_client")
    check(single(query, "redirect_uri") == REDIRECT_URI, "correct_callback")
    check(single(query, "response_type") == "code", "authorization_code_flow")
    check(single(query, "code_challenge_method") == "S256", "pkce_s256")
    check(re.fullmatch(r"[A-Za-z0-9_-]{43,128}", single(query, "code_challenge")) is not None, "pkce_challenge")
    check(re.fullmatch(r"[A-Za-z0-9_-]{30,128}", single(query, "nonce")) is not None, "oidc_nonce")
    check(re.fullmatch(r"[A-Za-z0-9_-]{30,128}", single(query, "state")) is not None, "oidc_state")
    scope = single(query, "scope").split()
    check("openid" in scope and "urn:zitadel:iam:org:projects:roles" in scope, "role_claim_scopes")
    check("urn:zitadel:iam:org:project:id:" + EXPECTED_PROJECT + ":aud" in scope, "expected_project_audience")
    cookies = headers.get_all("Set-Cookie") or []
    flow_cookies = [c for c in cookies if c.startswith("qdip_oidc_flow=")]
    check(len(flow_cookies) == 1, "flow_cookie_issued")
    cookie = flow_cookies[0].lower()
    check(all(x in cookie for x in ("httponly", "secure", "samesite=lax", "path=/")), "secure_flow_cookie")
    check("domain=" not in cookie and "qdip_oidc_session=" not in cookie, "flow_cookie_host_only")

    discovery_headers, discovery = read_json(issuer + "/.well-known/openid-configuration")
    check(discovery.get("issuer") == issuer, "issuer_pinned")
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        raw = discovery.get(key)
        check(isinstance(raw, str) and raw.startswith(issuer + "/"), key + "_same_issuer")
    check(location.startswith(discovery["authorization_endpoint"] + "?"), "authorization_endpoint_verified")
    _, jwks = read_json(discovery["jwks_uri"])
    keys = jwks.get("keys")
    check(isinstance(keys, list) and any(
        isinstance(key, dict) and key.get("kty") == "RSA"
        and (key.get("use") in (None, "sig"))
        and isinstance(key.get("kid"), str) and key.get("kid")
        for key in keys
    ), "jwks_rsa_signing_key")


def anonymous() -> None:
    # No cookies: check real production host and real RR host independently.
    for base, path, label in (
        (SITE, "/api/auth/session", "site"),
        (RR, "/api/rr-operator/session", "rr"),
    ):
        meta, body = read_json(base + path)
        check(body.get("configured") is True, label + "_oidc_configured")
        check(body.get("authenticated") is False, label + "_anonymous_denied")
        check("no-store" in (meta.get("Cache-Control") or "").lower(), label + "_no_cache")
        if label == "site":
            check(body.get("operator") is False and body.get("studio") is False, "site_no_roles")
        # A forged client cookie must not authorize the visitor.
        _, forged = read_json(base + path, headers={"Cookie": "qdip_oidc_session=forged.invalid"})
        check(forged.get("authenticated") is False, label + "_forged_session_denied")


def main() -> int:
    try:
        live_login()
        anonymous()
    except (AssertionError, ValueError, KeyError, TypeError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        # Print the failure category only, never the request URL/body/cookie.
        failure = str(exc) if isinstance(exc, AssertionError) and str(exc) else type(exc).__name__
        if not re.fullmatch(r"[A-Za-z0-9_]{1,80}", failure):
            failure = type(exc).__name__
        print("QDIP_LIVE_ZITADEL_PUBLIC_PREFLIGHT=FAIL " + failure)
        print("QDIP_LIVE_ZITADEL_REAL_USER_LOGIN=NOT_TESTED")
        return 1
    print("QDIP_LIVE_ZITADEL_PUBLIC_PREFLIGHT=PASS")
    print("QDIP_PUBLIC_AUTH_CHECK_COUNT=" + str(len(GOOD)))
    print("QDIP_LIVE_ZITADEL_REAL_USER_LOGIN=NOT_TESTED")
    print("QDIP_LIVE_ZITADEL_REAL_USER_ROLE_GRANTS=NOT_TESTED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
