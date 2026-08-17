"""Low level transports to an HP ProCurve / ProVision switch (2910al & friends).

Two things make these boxes awkward to talk to from a 2026 machine:

* Their SSH server only offers pre-2010 crypto (``diffie-hellman-group14-sha1``,
  ``ssh-rsa`` host keys, ``aes*-cbc`` + ``hmac-sha1``).  Paramiko still *ships*
  those primitives but does not always *offer* them, so we reorder the preferred
  algorithm lists by hand instead of relying on ``disabled_algorithms``.
* Plenty of 2910al units in the wild never had ``ip ssh`` enabled, so telnet has
  to stay an option -- and ``telnetlib`` was removed from the stdlib in 3.13.
  We therefore speak just enough of RFC 854 ourselves.

Everything above the raw byte channel (banner, paging, prompt tracking, enable)
lives in :class:`ProCurveShell`, which both transports share.
"""

from __future__ import annotations

import logging
import re
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Protocol, Sequence

import paramiko

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------
# terminal output cleanup
# --------------------------------------------------------------------------

ANSI_RE = re.compile(
    r"\x1b\[[0-9;?]*[ -/]*[@-~]"        # CSI sequences
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC sequences
    r"|\x1b[=>NOM78cD]"                  # single char escapes
    r"|\x1b\([AB012]"                    # charset selection
)


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text.replace("\x00", ""))


def render_overwrites(text: str) -> str:
    """Apply CR/backspace overwrites the way a real terminal would.

    ProCurve erases its ``-- MORE --`` prompt by printing ``\\r``, spaces and
    another ``\\r``.  Without this the erased text would end up in the middle of
    parsed output.
    """
    out: list[str] = []
    for raw in text.split("\n"):
        if "\r" not in raw and "\b" not in raw:
            out.append(raw.rstrip())
            continue
        buf: list[str] = []
        col = 0
        for ch in raw:
            if ch == "\r":
                col = 0
            elif ch == "\b":
                col = max(0, col - 1)
            else:
                if col < len(buf):
                    buf[col] = ch
                else:
                    buf.extend(" " * (col - len(buf)))
                    buf.append(ch)
                col += 1
        out.append("".join(buf).rstrip())
    return "\n".join(out)


def clean(text: str) -> str:
    """Full cleanup pass: drop escape codes, then apply cursor overwrites."""
    return render_overwrites(strip_ansi(text))


# --------------------------------------------------------------------------
# prompt / interaction detection
# --------------------------------------------------------------------------

# `SWITCH#`, `SWITCH>`, `SWITCH(config)#`, `SWITCH(vlan-10)#`, `SWITCH(eth-1-4)#`
PROMPT_RE = re.compile(
    r"(?m)^[ \t]*(?P<host>[A-Za-z0-9][\w.\-]*)"
    r"(?P<ctx>\([^)\r\n]*\))?[ \t]*(?P<level>[#>])[ \t]*\Z"
)
MORE_RE = re.compile(r"--\s*MORE\s*--", re.I)
ANYKEY_RE = re.compile(r"press any key to continue", re.I)
CONFIRM_RE = re.compile(r"(\[y/n\]|\(y/n\)|\[yes/no\]|\(yes/no\))[^\n]*\??\s*\Z", re.I)
USER_PROMPT_RE = re.compile(r"(?:^|\n)\s*(?:username|login)\s*:\s*\Z", re.I)
PASS_PROMPT_RE = re.compile(r"(?:^|\n)\s*password\s*:\s*\Z", re.I)

# ProCurve's way of saying "no". Split into two groups because the syntax
# errors always start a line, while the semantic ones are sentences that begin
# with the offending object ("VLAN 1 cannot be deleted.").
ERROR_PREFIXES = (
    "invalid input",
    "incomplete input",
    "ambiguous input",
    "unknown command",
    "unable to",
    "cannot ",
    "error:",
    "% ",
)
ERROR_PHRASES = (
    "cannot be deleted",
    "cannot be removed",
    "cannot be configured",
    "can not be",
    "is not allowed",
    "not supported on this",
    "already untagged in vlan",
    "is not a member of vlan",
    "must be removed from",
)


class TransportError(RuntimeError):
    """Anything that goes wrong while talking to the switch."""


class AuthError(TransportError):
    """Credentials were rejected."""


#: Without these, a ProVision switch simply cannot be reached over SSH.
REQUIRED_LEGACY = {
    "kex": "diffie-hellman-group14-sha1",
    "host key": "ssh-rsa",
    "cipher": "aes128-cbc",
    "mac": "hmac-sha1",
}


def missing_legacy_support() -> list[str]:
    """Legacy primitives this paramiko build no longer provides.

    Paramiko 4 dropped SHA-1 kex and ssh-rsa; installing it turns every
    connection attempt into an opaque "no matching key exchange" error, so we
    check up front and say what actually happened.
    """
    tables = {
        "kex": paramiko.Transport._kex_info,
        "host key": paramiko.Transport._key_info,
        "cipher": paramiko.Transport._cipher_info,
        "mac": paramiko.Transport._mac_info,
    }
    return [
        f"{kind}: {name}"
        for kind, name in REQUIRED_LEGACY.items()
        if name not in tables[kind]
    ]


def assert_legacy_support() -> None:
    missing = missing_legacy_support()
    if missing:
        raise TransportError(
            "The installed paramiko ("
            f"{paramiko.__version__}) no longer supports: {', '.join(missing)}. "
            "HP ProVision switches offer nothing else, so no SSH connection is "
            "possible. Install paramiko 3.x:  pip install 'paramiko>=3.4,<4'"
        )


# --------------------------------------------------------------------------
# byte channels
# --------------------------------------------------------------------------


class ByteChannel(Protocol):
    """The minimal duplex byte pipe :class:`ProCurveShell` needs."""

    def send_bytes(self, data: bytes) -> None: ...
    def recv_bytes(self, size: int, timeout: float) -> bytes: ...
    def close(self) -> None: ...


@dataclass
class HostKeyInfo:
    key_type: str
    fingerprint_sha256: str
    fingerprint_md5: str


class SSHChannel:
    """A paramiko interactive shell, coaxed into speaking 2008-era SSH."""

    #: Offered first, so the switch's short list is matched before anything else.
    LEGACY_KEX = (
        "diffie-hellman-group14-sha1",
        "diffie-hellman-group-exchange-sha1",
        "diffie-hellman-group1-sha1",
    )
    LEGACY_CIPHERS = ("aes128-cbc", "aes256-cbc", "aes192-cbc", "3des-cbc")
    LEGACY_MACS = ("hmac-sha1", "hmac-md5", "hmac-sha1-96", "hmac-md5-96")
    LEGACY_KEYS = ("ssh-rsa", "ssh-dss")

    def __init__(
        self,
        host: str,
        port: int = 22,
        username: str = "manager",
        password: str = "",
        timeout: float = 15.0,
        legacy: bool = True,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.timeout = timeout
        self.legacy = legacy
        self._transport: paramiko.Transport | None = None
        self._chan: paramiko.Channel | None = None
        self.host_key: HostKeyInfo | None = None

    # -- algorithm juggling -------------------------------------------------

    @staticmethod
    def _reorder(preferred: Sequence[str], supported: Sequence[str]) -> tuple[str, ...]:
        """Put *preferred* first, keeping anything else paramiko still knows.

        Filtering against *supported* means we silently skip primitives a future
        paramiko has dropped instead of blowing up at handshake time.
        """
        known = [a for a in preferred if a in supported]
        rest = [a for a in supported if a not in known]
        return tuple(known + rest)

    def _apply_legacy_algorithms(self, transport: paramiko.Transport) -> None:
        """Offer the switch's ancient primitives first, modern ones after.

        Ordering alone is enough: negotiation picks the first client preference
        the server also supports, so a 2910al lands on ssh-rsa/group14-sha1
        while a modern Aruba still gets current crypto from the tail of the
        list.  Nothing is disabled.
        """
        transport._preferred_kex = self._reorder(self.LEGACY_KEX, list(transport._kex_info))
        transport._preferred_ciphers = self._reorder(
            self.LEGACY_CIPHERS, list(transport._cipher_info)
        )
        transport._preferred_macs = self._reorder(self.LEGACY_MACS, list(transport._mac_info))
        transport._preferred_keys = self._reorder(self.LEGACY_KEYS, list(transport._key_info))

    # -- lifecycle ----------------------------------------------------------

    def connect(self) -> None:
        if self.legacy:
            assert_legacy_support()
        sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        sock.settimeout(self.timeout)
        transport = paramiko.Transport(sock)
        transport.set_keepalive(30)
        if self.legacy:
            self._apply_legacy_algorithms(transport)
        try:
            transport.start_client(timeout=self.timeout)
        except paramiko.SSHException as exc:
            transport.close()
            raise TransportError(
                f"SSH handshake failed: {exc}. "
                "If this mentions kex or cipher, the switch is even older than "
                "expected -- try the telnet transport."
            ) from exc

        key = transport.get_remote_server_key()
        self.host_key = HostKeyInfo(
            key_type=key.get_name(),
            fingerprint_sha256=_sha256_fp(key),
            fingerprint_md5=_md5_fp(key),
        )

        self._authenticate(transport)

        chan = transport.open_session(timeout=self.timeout)
        # A wide, tall pty stops the switch from wrapping running-config lines.
        chan.get_pty(term="vt100", width=200, height=1000)
        chan.invoke_shell()
        chan.settimeout(0.1)
        self._transport = transport
        self._chan = chan

    def _authenticate(self, transport: paramiko.Transport) -> None:
        """Try the three auth flavours a ProCurve might be configured for."""
        errors: list[str] = []
        for attempt in ("password", "keyboard-interactive", "none"):
            try:
                if attempt == "password":
                    transport.auth_password(self.username, self.password, fallback=False)
                elif attempt == "keyboard-interactive":
                    transport.auth_interactive_dumb(self.username, _dumb_handler(self.password))
                else:
                    transport.auth_none(self.username)
            except paramiko.SSHException as exc:
                errors.append(f"{attempt}: {exc}")
                if not transport.is_active():
                    break
                continue
            if transport.is_authenticated():
                return
        transport.close()
        raise AuthError("Authentication rejected. Tried " + "; ".join(errors))

    # -- ByteChannel --------------------------------------------------------

    def send_bytes(self, data: bytes) -> None:
        if self._chan is None:
            raise TransportError("not connected")
        self._chan.sendall(data)

    def recv_bytes(self, size: int, timeout: float) -> bytes:
        if self._chan is None:
            raise TransportError("not connected")
        self._chan.settimeout(timeout)
        try:
            return self._chan.recv(size)
        except socket.timeout:
            return b""

    def close(self) -> None:
        for obj in (self._chan, self._transport):
            try:
                if obj is not None:
                    obj.close()
            except Exception:  # noqa: BLE001 - teardown must never raise
                pass
        self._chan = None
        self._transport = None


def _dumb_handler(password: str) -> Callable[[str, str, list], list[str]]:
    def handler(title, instructions, prompt_list):  # noqa: ANN001 - paramiko API
        return [password for _ in prompt_list]

    return handler


def _sha256_fp(key: paramiko.PKey) -> str:
    import base64
    import hashlib

    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


def _md5_fp(key: paramiko.PKey) -> str:
    import hashlib

    digest = hashlib.md5(key.asbytes()).hexdigest()  # noqa: S324 - display only
    return ":".join(digest[i : i + 2] for i in range(0, len(digest), 2))


# --------------------------------------------------------------------------
# telnet
# --------------------------------------------------------------------------

IAC, DONT, DO, WONT, WILL, SB, SE = 255, 254, 253, 252, 251, 250, 240
OPT_ECHO, OPT_SGA = 1, 3


class TelnetChannel:
    """Minimal RFC 854 client -- stdlib ``telnetlib`` is gone since Python 3.13.

    We accept ECHO and SUPPRESS-GO-AHEAD (which is what puts a ProCurve into
    character mode) and refuse every other option outright.  That is enough for
    every ProVision box; nothing here tries to be a general purpose telnet.
    """

    def __init__(self, host: str, port: int = 23, timeout: float = 15.0) -> None:
        self.host = host
        self.port = port
        self.timeout = timeout
        self._sock: socket.socket | None = None
        self._buf = bytearray()
        self.host_key = None

    def connect(self) -> None:
        self._sock = socket.create_connection((self.host, self.port), timeout=self.timeout)

    def send_bytes(self, data: bytes) -> None:
        if self._sock is None:
            raise TransportError("not connected")
        self._sock.sendall(data.replace(bytes([IAC]), bytes([IAC, IAC])))

    def recv_bytes(self, size: int, timeout: float) -> bytes:
        if self._sock is None:
            raise TransportError("not connected")
        self._sock.settimeout(timeout)
        try:
            raw = self._sock.recv(size)
        except socket.timeout:
            return b""
        if not raw:
            raise TransportError("telnet connection closed by switch")
        return self._negotiate(raw)

    def _negotiate(self, raw: bytes) -> bytes:
        """Strip IAC sequences from *raw*, answering each negotiation."""
        out = bytearray()
        replies = bytearray()
        data = self._buf + raw
        self._buf = bytearray()
        i = 0
        while i < len(data):
            byte = data[i]
            if byte != IAC:
                out.append(byte)
                i += 1
                continue
            # Need at least the command byte.
            if i + 1 >= len(data):
                self._buf = bytearray(data[i:])
                break
            cmd = data[i + 1]
            if cmd == IAC:  # escaped 0xFF
                out.append(IAC)
                i += 2
            elif cmd in (DO, DONT, WILL, WONT):
                if i + 2 >= len(data):
                    self._buf = bytearray(data[i:])
                    break
                opt = data[i + 2]
                replies += self._answer(cmd, opt)
                i += 3
            elif cmd == SB:
                end = data.find(bytes([IAC, SE]), i)
                if end == -1:
                    self._buf = bytearray(data[i:])
                    break
                i = end + 2
            else:
                i += 2
        if replies and self._sock is not None:
            self._sock.sendall(bytes(replies))
        return bytes(out)

    @staticmethod
    def _answer(cmd: int, opt: int) -> bytes:
        if cmd == DO:
            return bytes([IAC, WILL if opt == OPT_SGA else WONT, opt])
        if cmd == WILL:
            return bytes([IAC, DO if opt in (OPT_ECHO, OPT_SGA) else DONT, opt])
        if cmd == DONT:
            return bytes([IAC, WONT, opt])
        return bytes([IAC, DONT, opt])

    def close(self) -> None:
        try:
            if self._sock is not None:
                self._sock.close()
        except Exception:  # noqa: BLE001
            pass
        self._sock = None


# --------------------------------------------------------------------------
# the shell on top
# --------------------------------------------------------------------------


@dataclass
class CommandResult:
    command: str
    output: str
    error: str | None = None
    #: Everything that came back, echo and trailing prompt included. Kept so a
    #: command whose output ends up empty can still be inspected in the UI --
    #: "(empty)" on its own is impossible to debug.
    transcript: str = ""

    @property
    def ok(self) -> bool:
        return self.error is None


@dataclass
class ShellState:
    hostname: str = ""
    level: str = ">"          # '>' operator, '#' manager
    context: str = ""          # '(config)', '(vlan-10)', ...
    prompt: str = ""


class ProCurveShell:
    """Prompt-aware command runner shared by the SSH and telnet channels.

    All access is serialised through :attr:`lock`; the switch has exactly one
    CLI session and interleaving two commands would corrupt both.
    """

    def __init__(self, channel: ByteChannel, enable_password: str = "") -> None:
        self.chan = channel
        self.enable_password = enable_password
        self.state = ShellState()
        self.lock = threading.RLock()
        self._tap: Callable[[str], None] | None = None
        self.last_raw = ""

    # -- low level ----------------------------------------------------------

    def set_tap(self, tap: Callable[[str], None] | None) -> None:
        """Mirror every byte read from the switch to *tap* (live CLI view)."""
        self._tap = tap

    def _read_until(
        self,
        timeout: float,
        stop: Sequence[re.Pattern[str]] = (),
        idle_stop: float | None = None,
    ) -> tuple[str, str]:
        """Read until the prompt (or a *stop* pattern) shows up.

        Returns ``(cleaned_text, reason)`` where reason is ``prompt``, ``match``,
        ``idle`` or ``timeout``.
        """
        buf = ""
        deadline = time.monotonic() + timeout
        last_data = time.monotonic()
        while time.monotonic() < deadline:
            chunk = self.chan.recv_bytes(65536, 0.15)
            if chunk:
                text = chunk.decode("utf-8", "replace")
                buf += text
                last_data = time.monotonic()
                if self._tap:
                    self._tap(strip_ansi(text))
            cleaned = clean(buf)
            self.last_raw = cleaned
            tail = cleaned[-400:]
            # Only trust a prompt once at least one newline has arrived. The
            # switch echoes the command we just sent, and a half-received echo
            # ("SW#" before " show version" lands) is otherwise indistinguishable
            # from the trailing prompt -- which would return empty output.
            if "\n" in cleaned and PROMPT_RE.search(cleaned):
                return cleaned, "prompt"
            for pat in stop:
                if pat.search(tail):
                    return cleaned, "match"
            if MORE_RE.search(tail):
                # `no page` did not take -- keep pressing space. The switch
                # erases the prompt with CR+spaces, which clean() folds away, so
                # this cannot loop on a stale match.
                self.chan.send_bytes(b" ")
                continue
            if ANYKEY_RE.search(tail):
                self.chan.send_bytes(b" ")
                continue
            if not chunk:
                if idle_stop is not None and time.monotonic() - last_data > idle_stop and buf:
                    return cleaned, "idle"
        return clean(buf), "timeout"

    def _update_state(self, cleaned: str) -> None:
        m = PROMPT_RE.search(cleaned)
        if not m:
            return
        self.state.hostname = m.group("host")
        self.state.context = m.group("ctx") or ""
        self.state.level = m.group("level")
        self.state.prompt = m.group(0).strip()

    # -- login --------------------------------------------------------------

    def login(self, username: str = "", password: str = "", timeout: float = 25.0) -> None:
        """Walk through banner / credential prompts until we own a CLI prompt."""
        deadline = time.monotonic() + timeout
        sent_user = sent_pass = False
        self.chan.send_bytes(b"\n")
        while time.monotonic() < deadline:
            text, reason = self._read_until(
                4.0, stop=(USER_PROMPT_RE, PASS_PROMPT_RE), idle_stop=1.2
            )
            if reason == "prompt":
                self._update_state(text)
                self._post_login()
                return
            if USER_PROMPT_RE.search(text[-200:]) and not sent_user:
                self.chan.send_bytes(username.encode() + b"\n")
                sent_user = True
                continue
            if PASS_PROMPT_RE.search(text[-200:]) and not sent_pass:
                self.chan.send_bytes(password.encode() + b"\n")
                sent_pass = True
                continue
            # Menu interface instead of CLI?
            if "Main Menu" in text or "=====" in text and "Menu" in text:
                raise TransportError(
                    "The switch dropped us into the menu interface. Run "
                    "'console local-terminal none' / set the console to CLI, or "
                    "pick Command Line (CLI) from the menu once."
                )
            self.chan.send_bytes(b"\n")
        raise TransportError(
            "No CLI prompt within %.0fs. Last output:\n%s" % (timeout, self.last_raw[-500:])
        )

    def _post_login(self) -> None:
        """Disable paging and climb to manager level if we landed as operator."""
        self.run("no page", timeout=8)
        if self.state.level == ">":
            self.enable()

    def enable(self) -> None:
        """Go from operator (``>``) to manager (``#``)."""
        with self.lock:
            self.chan.send_bytes(b"enable\n")
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                text, reason = self._read_until(
                    4.0, stop=(USER_PROMPT_RE, PASS_PROMPT_RE), idle_stop=1.0
                )
                if reason == "prompt":
                    self._update_state(text)
                    if self.state.level == "#":
                        self.run("no page", timeout=8)
                        return
                    raise TransportError("'enable' did not grant manager level.")
                if USER_PROMPT_RE.search(text[-200:]):
                    self.chan.send_bytes(b"manager\n")
                elif PASS_PROMPT_RE.search(text[-200:]):
                    self.chan.send_bytes(self.enable_password.encode() + b"\n")
                else:
                    self.chan.send_bytes(b"\n")
            raise TransportError("Timed out escalating to manager level.")

    # -- commands -----------------------------------------------------------

    def run(self, command: str, timeout: float = 30.0, confirm: str | None = "y") -> CommandResult:
        """Send *command* and return everything up to the next prompt.

        *confirm* is the answer fed to ``[y/n]`` questions; pass ``None`` to
        leave them unanswered (the caller then sees the question in the output).
        """
        with self.lock:
            self.chan.send_bytes(command.encode() + b"\n")
            collected = ""
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                text, reason = self._read_until(min(timeout, 20.0), stop=(CONFIRM_RE,))
                collected = text
                if reason == "prompt":
                    break
                if reason == "match" and confirm is not None:
                    self.chan.send_bytes(confirm.encode() + b"\n")
                    continue
                break
            self.last_raw = collected
            self._update_state(collected)
            body = self._strip_echo_and_prompt(collected, command)
            return CommandResult(
                command=command,
                output=body,
                error=detect_error(body) or detect_error(collected),
                transcript=collected,
            )

    @staticmethod
    def _strip_echo_and_prompt(text: str, command: str) -> str:
        lines = text.split("\n")
        cmd = command.strip()
        # Drop the echoed command, cutting only the command text itself rather
        # than the whole line.  The "Status and Counters" screens position the
        # cursor instead of sending newlines, so once the escape sequences are
        # gone the echo and the first line of real output can share a line --
        # dropping that line would swallow the entire reply.
        for idx, line in enumerate(lines[:3]):
            pos = line.find(cmd) if cmd else -1
            if pos == -1:
                continue
            rest = line[pos + len(cmd) :].strip()
            lines = ([rest] if rest else []) + lines[idx + 1 :]
            break
        # Drop the trailing prompt.
        while lines and (not lines[-1].strip() or PROMPT_RE.search(lines[-1])):
            if PROMPT_RE.search(lines[-1]):
                lines.pop()
                break
            lines.pop()
        return "\n".join(lines).strip("\n")

    def run_config(self, lines: Sequence[str], timeout: float = 30.0) -> list[CommandResult]:
        """Enter config mode, push *lines*, come back out.

        Each line's result is returned individually so the UI can point at the
        exact command the switch rejected.
        """
        results: list[CommandResult] = []
        with self.lock:
            if "config" not in self.state.context:
                results.append(self.run("configure terminal", timeout=timeout))
            for line in lines:
                if not line.strip() or line.strip().startswith("!"):
                    continue
                results.append(self.run(line, timeout=timeout))
            results.append(self.run("exit", timeout=timeout))
        return results

    def close(self) -> None:
        try:
            with self.lock:
                self.chan.send_bytes(b"\nlogout\ny\n")
                time.sleep(0.2)
        except Exception:  # noqa: BLE001
            pass
        self.chan.close()


def detect_error(output: str) -> str | None:
    """Return the switch's complaint, if the output contains one.

    Matching is anchored to the start of a line on purpose: ProCurve always
    begins its error messages there, while words like "failed" appear mid-line
    all over normal output (the event log especially). Substring matching would
    flag a healthy ``show logging`` as an error.
    """
    for line in output.split("\n"):
        low = line.strip().lower()
        if not low:
            continue
        if low.startswith(ERROR_PREFIXES):
            return line.strip()
        if any(phrase in low for phrase in ERROR_PHRASES):
            return line.strip()
    return None
