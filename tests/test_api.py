"""Smoke tests for the HTTP layer -- no switch required.

Covers the routes that must work before you ever plug a cable in: the plan
endpoint (pure, offline), the auth gate on every switch-touching route, and the
static frontend actually being served.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

client = TestClient(app)

CHECKS: list[tuple[str, callable]] = []


def check(name):
    def wrap(fn):
        CHECKS.append((name, fn))
        return fn
    return wrap


@check("frontend is served")
def _t_index():
    res = client.get("/")
    assert res.status_code == 200, res.status_code
    assert "ProCurve Cockpit" in res.text
    for asset in ("/static/app.css", "/static/js/app.js", "/static/js/panels/ports.js"):
        assert client.get(asset).status_code == 200, asset


@check("plan endpoint works offline")
def _t_plan():
    res = client.post("/api/plan", json={
        "intent": "vlan.create",
        "payload": {"id": 42, "name": "Gaeste", "untagged": ["5", "6", "7"]},
    })
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["commands"] == [
        "vlan 42", 'name "Gaeste"', "untagged 5-7", "exit",
    ], body["commands"]


@check("plan endpoint reports bad input as 400")
def _t_plan_bad():
    res = client.post("/api/plan", json={"intent": "vlan.create", "payload": {"id": 9999}})
    assert res.status_code == 400, res.status_code
    assert "4094" in res.json()["detail"], res.json()

    res = client.post("/api/plan", json={"intent": "does.not.exist", "payload": {}})
    assert res.status_code == 400, res.status_code


@check("plan surfaces lockout risks")
def _t_plan_risk():
    res = client.post("/api/plan", json={
        "intent": "access.set",
        "payload": {"ssh": False},
    })
    body = res.json()
    assert any(r["level"] == "danger" for r in body["risks"]), body


@check("firmware plans are exec level and carry their risks")
def _t_plan_firmware():
    res = client.post("/api/plan", json={
        "intent": "firmware.boot", "payload": {"image": "secondary"},
    })
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["exec_level"] is True, body
    assert body["commands"] == ["boot system flash secondary"], body
    assert any(r["level"] == "danger" for r in body["risks"]), body

    res = client.post("/api/plan", json={
        "intent": "firmware.reload", "payload": {"mode": "cancel"},
    })
    body = res.json()
    assert body["commands"] == ["reload cancel"], body
    assert not any(r["level"] == "danger" for r in body["risks"]), body

    res = client.post("/api/plan", json={
        "intent": "firmware.boot", "payload": {"image": "tertiary"},
    })
    assert res.status_code == 400, res.status_code


@check("switch routes require a session")
def _t_auth_gate():
    for method, path, payload in [
        ("get", "/api/status", None),
        ("get", "/api/data/ports", None),
        ("get", "/api/data/firmware", None),
        ("post", "/api/apply", {"commands": ["boot"], "exec_level": True}),
        ("post", "/api/apply", {"commands": ["hostname \"x\""]}),
        ("post", "/api/exec", {"command": "show version"}),
        ("post", "/api/save", None),
        ("get", "/api/config/download", None),
    ]:
        res = getattr(client, method)(path, **({"json": payload} if payload else {}))
        assert res.status_code == 401, f"{path} -> {res.status_code}"


@check("unknown data section is a 404")
def _t_unknown_section():
    # Checked before the auth gate would matter, so a typo is not reported as
    # "not connected".
    res = client.get("/api/data/nonsense")
    assert res.status_code == 404, res.status_code


def main() -> int:
    failed = 0
    for name, fn in CHECKS:
        try:
            fn()
        except AssertionError as exc:
            failed += 1
            print(f"FAIL  {name}\n      {exc}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"ERROR {name}\n      {type(exc).__name__}: {exc}")
        else:
            print(f"ok    {name}")
    print(f"\n{len(CHECKS) - failed}/{len(CHECKS)} passed")
    return 1 if failed else 0


def test_all():
    assert main() == 0


if __name__ == "__main__":
    raise SystemExit(main())
