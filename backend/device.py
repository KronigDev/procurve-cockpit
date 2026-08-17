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
    parse_cpu,
    parse_event_log,
    parse_flash,
    parse_lldp_detail,
    parse_ip_config,
    parse_lacp,
    parse_lldp_config,
    parse_lldp_neighbors,
    parse_mac_table,
    parse_memory,
    parse_modules,
    parse_poe,
    parse_port_config,
    parse_port_names,
    parse_ports,
    parse_routes,
    parse_snmp_server,
    parse_stp,
    parse_stp_port_config,
    parse_structured,
    parse_system_info,
    parse_uptime,
    parse_trunks,
    parse_version,
    parse_vlan_ports,
    parse_vlans,
)
from .transport import (
    NO_SAVE_MAP,
    SAVE_CONFIRM_RE,
    CommandResult,
    ProCurveShell,
    SSHChannel,
    TelnetChannel,
    TransportError,
)

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
        attempts: list[Fetch] = []
        for command in commands:
            fetch = self._parsed(command, parser, cache=cache)
            attempts.append(fetch)
            if fetch.raw.strip() and not fetch.error:
                return fetch
        first = attempts[0]
        # Nothing answered. Report what EVERY spelling said -- showing only
        # the first rejection hides which variant this train actually wants.
        if len(attempts) > 1:
            first.error = " · ".join(
                f"{f.command}: {f.error or '(no output)'}" for f in attempts
            )
        return first

    def _parsed(self, command: str, parser, *, cache: float = 0.0, timeout: float = 40.0) -> Fetch:
        shared = self.show(command, cache=cache, timeout=timeout)
        # Work on a private copy: the cached Fetch is shared between callers,
        # and two sections parse the same command with different parsers
        # ("show spanning-tree config" feeds both the port table and the
        # structured card) -- mutating the shared object races between them.
        fetch = Fetch(
            command=shared.command,
            raw=shared.raw,
            error=shared.error,
            transcript=shared.transcript,
        )
        if fetch.error:
            return fetch
        try:
            fetch.data = parser(fetch.raw)
        except Exception as exc:  # noqa: BLE001 - a bad parse must not kill the panel
            log.exception("parser failed for %s", command)
            fetch.error = f"Parser failed ({exc}). Raw output is still available."
        return fetch

    #: Spellings of the general status page. `show system` is the canonical
    #: form everywhere ("default is information" per the CLI help) -- W.15
    #: rejects the hyphenated spelling outright, so that is only a fallback
    #: for the old trains that never learned the short form.
    SYSTEM_INFO_COMMANDS = (
        "show system",
        "show system-information",
        "show system information",
    )

    def _system_info(self, *, cache: float) -> Fetch:
        return self._first_answer(self.SYSTEM_INFO_COMMANDS, parse_system_info, cache=cache)

    def _structured(self, command: str, *, cache: float = 0.0, timeout: float = 40.0) -> Fetch:
        """A ``show`` command parsed into the generic kv+tables structure.

        Used for everything without a dedicated parser, so the UI never has to
        fall back to dumping console text.
        """
        return self._parsed(command, parse_structured, cache=cache, timeout=timeout)

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
        version = self._parsed("show version", parse_version, cache=300)
        flash = self._parsed("show flash", parse_flash, cache=60)
        uptime_seconds = _uptime_seconds(version.raw + "\n" + info.raw)

        # Not every train answers the status page at all ("Invalid input:
        # system-information"), and some that do omit CPU or memory.  `show
        # cpu`, `show memory` and `show uptime` fill the gaps -- and their
        # fetches are surfaced in the payload, so when a train prints yet
        # another format, the dashboard shows the raw output to fix from.
        data = dict(info.data or {})
        resources: dict[str, Any] = {}
        if not data.get("cpu"):
            cpu = self._parsed("show cpu", parse_cpu, cache=5, timeout=20)
            resources["cpu"] = cpu.as_dict()
            if cpu.data:
                data["cpu"] = cpu.data
        if not (data.get("mem_total") and data.get("mem_free")):
            mem = self._parsed("show memory", parse_memory, cache=15, timeout=20)
            resources["memory"] = mem.as_dict()
            if mem.data and mem.data.get("total"):
                data["mem_total"] = data.get("mem_total") or mem.data["total"]
                data["mem_free"] = data.get("mem_free") or mem.data["free"]
        if uptime_seconds is None:
            up = self._parsed("show uptime", parse_uptime, cache=5, timeout=15)
            resources["uptime"] = up.as_dict()
            if up.data is not None:
                uptime_seconds = up.data
        info_payload = info.as_dict()
        info_payload["data"] = data or None

        # Environment sensors -- not every model has them; a rejected command
        # is cached like any other fetch and the UI simply hides the card.
        environment = {
            "temperature": self._structured("show system temperature", cache=60, timeout=15).as_dict(),
            "fans": self._structured("show system fans", cache=60, timeout=15).as_dict(),
            "power": self._structured("show system power-supply", cache=60, timeout=15).as_dict(),
        }

        return {
            "info": info_payload,
            "version": version.as_dict(),
            "flash": flash.as_dict(),
            "uptime_seconds": uptime_seconds,
            "resources": resources,
            "environment": environment,
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
            "config": self._structured("show spanning-tree config", cache=15).as_dict(),
            "mst": self._structured("show spanning-tree mst-config", cache=30).as_dict(),
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
            "rip": self._structured("show ip rip", cache=30).as_dict(),
            "helper": self._structured("show ip helper-address", cache=30).as_dict(),
        }

    def poe(self) -> dict[str, Any]:
        return {
            "brief": self._parsed(
                "show power-over-ethernet brief", parse_poe, cache=3
            ).as_dict(),
            "summary": self._structured("show power-over-ethernet", cache=5).as_dict(),
        }

    def security(self) -> dict[str, Any]:
        return {
            "port_security": self._structured("show port-security", cache=15).as_dict(),
            "authentication": self._structured("show authentication", cache=30).as_dict(),
            "radius": self._structured("show radius", cache=30).as_dict(),
            "tacacs": self._structured("show tacacs", cache=30).as_dict(),
            "dhcp_snooping": self._structured("show dhcp-snooping", cache=15).as_dict(),
            "arp_protect": self._structured("show arp-protect", cache=30).as_dict(),
            "8021x": self._structured("show port-access authenticator", cache=30).as_dict(),
            "snmp": self._parsed("show snmp-server", parse_snmp_server, cache=30).as_dict(),
            "ssh": self._structured("show ip ssh", cache=30).as_dict(),
            "telnet": self._structured("show telnet", cache=30).as_dict(),
            "web": self._structured("show web-management", cache=30).as_dict(),
        }

    def qos(self) -> dict[str, Any]:
        return {
            "queue": self._structured("show qos queue-config", cache=30).as_dict(),
            "port_priority": self._structured("show qos port-priority", cache=30).as_dict(),
            "dscp": self._structured("show qos dscp-map", cache=30).as_dict(),
            "device_priority": self._structured("show qos device-priority", cache=30).as_dict(),
            "rate_limit": self._structured("show rate-limit all", cache=30).as_dict(),
        }

    def acls(self) -> dict[str, Any]:
        return {
            "list": self._structured("show access-list", cache=15).as_dict(),
            # Kept as text on purpose: this is the editor's source material.
            "config": self.show("show access-list config", cache=15).as_dict(),
            "ports": self._structured("show access-list ports all", cache=15).as_dict(),
        }

    def show_structured(self, command: str, timeout: float = 60.0) -> dict[str, Any]:
        """One arbitrary ``show`` command, structured.

        Backs the argumented reads the fixed sections cannot model: per-port
        statistics, RMON counters, ACL statistics, ``show tech``.
        """
        return self._structured(command, cache=3, timeout=timeout).as_dict()

    def firmware(self) -> dict[str, Any]:
        """Flash images, boot settings and their raw sources."""
        return {
            "flash": self._parsed("show flash", parse_flash, cache=10).as_dict(),
            "version": self._parsed("show version", parse_version, cache=10).as_dict(),
            # Not every train has these two; the panel hides them on error.
            "boot_history": self._structured("show boot-history", cache=120).as_dict(),
            "config_files": self._structured("show config files", cache=30).as_dict(),
        }

    def protocols(self) -> dict[str, Any]:
        """L2/L3 protocol features beyond the core panels.

        Command spellings vary per train; anything a train rejects arrives as
        an errored fetch and the panel hides that card.
        """
        f = self._structured
        return {
            "gvrp": f("show gvrp", cache=30).as_dict(),
            "igmp": self._first_answer(
                ("show igmp", "show ip igmp"), parse_structured, cache=30
            ).as_dict(),
            "igmp_proxy": f("show igmp-proxy", cache=60).as_dict(),
            "loop_protect": f("show loop-protect", cache=30).as_dict(),
            "link_keepalive": f("show link-keepalive", cache=30).as_dict(),
            "sflow": self._first_answer(
                ("show sflow agent", "show sflow"), parse_structured, cache=60
            ).as_dict(),
            "dhcp_relay": f("show dhcp-relay", cache=30).as_dict(),
            "dhcp_client": f("show dhcp", cache=60).as_dict(),
            "cdp": f("show cdp", cache=60).as_dict(),
            "jumbos": f("show jumbos", cache=60).as_dict(),
            "timep": f("show timep", cache=60).as_dict(),
            "stack": f("show stack", cache=120).as_dict(),
        }

    def extras(self) -> dict[str, Any]:
        """The long tail: device management, MAC controls, AAA views."""
        f = self._structured
        return {
            "fault_finder": f("show fault-finder", cache=60).as_dict(),
            "filters": f("show filter", cache=30).as_dict(),
            "front_panel": f("show front-panel-security", cache=120).as_dict(),
            "lockout_mac": f("show lockout-mac", cache=15).as_dict(),
            "static_mac": f("show static-mac", cache=15).as_dict(),
            "management": f("show management", cache=60).as_dict(),
            "sessions": f("show session-list", cache=10).as_dict(),
            "console": f("show console", cache=120).as_dict(),
            "snmpv3": self._first_answer(
                ("show snmpv3 user", "show snmpv3"), parse_structured, cache=60
            ).as_dict(),
            "ipv6": f("show ipv6", cache=60).as_dict(),
            "key_chain": f("show key-chain", cache=60).as_dict(),
            "accounting": f("show accounting", cache=60).as_dict(),
            "authorization": f("show authorization", cache=60).as_dict(),
            "tcp_push": f("show tcp-push-preserve", cache=60).as_dict(),
            "encrypt_credentials": f("show encrypt-credentials", cache=60).as_dict(),
            "include_credentials": f("show include-credentials", cache=60).as_dict(),
            "banner": f("show banner", cache=60).as_dict(),
            "autorun": f("show autorun", cache=60).as_dict(),
            "control_plane": f("show control-plane-protection", cache=120).as_dict(),
        }

    def logging(self) -> dict[str, Any]:
        return {
            "log": self._parsed(
                "show logging -r", parse_event_log, cache=5, timeout=60
            ).as_dict(),
            "debug": self._structured("show debug", cache=30).as_dict(),
            "time": self.show("show time", cache=5).as_dict(),
            "sntp": self._structured("show sntp", cache=30).as_dict(),
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

    def apply(
        self, commands: list[str], *, save: bool = False, exec_level: bool = False
    ) -> dict[str, Any]:
        """Push *commands* through config mode, then optionally ``write memory``.

        With *exec_level* the commands run at manager exec level instead --
        that is where ``boot``, ``reload``, ``copy`` and ``erase`` live.
        """
        if exec_level:
            return self._apply_exec(commands, save=save)
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

    def _apply_exec(self, commands: list[str], *, save: bool = False) -> dict[str, Any]:
        """Run *commands* at manager exec level.

        ``save`` runs ``write memory`` *first*, not last: exec commands do not
        create config, and pending changes should be on flash before the reboot
        these commands usually cause.  A failed save aborts the batch -- the
        whole point of asking for it was to not reboot with unsaved changes.
        """
        results: list[dict[str, Any]] = []
        saved = None
        rebooting = False
        # `reload`/`boot` ask "Do you want to save current configuration
        # [y/n/^C]?" when the running config is dirty. Answer it the way the
        # user answered the Apply / Apply & save choice.
        confirm_map = ((SAVE_CONFIRM_RE, "y" if save else "n"),)
        with self.shell.lock:
            if save:
                saved = self._as_dict(self.shell.run("write memory", timeout=60))
                if not saved["ok"]:
                    self._cache.clear()
                    return {"results": [], "ok": False, "saved": saved, "rebooting": False}
            if "config" in self.shell.state.context:
                self.shell.run("exit", timeout=10)
            for command in commands:
                if _REBOOT_RE.match(command):
                    result = self._run_reboot(command, confirm_map=confirm_map)
                    results.append(result)
                    if result["rebooting"]:
                        rebooting = True
                        break  # the switch is going down; nothing else can run
                    continue
                # Image copies (flash-to-flash, TFTP) legitimately take minutes;
                # run() waits out the full timeout, so this is real headroom.
                timeout = 600.0 if re.match(r"\s*copy\b", command, re.I) else 60.0
                results.append(
                    self._as_dict(
                        self.shell.run(command, timeout=timeout, confirm_map=confirm_map)
                    )
                )
        self._cache.clear()
        return {
            "results": results,
            "ok": all(r["ok"] for r in results),
            "saved": saved,
            "rebooting": rebooting,
        }

    def _run_reboot(self, command: str, confirm_map=()) -> dict[str, Any]:
        """Send a command that takes the switch down on purpose.

        The session dying afterwards is the success signal, not an error: both
        channels raise :class:`TransportError` when the far end closes.  If the
        prompt comes back instead, the switch is demonstrably still up -- some
        rejections ("Boot aborted.") are not in the error phrase lists, so the
        prompt itself is the proof, not the text.
        """
        try:
            # A real reboot returns almost immediately via the EOF raise; the
            # generous timeout exists for slow *rejections* (image checks can
            # take a while before "Boot aborted"), which must not be
            # misreported as a reboot.
            result = self.shell.run(command, timeout=30.0, confirm_map=confirm_map)
        except TransportError:
            return {
                "command": command,
                "output": "(connection closed -- the switch is rebooting)",
                "error": None,
                "ok": True,
                "rebooting": True,
            }
        if result.error:
            # Still up: this train rejected the command.
            return {**self._as_dict(result), "rebooting": False}
        if result.reason == "prompt":
            # The last line carries the switch's parting words ("Boot
            # aborted."); the first is just the echoed confirm question.
            lines = [line.strip() for line in result.output.split("\n") if line.strip()]
            detail = lines[-1] if lines else ""
            return {
                **self._as_dict(result),
                "ok": False,
                "error": detail or "The switch answered instead of rebooting.",
                "rebooting": False,
            }
        # Silence until the deadline: the session is going away without a clean
        # TCP close (links drop before the teardown). Treat it as the reboot.
        return {**self._as_dict(result), "ok": True, "rebooting": True}

    def run_raw(self, command: str, timeout: float = 60.0) -> dict[str, Any]:
        """Run a single command exactly as typed (used by the CLI console).

        The save-config question a typed ``reload`` asks is answered "n": a
        console reboot must never silently commit the running config -- that
        would break rebooting to discard a bad change.  The dialogue, answer
        included, stays visible in the transcript.
        """
        result = self.shell.run(command, timeout=timeout, confirm_map=NO_SAVE_MAP)
        self._cache.clear()
        return self._as_dict(result)

    def console_exchange(self, text: str, timeout: float = 45.0) -> dict[str, Any]:
        """One truly interactive console step (the web CLI's transport)."""
        output, at_prompt = self.shell.run_interactive(text, timeout=timeout)
        self._cache.clear()
        return {"output": output, "at_prompt": at_prompt, "prompt": self.shell.state.prompt}

    def console_interrupt(self) -> dict[str, Any]:
        output, at_prompt = self.shell.send_interrupt()
        self._cache.clear()
        return {"output": output, "at_prompt": at_prompt, "prompt": self.shell.state.prompt}

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

#: Commands that end the CLI session by design.  `boot set-default` only sets a
#: flag, and `reload cancel` / scheduled reloads leave the session up.
_REBOOT_RE = re.compile(
    r"^\s*(?:boot(?!\s+set-default)\b|reload(?!\s+(?:cancel|after|at))\b)", re.I
)


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
