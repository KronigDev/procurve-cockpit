"""FastAPI application: REST + WebSocket in front of a live ProCurve session.

Paramiko is blocking, so every switch interaction is dispatched to a worker
thread.  The switch itself has a single CLI session, which is why
:class:`~backend.transport.ProCurveShell` serialises on a lock -- concurrent
requests queue rather than interleave.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .device import ProCurveDevice
from .plan import PlanError, build
from .transport import AuthError, TransportError, missing_legacy_support


def paramiko_version() -> str:
    import paramiko

    return paramiko.__version__

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("cockpit")

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


@asynccontextmanager
async def lifespan(_app: FastAPI):
    missing = missing_legacy_support()
    if missing:
        log.warning(
            "This paramiko (%s) lacks %s -- SSH to a ProVision switch will fail. "
            "Install paramiko 3.x.",
            paramiko_version(),
            ", ".join(missing),
        )
    yield
    for session in list(SESSIONS.values()):
        try:
            session.device.close()
        except Exception:  # noqa: BLE001 - shutdown must not raise
            pass
    SESSIONS.clear()


app = FastAPI(title="ProCurve Cockpit", version="1.0.0", lifespan=lifespan)


@app.middleware("http")
async def no_stale_frontend(request, call_next):
    """Force the browser to revalidate the frontend on every load.

    Browsers happily serve stale JS/CSS from the memory cache without asking;
    after an update that meant old panels until a hard refresh.  `no-cache`
    still allows 304s (cheap), but never a silent stale copy.
    """
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response


# --------------------------------------------------------------------------
# session registry
# --------------------------------------------------------------------------


class Session:
    def __init__(self, device: ProCurveDevice) -> None:
        self.device = device
        self.token = uuid4().hex
        self.created = time.time()
        self.last_used = time.time()
        self.history: list[dict[str, Any]] = []

    def note(self, kind: str, detail: dict[str, Any]) -> None:
        self.history.append({"at": time.time(), "kind": kind, **detail})
        del self.history[:-500]


SESSIONS: dict[str, Session] = {}


def get_session(token: str | None) -> Session:
    if not token or token not in SESSIONS:
        raise HTTPException(status_code=401, detail="Not connected. Open a session first.")
    session = SESSIONS[token]
    session.last_used = time.time()
    return session


async def in_thread(func, *args, **kwargs):
    """Run a blocking device call off the event loop, mapping errors to HTTP."""
    try:
        return await asyncio.to_thread(func, *args, **kwargs)
    except AuthError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except TransportError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


# --------------------------------------------------------------------------
# models
# --------------------------------------------------------------------------


class ConnectRequest(BaseModel):
    host: str
    username: str = "manager"
    password: str = ""
    enable_password: str = ""
    transport: str = Field(default="ssh", pattern="^(ssh|telnet)$")
    port: int | None = None
    legacy: bool = True
    timeout: float = 20.0


class PlanRequest(BaseModel):
    intent: str
    payload: dict[str, Any] = Field(default_factory=dict)


class ApplyRequest(BaseModel):
    commands: list[str]
    save: bool = False
    confirm_danger: bool = False
    #: True runs the commands at manager exec level (boot, reload, copy, erase)
    #: instead of entering configuration mode.
    exec_level: bool = False


class ExecRequest(BaseModel):
    command: str
    timeout: float = 60.0


class ConfigUploadRequest(BaseModel):
    lines: list[str]
    save: bool = False


class ShowRequest(BaseModel):
    command: str
    timeout: float = 60.0


# --------------------------------------------------------------------------
# connection lifecycle
# --------------------------------------------------------------------------


@app.post("/api/connect")
async def connect(req: ConnectRequest) -> dict[str, Any]:
    try:
        device = await asyncio.to_thread(
            ProCurveDevice.connect,
            req.host,
            req.username,
            req.password,
            transport=req.transport,
            port=req.port,
            enable_password=req.enable_password,
            legacy=req.legacy,
            timeout=req.timeout,
        )
    except AuthError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except TransportError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=502, detail=f"Cannot reach {req.host}: {exc}") from exc

    session = Session(device)
    SESSIONS[session.token] = session
    system = await in_thread(device.system)
    return {
        "token": session.token,
        "host": req.host,
        "transport": req.transport,
        "host_key": device.host_key,
        "system": system,
    }


@app.post("/api/disconnect")
async def disconnect(x_session: str | None = Header(default=None)) -> dict[str, str]:
    session = get_session(x_session)
    await asyncio.to_thread(session.device.close)
    SESSIONS.pop(session.token, None)
    return {"status": "disconnected"}


@app.get("/api/status")
async def status(x_session: str | None = Header(default=None)) -> dict[str, Any]:
    session = get_session(x_session)
    device = session.device
    return {
        "host": device.host,
        "prompt": device.shell.state.prompt,
        "level": device.shell.state.level,
        "context": device.shell.state.context,
        "capabilities": device.caps.__dict__,
        "connected_for": time.time() - device.connected_at,
        "history": session.history[-50:],
    }


# --------------------------------------------------------------------------
# read endpoints
# --------------------------------------------------------------------------

SECTIONS = {
    "system": lambda d: d.system(),
    "ports": lambda d: d.ports(),
    "vlans": lambda d: d.vlans(),
    "trunks": lambda d: d.trunks(),
    "stp": lambda d: d.spanning_tree(),
    "neighbors": lambda d: d.neighbors(),
    "forwarding": lambda d: d.forwarding(),
    "routing": lambda d: d.routing(),
    "poe": lambda d: d.poe(),
    "security": lambda d: d.security(),
    "qos": lambda d: d.qos(),
    "acls": lambda d: d.acls(),
    "logging": lambda d: d.logging(),
    "protocols": lambda d: d.protocols(),
    "extras": lambda d: d.extras(),
    "firmware": lambda d: d.firmware(),
    "config": lambda d: d.config(),
}


@app.get("/api/data/{section}")
async def data(section: str, x_session: str | None = Header(default=None)) -> dict[str, Any]:
    if section not in SECTIONS:
        raise HTTPException(status_code=404, detail=f"Unknown section {section!r}")
    session = get_session(x_session)
    payload = await in_thread(SECTIONS[section], session.device)
    return {"section": section, "data": payload, "fetched_at": time.time()}


@app.post("/api/show")
async def show_structured(
    req: ShowRequest, x_session: str | None = Header(default=None)
) -> dict[str, Any]:
    """A single ``show`` command with arguments, parsed into the generic
    structure -- per-port statistics, RMON, ACL counters, `show tech`."""
    command = req.command.strip()
    if not re.match(r"(?i)^show(\s|$)", command) or "\n" in command:
        raise HTTPException(status_code=400, detail="Only single 'show' commands are allowed here.")
    session = get_session(x_session)
    return await in_thread(session.device.show_structured, command, req.timeout)


@app.post("/api/probe")
async def probe(x_session: str | None = Header(default=None)) -> dict[str, Any]:
    session = get_session(x_session)
    caps = await in_thread(session.device.probe)
    return caps.__dict__


# --------------------------------------------------------------------------
# write endpoints
# --------------------------------------------------------------------------


@app.post("/api/plan")
async def make_plan(req: PlanRequest) -> dict[str, Any]:
    """Pure function: build the CLI for an intent without touching the switch."""
    try:
        return build(req.intent, req.payload).as_dict()
    except PlanError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/apply")
async def apply(
    req: ApplyRequest, x_session: str | None = Header(default=None)
) -> dict[str, Any]:
    session = get_session(x_session)
    if not req.commands:
        raise HTTPException(status_code=400, detail="No commands to apply.")
    result = await in_thread(
        session.device.apply, req.commands, save=req.save, exec_level=req.exec_level
    )
    session.note(
        "apply",
        {
            "commands": req.commands,
            "ok": result["ok"],
            "save": req.save,
            "exec": req.exec_level,
        },
    )
    return result


@app.post("/api/exec")
async def execute(
    req: ExecRequest, x_session: str | None = Header(default=None)
) -> dict[str, Any]:
    """Run a single command verbatim (console + 'show me the raw output' views)."""
    session = get_session(x_session)
    result = await in_thread(session.device.run_raw, req.command, req.timeout)
    session.note("exec", {"command": req.command, "ok": result["ok"]})
    return result


@app.post("/api/save")
async def save(x_session: str | None = Header(default=None)) -> dict[str, Any]:
    session = get_session(x_session)
    result = await in_thread(session.device.write_memory)
    session.note("save", {"ok": result["ok"]})
    return result


# --------------------------------------------------------------------------
# config file handling
# --------------------------------------------------------------------------


@app.get("/api/config/download")
async def download_config(x_session: str | None = Header(default=None)) -> PlainTextResponse:
    session = get_session(x_session)
    payload = await in_thread(session.device.config)
    hostname = session.device.shell.state.hostname or "switch"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return PlainTextResponse(
        "\n".join(payload["running"]) + "\n",
        headers={
            "Content-Disposition": f'attachment; filename="{hostname}-{stamp}.cfg"',
        },
    )


@app.post("/api/config/upload")
async def upload_config(
    req: ConfigUploadRequest, x_session: str | None = Header(default=None)
) -> dict[str, Any]:
    """Push config lines through config mode.

    This is deliberately *not* a replace: ProVision has no atomic config
    replace over the CLI, so lines are merged and the caller sees each result.
    """
    session = get_session(x_session)
    lines = [ln for ln in req.lines if ln.strip() and not ln.strip().startswith(";")]
    if not lines:
        raise HTTPException(status_code=400, detail="Nothing to upload.")
    result = await in_thread(session.device.apply, lines, save=req.save)
    session.note("upload", {"count": len(lines), "ok": result["ok"]})
    return result


# --------------------------------------------------------------------------
# live console
# --------------------------------------------------------------------------


@app.websocket("/ws/cli")
async def cli(ws: WebSocket) -> None:
    await ws.accept()
    token = ws.query_params.get("token")
    if not token or token not in SESSIONS:
        await ws.send_json({"type": "error", "message": "Not connected."})
        await ws.close()
        return
    session = SESSIONS[token]
    device = session.device
    await ws.send_json({"type": "prompt", "prompt": device.shell.state.prompt})

    # The console is genuinely interactive: when the switch pauses at a
    # question (`snmpv3 enable`, an unanswered [y/n]), at_prompt goes False
    # and the next line typed is the answer. Nothing is auto-answered here.
    at_prompt = True
    try:
        while True:
            message = await ws.receive_text()
            try:
                payload = json.loads(message)
            except json.JSONDecodeError:
                payload = {"command": message}
            try:
                if payload.get("interrupt"):
                    result = await asyncio.to_thread(device.console_interrupt)
                    command = "^C"
                else:
                    command = (payload.get("command") or "").rstrip("\n")
                    if not command.strip() and at_prompt:
                        await ws.send_json(
                            {"type": "prompt", "prompt": device.shell.state.prompt}
                        )
                        continue
                    await ws.send_json({"type": "echo", "command": command})
                    result = await asyncio.to_thread(
                        device.console_exchange, command, float(payload.get("timeout", 45))
                    )
            except TransportError as exc:
                await ws.send_json({"type": "error", "message": str(exc)})
                break
            at_prompt = result["at_prompt"]
            session.note("cli", {"command": command, "ok": True})
            await ws.send_json(
                {
                    "type": "output",
                    "command": command,
                    "output": result["output"],
                    "error": None,
                    "prompt": result["prompt"],
                    "at_prompt": at_prompt,
                }
            )
    except WebSocketDisconnect:
        return
    except Exception as exc:  # noqa: BLE001 - report, do not crash the socket
        log.exception("cli socket failed")
        try:
            await ws.send_json({"type": "error", "message": str(exc)})
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------
# static frontend
# --------------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index() -> FileResponse:
    return FileResponse(FRONTEND / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
