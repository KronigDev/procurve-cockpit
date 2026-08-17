"""High level view of a ProCurve switch, built on top of :mod:`transport`.

Everything the UI reads goes through :class:`ProCurveDevice`, which keeps the
raw CLI output alongside the parsed structure.  When a parser misbehaves on a
firmware we have not seen, the panel can still show the raw text -- that is the
escape hatch that makes blind-built parsers safe.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any, Sequence

from .parsers import (
    diff_config,
    parse_arp,
    parse_cdp_neighbors,
    parse_config_text,
    parse_flash,
    parse_lldp_detail,
    parse_ip_config,
    parse_lacp,
    parse_lldp_config,
    parse_lldp_neighbors,
    parse_mac_table,
    parse_modules,
    parse_poe,
    parse_port_config,
    parse_port_names,
    parse_ports,
    parse_routes,
    parse_snmp_server,
    parse_stp,
    parse_stp_port_config,
    parse_system_info,
    parse_trunks,
    parse_vlan_ports,
    parse_vlans,
)
from .transport import CommandResult, ProCurveShell, SSHChannel, TelnetChannel, TransportError

log = logging.getLogger(__name__)


@dataclass
class Fetch:
    """One ``show`` command: what we asked, what came back, what we made of it."""

    command: str
    raw: str
    data: Any = None
    error: str | None = None
    #: Untrimmed reply, echo and prompt included. Only surfaced when `raw` came
    #: out empty, so a panel that shows nothing can still be diagnosed.
    transcript: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "command": self.command,
            "raw": self.raw,
            "data": self.data,
            "error": self.error,
            "transcript": "" if self.raw.strip() else self.transcript,
        }


@dataclass
class Capabilities:
    """What this particular unit actually supports, probed once after login."""

    poe: bool = False
    routing: bool = False
    lldp: bool = True
    stacking: bool = False
    modules: list[dict[str, str]] = field(default_factory=list)
    port_count: int = 0
    model: str = ""


class ProCurveDevice:
    """A connected switch."""

    def __init__(self, shell: ProCurveShell, host: str) -> None:
        self.shell = shell
        self.host = host
        self.caps = Capabilities()
        self.connected_at = time.time()
        self._cache: dict[str, tuple[float, Fetch]] = {}

    # -- construction -------------------------------------------------------

    @classmethod
    def connect(
        cls,
        host: str,
        username: str,
        password: str,
        *,
        transport: str = "ssh",
        port: int | None = None,
        enable_password: str = "",
        legacy: bool = True,
        timeout: float = 20.0,
    ) -> "ProCurveDevice":
        if transport == "telnet":
            channel = TelnetChannel(host, port or 23, timeout=timeout)
            channel.connect()
        else:
            channel = SSHChannel(
                host,
                port or 22,
                username=username or "manager",
                password=password,
                timeout=timeout,
                legacy=legacy,
            )
            channel.connect()

        shell = ProCurveShell(channel, enable_password=enable_password or password)
        # Telnet still needs the credentials typed at the CLI; SSH already
        # authenticated, but the switch may re-prompt anyway.
        shell.login(username=username, password=password, timeout=timeout + 10)

        device = cls(shell, host)
        device.probe()
        return device

    @property
    def host_key(self) -> dict[str, str] | None:
        key = getattr(self.shell.chan, "host_key", None)
        if key is None:
            return None
        return {
            "type": key.key_type,
            "sha256": key.fingerprint_sha256,
            "md5": key.fingerprint_md5,
        }

    # -- plumbing -----------------------------------------------------------

    def show(self, command: str, *, cache: float = 0.0, timeout: float = 40.0) -> Fetch:
        """Run a ``show`` command, optionally reusing a result up to *cache* seconds old."""
        if cache > 0:
            hit = self._cache.get(command)
            if hit and time.time() - hit[0] < cache:
                return hit[1]
        result = self.shell.run(command, timeout=timeout)
        fetch = Fetch(
            command=command,
            raw=result.output,
            error=result.error,
            transcript=result.transcript,
        )
        self._cache[command] = (time.time(), fetch)
        return fetch

    def _first_answer(self, commands: Sequence[str], parser, *, cache: float = 0.0) -> Fetch:
        """Try each command in turn until one actually answers.

        Command names drift across firmware trains -- ``show system-information``
        is ``show system`` on some builds -- and a wrong guess costs one round
        trip, while a wrong assumption costs a blank panel.
        """
        first: Fetch | None = None
        for command in commands:
            fetch = self._parsed(command, parser, cache=cache)
            if first is None:
                first = fetch
            if fetch.raw.strip() and not fetch.error:
                return fetch
        return first  # type: ignore[return-value]

    def _parsed(self, command: str, parser, *, cache: float = 0.0, timeout: float = 40.0) -> Fetch:
        fetch = self.show(command, cache=cache, timeout=timeout)
        if fetch.error:
            fetch.data = None
            return fetch
        try:
            fetch.data = parser(fetch.raw)
        except Exception as exc:  # noqa: BLE001 - a bad parse must not kill the panel
            log.exception("parser failed for %s", command)
            fetch.error = f"Parser failed ({exc}). Raw output is still available."
        return fetch

    #: Spellings of the general status page. K/W.15 answers the first; other
    #: trains only accept the shorter forms.
    SYSTEM_INFO_COMMANDS = (
        "show system-information",
        "show system information",
        "show system",
    )

    def _system_info(self, *, cache: float) -> Fetch:
        return self._first_answer(self.SYSTEM_INFO_COMMANDS, parse_system_info, cache=cache)

    def probe(self) -> Capabilities:
        """Work out what this unit can do, so the UI hides what it cannot."""
        sysinfo = self._system_info(cache=30)
        ports = self._parsed("show interfaces brief", parse_ports, cache=30)
        caps = Capabilities()
        caps.port_count = len(ports.data or [])
        caps.model = _guess_model(self.show("show version", cache=300).raw, sysinfo.raw)

        poe = self.show("show power-over-ethernet brief", timeout=20)
        caps.poe = not poe.error and "Port" in poe.raw

        routing = self.show("show ip route", timeout=20)
        caps.routing = not routing.error

        lldp = self.show("show lldp info remote-device", timeout=20)
        caps.lldp = not lldp.error

        modules = self._parsed("show modules", parse_modules, cache=300)
        caps.modules = modules.data or []
        caps.stacking = "stack" in self.show("show stacking", timeout=15).raw.lower()

        self.caps = caps
        return caps

    # -- read side ----------------------------------------------------------

    def system(self) -> dict[str, Any]:
        info = self._system_info(cache=5)
        version = self.show("show version", cache=300)
        flash = self._parsed("show flash", parse_flash, cache=60)
        uptime_seconds = _uptime_seconds(version.raw + "\n" + info.raw)
        return {
            "info": info.as_dict(),
            "version": version.as_dict(),
            "flash": flash.as_dict(),
            "uptime_seconds": uptime_seconds,
            "capabilities": self.caps.__dict__,
            "prompt": self.shell.state.prompt,
            "host": self.host,
        }

    #: Configured port settings, LLDP mode and per-port STP only move when
    #: somebody changes them, so they are cached far longer than link state --
    #: they cost three extra round trips per uncached port view.
    PORT_CONFIG_CACHE = 30.0

    def ports(self) -> dict[str, Any]:
        brief = self._parsed("show interfaces brief", parse_ports, cache=3)
        names = self._parsed("show name", parse_port_names, cache=10)
        config = self._parsed(
            "show interfaces config", parse_port_config, cache=self.PORT_CONFIG_CACHE
        )
        config_map = config.data or {}
        stp_cfg = self._parsed(
            "show spanning-tree config", parse_stp_port_config, cache=self.PORT_CONFIG_CACHE
        )
        stp_map = stp_cfg.data or {}
        lldp_cfg = self._parsed(
            "show lldp config", parse_lldp_config, cache=self.PORT_CONFIG_CACHE
        )
        lldp_admin_map = lldp_cfg.data or {}
        vlan_map = self.port_vlan_map()
        trunks = self._parsed("show trunks", parse_trunks, cache=10)
        trunk_map = {t["port"]: t for t in (trunks.data or [])}
        lldp = self._parsed("show lldp info remote-device", parse_lldp_neighbors, cache=10)
        lldp_map = {n["port"]: n for n in (lldp.data or [])}
        poe_map: dict[str, Any] = {}
        if self.caps.poe:
            poe = self._parsed("show power-over-ethernet brief", parse_poe, cache=5)
            poe_map = {p["port"]: p for p in (poe.data or [])}

        merged = []
        for port in brief.data or []:
            pid = port["port"]
            merged.append(
                {
                    **port,
                    "name": (names.data or {}).get(pid, ""),
                    "untagged": vlan_map.get(pid, {}).get("untagged"),
                    "tagged": vlan_map.get(pid, {}).get("tagged", []),
                    "trunk": trunk_map.get(pid),
                    "lldp": lldp_map.get(pid),
                    "poe": poe_map.get(pid),
                    # What is *configured* -- the inspector preselects from this,
                    # while the fields above describe what the link negotiated.
                    "config": config_map.get(pid, {}),
                    "lldp_admin": lldp_admin_map.get(pid, ""),
                    "stp": stp_map.get(pid, {}),
                }
            )
        return {
            "ports": merged,
            "sources": {
                "brief": brief.as_dict(),
                "config": config.as_dict(),
                "names": names.as_dict(),
                "trunks": trunks.as_dict(),
                "lldp": lldp.as_dict(),
                "lldp_config": lldp_cfg.as_dict(),
                "stp_config": stp_cfg.as_dict(),
            },
        }

    #: VLAN membership needs one `show vlan <id>` per VLAN, so a 12-VLAN switch
    #: costs 13 round trips. It only changes when we change it -- and `apply()`
    #: clears the cache -- so it is held far longer than live port state.
    VLAN_CACHE = 25.0

    def vlans(self) -> dict[str, Any]:
        vlans = self._parsed("show vlans", parse_vlans, cache=self.VLAN_CACHE)
        detail = []
        for vlan in vlans.data or []:
            ports = self._parsed(
                f"show vlan {vlan['id']}", parse_vlan_ports, cache=self.VLAN_CACHE
            )
            detail.append({**vlan, "ports": ports.data or [], "raw": ports.raw})
        return {"vlans": detail, "source": vlans.as_dict()}

    def port_vlan_map(self) -> dict[str, dict[str, Any]]:
        """``{port: {untagged: vid, tagged: [vid, ...]}}`` built from the VLAN table."""
        vlans = self._parsed("show vlans", parse_vlans, cache=self.VLAN_CACHE)
        mapping: dict[str, dict[str, Any]] = {}
        for vlan in vlans.data or []:
            ports = self._parsed(
                f"show vlan {vlan['id']}", parse_vlan_ports, cache=self.VLAN_CACHE
            )
            for entry in ports.data or []:
                slot = mapping.setdefault(entry["port"], {"untagged": None, "tagged": []})
                if entry["mode"].startswith("untag"):
                    slot["untagged"] = vlan["id"]
                elif entry["mode"].startswith("tag"):
                    slot["tagged"].append(vlan["id"])
        return mapping

    def trunks(self) -> dict[str, Any]:
        return {
            "trunks": self._parsed("show trunks", parse_trunks, cache=5).as_dict(),
            "lacp": self._parsed("show lacp", parse_lacp, cache=5).as_dict(),
        }

    def spanning_tree(self) -> dict[str, Any]:
        return {
            "stp": self._parsed("show spanning-tree", parse_stp, cache=5).as_dict(),
            "config": self.show("show spanning-tree config", cache=15).as_dict(),
            "mst": self.show("show spanning-tree mst-config", cache=30).as_dict(),
        }

    def neighbors(self) -> dict[str, Any]:
        lldp = self._parsed("show lldp info remote-device", parse_lldp_neighbors, cache=5)
        # ProVision has no `detail` keyword here -- the long form is reached by
        # naming a port. Only ports that actually reported a neighbour are
        # queried, so this is a handful of round trips, not one per port.
        details = []
        for entry in (lldp.data or [])[:24]:
            port = entry["port"]
            fetch = self._parsed(
                f"show lldp info remote-device {port}", parse_lldp_detail, cache=30
            )
            details.append({"port": port, **fetch.as_dict()})
        return {
            "lldp": lldp.as_dict(),
            "lldp_details": details,
            "cdp": self._parsed("show cdp neighbors", parse_cdp_neighbors, cache=30).as_dict(),
        }

    def forwarding(self) -> dict[str, Any]:
        return {
            "mac": self._parsed("show mac-address", parse_mac_table, cache=5).as_dict(),
            "arp": self._parsed("show arp", parse_arp, cache=5).as_dict(),
        }

    def routing(self) -> dict[str, Any]:
        return {
            "ip": self._parsed("show ip", parse_ip_config, cache=5).as_dict(),
            "routes": self._parsed("show ip route", parse_routes, cache=5).as_dict(),
            "rip": self.show("show ip rip", cache=30).as_dict(),
            "helper": self.show("show ip helper-address", cache=30).as_dict(),
        }

    def poe(self) -> dict[str, Any]:
        return {
            "brief": self._parsed(
                "show power-over-ethernet brief", parse_poe, cache=3
            ).as_dict(),
            "summary": self.show("show power-over-ethernet", cache=5).as_dict(),
        }

    def security(self) -> dict[str, Any]:
        return {
            "port_security": self.show("show port-security", cache=15).as_dict(),
            "authentication": self.show("show authentication", cache=30).as_dict(),
            "radius": self.show("show radius", cache=30).as_dict(),
            "tacacs": self.show("show tacacs", cache=30).as_dict(),
            "dhcp_snooping": self.show("show dhcp-snooping", cache=15).as_dict(),
            "arp_protect": self.show("show arp-protect", cache=30).as_dict(),
            "8021x": self.show("show port-access authenticator", cache=30).as_dict(),
            "snmp": self._parsed("show snmp-server", parse_snmp_server, cache=30).as_dict(),
            "ssh": self.show("show ip ssh", cache=30).as_dict(),
            "telnet": self.show("show telnet", cache=30).as_dict(),
            "web": self.show("show web-management", cache=30).as_dict(),
        }

    def qos(self) -> dict[str, Any]:
        return {
            "queue": self.show("show qos queue-config", cache=30).as_dict(),
            "port_priority": self.show("show qos port-priority", cache=30).as_dict(),
            "dscp": self.show("show qos dscp-map", cache=30).as_dict(),
            "device_priority": self.show("show qos device-priority", cache=30).as_dict(),
            "rate_limit": self.show("show rate-limit all", cache=30).as_dict(),
        }

    def acls(self) -> dict[str, Any]:
        return {
            "list": self.show("show access-list", cache=15).as_dict(),
            "config": self.show("show access-list config", cache=15).as_dict(),
            "ports": self.show("show access-list ports all", cache=15).as_dict(),
        }

    def logging(self) -> dict[str, Any]:
        return {
            "log": self.show("show logging -r", cache=5, timeout=60).as_dict(),
            "debug": self.show("show debug", cache=30).as_dict(),
            "time": self.show("show time", cache=5).as_dict(),
            "sntp": self.show("show sntp", cache=30).as_dict(),
        }

    def config(self) -> dict[str, Any]:
        running = self.show("show running-config", cache=5, timeout=90)
        startup = self.show("show config", cache=15, timeout=90)
        running_lines = parse_config_text(running.raw)
        startup_lines = parse_config_text(startup.raw)
        return {
            "running": running_lines,
            "startup": startup_lines,
            "diff": diff_config(running_lines, startup_lines),
            "unsaved": running_lines != startup_lines,
            "raw_running": running.raw,
        }

    # -- write side ---------------------------------------------------------

    def apply(self, commands: list[str], *, save: bool = False) -> dict[str, Any]:
        """Push *commands* through config mode, then optionally ``write memory``."""
        results = self.shell.run_config(commands)
        payload = [
            {"command": r.command, "output": r.output, "error": r.error, "ok": r.ok}
            for r in results
        ]
        saved = None
        if save and all(r.ok for r in results):
            saved = self._as_dict(self.shell.run("write memory", timeout=60))
        self._cache.clear()
        return {
            "results": payload,
            "ok": all(r.ok for r in results),
            "saved": saved,
        }

    def run_raw(self, command: str, timeout: float = 60.0) -> dict[str, Any]:
        """Run a single command exactly as typed (used by the CLI console)."""
        result = self.shell.run(command, timeout=timeout)
        self._cache.clear()
        return self._as_dict(result)

    def write_memory(self) -> dict[str, Any]:
        return self._as_dict(self.shell.run("write memory", timeout=60))

    @staticmethod
    def _as_dict(result: CommandResult) -> dict[str, Any]:
        return {
            "command": result.command,
            "output": result.output,
            "error": result.error,
            "ok": result.ok,
        }

    def close(self) -> None:
        try:
            self.shell.close()
        except TransportError:
            # Closing an already dead session is the normal case, not an error:
            # the switch drops the connection on `reload` and on its own idle
            # timeout, so we get here with a socket that is long gone.
            log.debug("session was already closed", exc_info=True)


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

_MODEL_RE = re.compile(r"\b(J\d{4}[A-Z])\b")
_UPTIME_RE = re.compile(
    r"(?:(\d+)\s*d(?:ays?)?)?[,\s]*(?:(\d+)\s*h(?:ours?)?)?[,\s]*"
    r"(?:(\d+)\s*m(?:in(?:utes?)?)?)?[,\s]*(?:(\d+)\s*s(?:ec(?:onds?)?)?)?",
    re.I,
)


def _guess_model(*texts: str) -> str:
    for text in texts:
        m = _MODEL_RE.search(text or "")
        if m:
            return m.group(1)
    for text in texts:
        m = re.search(r"\b(\d{4}al[\w\-]*)", text or "", re.I)
        if m:
            return m.group(1)
    return ""


def _uptime_seconds(text: str) -> int | None:
    m = re.search(r"Up Time\s*:\s*([^\n]+)", text, re.I)
    if not m:
        return None
    value = m.group(1).strip()
    parts = _UPTIME_RE.match(value)
    if not parts or not any(parts.groups()):
        return None
    days, hours, minutes, seconds = (int(g) if g else 0 for g in parts.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds
