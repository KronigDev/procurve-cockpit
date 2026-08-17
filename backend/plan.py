"""Turn UI intents into ProCurve CLI change plans.

Nothing here talks to the switch.  Each builder takes a small JSON payload from
the frontend and returns the exact lines that would be pushed, so the user can
read the diff before anything happens.  :func:`analyze_risk` then flags the
commands that could cut the very session issuing them -- on a switch you manage
in-band, that is the failure mode that actually hurts.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass, field
from typing import Any, Callable

MAX_NAME = 64
_UNSAFE_NAME = re.compile(r'["\x00-\x1f]')


class PlanError(ValueError):
    """The intent could not be turned into valid CLI."""


@dataclass
class Risk:
    level: str          # 'warn' | 'danger'
    message: str
    command: str = ""


@dataclass
class Plan:
    title: str
    commands: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    risks: list[Risk] = field(default_factory=list)
    #: True when the commands must run outside `configure terminal`.
    exec_level: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "title": self.title,
            "commands": self.commands,
            "notes": self.notes,
            "risks": [r.__dict__ for r in self.risks],
            "exec_level": self.exec_level,
        }


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------


def quote(value: str) -> str:
    """Quote a name the way ProCurve expects, rejecting characters it chokes on."""
    value = (value or "").strip()
    if _UNSAFE_NAME.search(value):
        raise PlanError(f'Name contains characters the switch rejects: {value!r}')
    if len(value) > MAX_NAME:
        raise PlanError(f"Name is longer than {MAX_NAME} characters.")
    return f'"{value}"'


def port_list(ports: list[str] | str) -> str:
    """Collapse a port selection into ProCurve's compact ``1-4,7,A1`` notation.

    Only purely numeric ports get folded into ranges; module ports (``A1``) and
    trunks (``Trk1``) are listed individually because their ordering is not
    something we should assume.
    """
    if isinstance(ports, str):
        ports = [p.strip() for p in ports.split(",") if p.strip()]
    if not ports:
        raise PlanError("No ports selected.")
    numeric = sorted({int(p) for p in ports if str(p).isdigit()})
    other = [str(p) for p in ports if not str(p).isdigit()]

    chunks: list[str] = []
    start = prev = None
    for value in numeric:
        if start is None:
            start = prev = value
        elif value == prev + 1:
            prev = value
        else:
            chunks.append(str(start) if start == prev else f"{start}-{prev}")
            start = prev = value
    if start is not None:
        chunks.append(str(start) if start == prev else f"{start}-{prev}")
    return ",".join(chunks + sorted(other))


def vlan_id(value: Any) -> int:
    try:
        vid = int(value)
    except (TypeError, ValueError) as exc:
        raise PlanError(f"Not a VLAN id: {value!r}") from exc
    if not 1 <= vid <= 4094:
        raise PlanError(f"VLAN id out of range (1-4094): {vid}")
    return vid


def cidr(address: str, mask: str = "") -> str:
    """Normalise an address into the ``a.b.c.d/len`` form the CLI wants."""
    address = (address or "").strip()
    if not address:
        raise PlanError("No IP address given.")
    try:
        if "/" in address:
            return str(ipaddress.IPv4Interface(address).with_prefixlen)
        if mask:
            return str(ipaddress.IPv4Interface(f"{address}/{mask.strip()}").with_prefixlen)
    except ValueError as exc:
        raise PlanError(f"Invalid IP address/mask: {address} {mask}".strip()) from exc
    raise PlanError("An IP address needs a subnet mask or prefix length.")


# --------------------------------------------------------------------------
# intent builders
# --------------------------------------------------------------------------


def _ports_of(payload: dict) -> str:
    return port_list(payload.get("ports") or [])


def build_port_settings(p: dict) -> Plan:
    """Enable/disable, name, speed, flow control, broadcast limit, MDI, LLDP."""
    sel = _ports_of(p)
    plan = Plan(title=f"Port settings for {sel}")
    cmds = [f"interface {sel}"]

    if "enabled" in p and p["enabled"] is not None:
        cmds.append("enable" if p["enabled"] else "disable")
        if not p["enabled"]:
            plan.risks.append(Risk("warn", f"Ports {sel} will go down.", "disable"))
    if "name" in p:
        name = (p.get("name") or "").strip()
        cmds.append(f"name {quote(name)}" if name else "no name")
    if p.get("speed_duplex"):
        cmds.append(f"speed-duplex {p['speed_duplex']}")
        plan.notes.append("A speed/duplex change bounces the link.")
    if "flow_control" in p and p["flow_control"] is not None:
        cmds.append("flow-control" if p["flow_control"] else "no flow-control")
    if p.get("broadcast_limit") is not None:
        limit = int(p["broadcast_limit"])
        if not 0 <= limit <= 99:
            raise PlanError("Broadcast limit must be 0-99 percent.")
        cmds.append(f"broadcast-limit {limit}")
    if p.get("mdix_mode"):
        cmds.append(f"mdix-mode {p['mdix_mode']}")
    if p.get("lldp_admin"):
        cmds.append(f"lldp admin-status {p['lldp_admin']}")
    if "unknown_vlans" in p and p["unknown_vlans"]:
        cmds.append(f"unknown-vlans {p['unknown_vlans']}")

    if len(cmds) == 1:
        raise PlanError("Nothing to change.")
    cmds.append("exit")
    plan.commands = cmds
    return plan


def build_port_vlans(p: dict) -> Plan:
    """Move ports between VLANs.

    ProVision refuses a second untagged membership, so the old one is removed
    first whenever the caller tells us what it was.
    """
    sel = _ports_of(p)
    plan = Plan(title=f"VLAN membership for {sel}")
    cmds: list[str] = []

    untagged = p.get("untagged")
    if untagged is not None:
        new_vid = vlan_id(untagged)
        # `current_untagged` maps port -> vid as the UI last saw it.
        current: dict[str, Any] = p.get("current_untagged") or {}
        stale: dict[int, list[str]] = {}
        for port, vid in current.items():
            if vid and int(vid) != new_vid:
                stale.setdefault(int(vid), []).append(str(port))
        for vid, ports in sorted(stale.items()):
            cmds += [f"vlan {vid}", f"no untagged {port_list(ports)}", "exit"]
        cmds += [f"vlan {new_vid}", f"untagged {sel}", "exit"]

    for vid in p.get("tagged_add") or []:
        cmds += [f"vlan {vlan_id(vid)}", f"tagged {sel}", "exit"]
    for vid in p.get("tagged_remove") or []:
        cmds += [f"vlan {vlan_id(vid)}", f"no tagged {sel}", "exit"]
    for vid in p.get("forbid") or []:
        cmds += [f"vlan {vlan_id(vid)}", f"forbid {sel}", "exit"]

    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    plan.notes.append(
        "Ports briefly stop forwarding while they change VLAN membership."
    )
    return plan


def build_vlan_create(p: dict) -> Plan:
    vid = vlan_id(p.get("id"))
    plan = Plan(title=f"Create VLAN {vid}")
    cmds = [f"vlan {vid}"]
    if p.get("name"):
        cmds.append(f"name {quote(p['name'])}")
    if p.get("untagged"):
        cmds.append(f"untagged {port_list(p['untagged'])}")
    if p.get("tagged"):
        cmds.append(f"tagged {port_list(p['tagged'])}")
    if p.get("ip") == "dhcp":
        cmds.append("ip address dhcp-bootp")
    elif p.get("ip"):
        cmds.append(f"ip address {cidr(p['ip'], p.get('mask', ''))}")
    if p.get("jumbo"):
        cmds.append("jumbo")
    if p.get("voice"):
        cmds.append("voice")
    if p.get("helper_address"):
        cmds.append(f"ip helper-address {p['helper_address']}")
    cmds.append("exit")
    plan.commands = cmds
    return plan


def build_vlan_update(p: dict) -> Plan:
    vid = vlan_id(p.get("id"))
    plan = Plan(title=f"Update VLAN {vid}")
    cmds = [f"vlan {vid}"]
    if "name" in p:
        cmds.append(f"name {quote(p['name'])}" if p.get("name") else "no name")
    if "ip" in p:
        if not p["ip"]:
            cmds.append("no ip address")
        elif p["ip"] == "dhcp":
            cmds.append("ip address dhcp-bootp")
        else:
            cmds.append(f"ip address {cidr(p['ip'], p.get('mask', ''))}")
        plan.risks.append(
            Risk("danger", f"Changing the IP of VLAN {vid} can drop your session.", "ip address")
        )
    if "jumbo" in p:
        cmds.append("jumbo" if p["jumbo"] else "no jumbo")
    if "voice" in p:
        cmds.append("voice" if p["voice"] else "no voice")
    if "helper_address" in p:
        cmds.append(
            f"ip helper-address {p['helper_address']}"
            if p["helper_address"]
            else "no ip helper-address"
        )
    if len(cmds) == 1:
        raise PlanError("Nothing to change.")
    cmds.append("exit")
    plan.commands = cmds
    return plan


def build_vlan_delete(p: dict) -> Plan:
    vid = vlan_id(p.get("id"))
    if vid == 1:
        raise PlanError("VLAN 1 (DEFAULT_VLAN) cannot be deleted on ProVision.")
    plan = Plan(title=f"Delete VLAN {vid}")
    plan.commands = [f"no vlan {vid}"]
    plan.risks.append(
        Risk("danger", f"All ports lose VLAN {vid}; untagged members fall back to DEFAULT_VLAN.")
    )
    return plan


def build_vlan_special(p: dict) -> Plan:
    """Primary / management VLAN assignment."""
    vid = vlan_id(p.get("id"))
    role = p.get("role")
    if role == "primary":
        plan = Plan(title=f"Set VLAN {vid} as primary VLAN")
        plan.commands = [f"primary-vlan {vid}"]
    elif role == "management":
        plan = Plan(title=f"Set VLAN {vid} as management VLAN")
        plan.commands = [f"management-vlan {vid}"]
        plan.risks.append(
            Risk(
                "danger",
                "Once a management VLAN is set, the switch is only reachable from that "
                "VLAN. Make sure you are on it.",
            )
        )
    elif role == "no-management":
        plan = Plan(title="Clear management VLAN")
        plan.commands = ["no management-vlan"]
    else:
        raise PlanError(f"Unknown VLAN role: {role!r}")
    return plan


def build_trunk_create(p: dict) -> Plan:
    sel = _ports_of(p)
    group = (p.get("group") or "").strip().lower()
    if not re.fullmatch(r"trk\d+", group):
        raise PlanError("Trunk group must look like 'trk1'.")
    mode = p.get("mode", "lacp")
    if mode not in ("lacp", "trunk", "fec"):
        raise PlanError("Trunk mode must be lacp, trunk or fec.")
    plan = Plan(title=f"Create {group} ({mode}) from {sel}")
    plan.commands = [f"trunk {sel} {group} {mode}"]
    plan.notes.append(
        "Trunk members lose their individual VLAN config; configure VLANs on "
        f"{group} afterwards."
    )
    plan.risks.append(Risk("warn", f"Ports {sel} bounce while the trunk forms."))
    return plan


def build_trunk_delete(p: dict) -> Plan:
    sel = _ports_of(p)
    plan = Plan(title=f"Remove trunk membership of {sel}")
    plan.commands = [f"no trunk {sel}"]
    plan.risks.append(Risk("warn", "Breaking a trunk can create a temporary loop."))
    return plan


def build_stp_global(p: dict) -> Plan:
    plan = Plan(title="Spanning tree (global)")
    cmds: list[str] = []
    if "enabled" in p and p["enabled"] is not None:
        cmds.append("spanning-tree" if p["enabled"] else "no spanning-tree")
        if not p["enabled"]:
            plan.risks.append(
                Risk("danger", "Disabling spanning tree can bring down the network with a loop.")
            )
    if p.get("mode"):
        if p["mode"] not in ("rstp", "mstp", "stp"):
            raise PlanError("STP mode must be rstp, mstp or stp.")
        cmds.append(f"spanning-tree mode {p['mode']}")
    if p.get("priority") is not None:
        prio = int(p["priority"])
        if not 0 <= prio <= 15:
            raise PlanError("Switch priority is a 0-15 multiplier of 4096 on ProVision.")
        cmds.append(f"spanning-tree priority {prio}")
    if p.get("mst_name"):
        cmds.append(f"spanning-tree config-name {quote(p['mst_name'])}")
    if p.get("mst_revision") is not None:
        cmds.append(f"spanning-tree config-revision {int(p['mst_revision'])}")
    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    return plan


def build_stp_port(p: dict) -> Plan:
    sel = _ports_of(p)
    plan = Plan(title=f"Spanning tree on {sel}")
    cmds: list[str] = []
    if p.get("path_cost") is not None:
        cmds.append(f"spanning-tree {sel} path-cost {int(p['path_cost'])}")
    if p.get("priority") is not None:
        cmds.append(f"spanning-tree {sel} priority {int(p['priority'])}")
    for flag, command in (
        ("admin_edge", "admin-edge-port"),
        ("bpdu_protection", "bpdu-protection"),
        ("bpdu_filter", "bpdu-filter"),
        ("root_guard", "root-guard"),
        ("tcn_guard", "tcn-guard"),
        ("point_to_point", "point-to-point-mac"),
    ):
        if flag in p and p[flag] is not None:
            prefix = "" if p[flag] else "no "
            cmds.append(f"{prefix}spanning-tree {sel} {command}")
    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    return plan


def build_poe(p: dict) -> Plan:
    sel = _ports_of(p)
    plan = Plan(title=f"PoE on {sel}")
    cmds: list[str] = []
    if "enabled" in p and p["enabled"] is not None:
        cmds.append(
            f"interface {sel} power-over-ethernet"
            if p["enabled"]
            else f"no interface {sel} power-over-ethernet"
        )
        if not p["enabled"]:
            plan.risks.append(Risk("warn", f"Powered devices on {sel} will reboot."))
    if p.get("priority"):
        if p["priority"] not in ("critical", "high", "low"):
            raise PlanError("PoE priority must be critical, high or low.")
        cmds.append(f"interface {sel} power-over-ethernet {p['priority']}")
    if p.get("allocate_by"):
        if p["allocate_by"] not in ("usage", "class", "value"):
            raise PlanError("PoE allocation must be usage, class or value.")
        cmds.append(f"interface {sel} power-over-ethernet allocate-by {p['allocate_by']}")
    if p.get("max_watts") is not None:
        cmds.append(f"interface {sel} power-over-ethernet maximum {int(p['max_watts'])}")
    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    return plan


def build_system(p: dict) -> Plan:
    plan = Plan(title="System identity & time")
    cmds: list[str] = []
    if p.get("hostname"):
        cmds.append(f"hostname {quote(p['hostname'])}")
    if "location" in p:
        cmds.append(f"snmp-server location {quote(p.get('location') or '')}")
    if "contact" in p:
        cmds.append(f"snmp-server contact {quote(p.get('contact') or '')}")
    if p.get("timezone") is not None:
        cmds.append(f"time timezone {int(p['timezone'])}")
    if p.get("daylight_rule"):
        cmds.append(f"time daylight-time-rule {p['daylight_rule']}")
    if p.get("sntp_servers"):
        cmds.append("timesync sntp")
        cmds.append("sntp unicast")
        for idx, server in enumerate(p["sntp_servers"], start=1):
            cmds.append(f"sntp server priority {idx} {server}")
    if p.get("idle_timeout") is not None:
        cmds.append(f"console idle-timeout {int(p['idle_timeout'])}")
    if "banner" in p:
        banner = (p.get("banner") or "").strip()
        cmds.append(f"banner motd {quote(banner)}" if banner else "no banner motd")
    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    return plan


def build_logging(p: dict) -> Plan:
    plan = Plan(title="Syslog")
    cmds: list[str] = []
    for server in p.get("add_servers") or []:
        cmds.append(f"logging {server}")
    for server in p.get("remove_servers") or []:
        cmds.append(f"no logging {server}")
    if p.get("facility"):
        cmds.append(f"logging facility {p['facility']}")
    if p.get("severity"):
        cmds.append(f"logging severity {p['severity']}")
    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    return plan


def build_snmp(p: dict) -> Plan:
    plan = Plan(title="SNMP")
    cmds: list[str] = []
    for entry in p.get("add_communities") or []:
        access = entry.get("access", "operator")
        if access not in ("operator", "manager"):
            raise PlanError("SNMP access must be operator or manager.")
        line = f"snmp-server community {quote(entry['name'])} {access}"
        if entry.get("unrestricted"):
            line += " unrestricted"
        elif access == "manager":
            line += " restricted"
        cmds.append(line)
        if access == "manager" and entry.get("unrestricted"):
            plan.risks.append(
                Risk("danger", f"Community {entry['name']!r} gets full read/write over SNMP.")
            )
    for name in p.get("remove_communities") or []:
        cmds.append(f"no snmp-server community {quote(name)}")
    for host in p.get("add_hosts") or []:
        cmds.append(f"snmp-server host {host['ip']} community {quote(host['community'])}")
    for host in p.get("remove_hosts") or []:
        cmds.append(f"no snmp-server host {host}")
    for trap in p.get("enable_traps") or []:
        cmds.append(f"snmp-server enable traps {trap}")
    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    return plan


def build_access(p: dict) -> Plan:
    """Management protocol on/off switches -- the classic way to lock yourself out."""
    plan = Plan(title="Management access")
    cmds: list[str] = []
    mapping = {
        "ssh": ("ip ssh", "no ip ssh"),
        "telnet": ("telnet-server", "no telnet-server"),
        "web": ("web-management", "no web-management"),
        "ssh_v2_only": ("ip ssh version 2", None),
    }
    for key, (on, off) in mapping.items():
        if key not in p or p[key] is None:
            continue
        if p[key]:
            cmds.append(on)
        elif off:
            cmds.append(off)
            plan.risks.append(
                Risk("danger", f"Turning off {key} removes a way into the switch.", off)
            )
    if p.get("idle_timeout") is not None:
        cmds.append(f"console idle-timeout {int(p['idle_timeout'])}")
    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    return plan


def build_credentials(p: dict) -> Plan:
    """Manager/operator passwords.

    Uses the one-line ``plaintext`` form because the interactive variant would
    stall waiting for a second prompt we cannot answer safely.
    """
    role = p.get("role")
    if role not in ("manager", "operator"):
        raise PlanError("Role must be manager or operator.")
    plan = Plan(title=f"Set {role} credentials")
    if p.get("remove"):
        plan.commands = [f"no password {role}"]
        plan.risks.append(Risk("danger", f"The {role} account will have no password."))
        return plan
    password = p.get("password") or ""
    if not password:
        raise PlanError("No password given.")
    username = (p.get("username") or "").strip()
    line = f"password {role}"
    if username:
        line += f" user-name {quote(username)}"
    line += f" plaintext {quote(password)}"
    plan.commands = [line]
    plan.risks.append(
        Risk("danger", f"You will need the new {role} password for the next login.")
    )
    plan.notes.append("The password is sent over the SSH session in clear text (CLI limitation).")
    return plan


def build_mirror(p: dict) -> Plan:
    """Port mirroring, K.15 session syntax."""
    session = int(p.get("session", 1))
    if not 1 <= session <= 4:
        raise PlanError("Mirror session must be 1-4.")
    plan = Plan(title=f"Mirror session {session}")
    cmds: list[str] = []
    if p.get("remove"):
        cmds.append(f"no interface {_ports_of(p)} monitor")
        cmds.append(f"no mirror {session}")
    else:
        dest = p.get("destination")
        if not dest:
            raise PlanError("A mirror session needs a destination port.")
        direction = p.get("direction", "both")
        if direction not in ("in", "out", "both"):
            raise PlanError("Mirror direction must be in, out or both.")
        cmds.append(f"mirror {session} port {dest}")
        cmds.append(f"interface {_ports_of(p)} monitor all {direction} mirror {session}")
        plan.notes.append(
            f"Port {dest} becomes a mirror target and stops forwarding normal traffic."
        )
    plan.commands = cmds
    return plan


def build_routing(p: dict) -> Plan:
    plan = Plan(title="IP routing")
    cmds: list[str] = []
    if "enabled" in p and p["enabled"] is not None:
        cmds.append("ip routing" if p["enabled"] else "no ip routing")
    for route in p.get("add_routes") or []:
        dest = cidr(route["destination"], route.get("mask", ""))
        line = f"ip route {dest} {route['gateway']}"
        if route.get("distance") is not None:
            line += f" distance {int(route['distance'])}"
        cmds.append(line)
    for route in p.get("remove_routes") or []:
        cmds.append(f"no ip route {cidr(route['destination'], route.get('mask', ''))} {route['gateway']}")
    if p.get("default_gateway"):
        cmds.append(f"ip default-gateway {p['default_gateway']}")
        plan.risks.append(Risk("warn", "Changing the default gateway affects switch-sourced traffic."))
    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    return plan


def build_port_security(p: dict) -> Plan:
    sel = _ports_of(p)
    plan = Plan(title=f"Port security on {sel}")
    cmds: list[str] = []
    if p.get("remove"):
        cmds.append(f"no port-security {sel}")
    else:
        learn = p.get("learn_mode", "continuous")
        if learn not in ("continuous", "static", "port-access", "configured", "limited-continuous"):
            raise PlanError(f"Unknown learn-mode: {learn}")
        line = f"port-security {sel} learn-mode {learn}"
        if p.get("address_limit") is not None:
            line += f" address-limit {int(p['address_limit'])}"
        if p.get("action"):
            if p["action"] not in ("none", "send-alarm", "send-disable"):
                raise PlanError("Port security action must be none, send-alarm or send-disable.")
            line += f" action {p['action']}"
        cmds.append(line)
        if p.get("action") == "send-disable":
            plan.risks.append(
                Risk("warn", "An intrusion will shut the port down until it is re-enabled.")
            )
    plan.commands = cmds
    return plan


def build_qos(p: dict) -> Plan:
    plan = Plan(title="QoS")
    cmds: list[str] = []
    for entry in p.get("port_priority") or []:
        cmds.append(f"qos port-priority {port_list([entry['port']])} priority {int(entry['priority'])}")
    for entry in p.get("dscp") or []:
        cmds.append(f"qos dscp-map {entry['dscp']} priority {int(entry['priority'])}")
    for entry in p.get("rate_limit") or []:
        direction = entry.get("direction", "in")
        cmds.append(
            f"interface {port_list([entry['port']])} rate-limit all {direction} "
            f"percent {int(entry['percent'])}"
        )
    if not cmds:
        raise PlanError("Nothing to change.")
    plan.commands = cmds
    return plan


def build_raw(p: dict) -> Plan:
    """Free-form config lines -- the escape hatch for everything not modelled."""
    lines = p.get("lines")
    if isinstance(lines, str):
        lines = lines.split("\n")
    lines = [ln.rstrip() for ln in (lines or []) if ln.strip()]
    if not lines:
        raise PlanError("No commands given.")
    plan = Plan(title=f"{len(lines)} raw config line(s)")
    plan.commands = lines
    plan.notes.append("These lines are sent verbatim; the switch validates them, not the UI.")
    return plan


BUILDERS: dict[str, Callable[[dict], Plan]] = {
    "port.settings": build_port_settings,
    "port.vlans": build_port_vlans,
    "port.security": build_port_security,
    "vlan.create": build_vlan_create,
    "vlan.update": build_vlan_update,
    "vlan.delete": build_vlan_delete,
    "vlan.role": build_vlan_special,
    "trunk.create": build_trunk_create,
    "trunk.delete": build_trunk_delete,
    "stp.global": build_stp_global,
    "stp.port": build_stp_port,
    "poe.set": build_poe,
    "system.set": build_system,
    "logging.set": build_logging,
    "snmp.set": build_snmp,
    "access.set": build_access,
    "credentials.set": build_credentials,
    "mirror.set": build_mirror,
    "routing.set": build_routing,
    "qos.set": build_qos,
    "raw": build_raw,
}


def build(intent: str, payload: dict) -> Plan:
    builder = BUILDERS.get(intent)
    if builder is None:
        raise PlanError(f"Unknown intent {intent!r}.")
    plan = builder(payload or {})
    plan.risks.extend(analyze_risk(plan.commands, payload.get("context") or {}))
    return plan


# --------------------------------------------------------------------------
# lockout analysis
# --------------------------------------------------------------------------

_LOCKOUT_PATTERNS: tuple[tuple[re.Pattern[str], str, str], ...] = (
    (re.compile(r"^\s*no\s+ip\s+ssh\b", re.I), "danger", "This disables SSH -- the way you are connected right now."),
    (re.compile(r"^\s*erase\s+startup", re.I), "danger", "This wipes the saved configuration."),
    (re.compile(r"^\s*(reload|boot)\b", re.I), "danger", "This reboots the switch."),
    (re.compile(r"^\s*no\s+vlan\s+1\b", re.I), "danger", "DEFAULT_VLAN cannot be removed."),
    (re.compile(r"^\s*setup\b", re.I), "warn", "'setup' opens an interactive screen the UI cannot drive."),
    (re.compile(r"^\s*(menu|logout|exit\s+all)\b", re.I), "warn", "This leaves the CLI session."),
    (re.compile(r"^\s*no\s+aaa\b", re.I), "warn", "Changing AAA can lock out every login method."),
    (re.compile(r"^\s*crypto\s+key\s+zeroize", re.I), "danger", "This deletes the SSH host key; every client will see a key change."),
)


def analyze_risk(commands: list[str], context: dict) -> list[Risk]:
    """Flag commands that could sever the management session.

    *context* carries what the frontend knows about the live session -- the
    management VLAN and the switch address we are connected to -- so the check
    can be specific instead of warning about every IP change.
    """
    risks: list[Risk] = []
    mgmt_vlan = context.get("management_vlan")
    mgmt_ip = context.get("management_ip")

    current_vlan: int | None = None
    for command in commands:
        for pattern, level, message in _LOCKOUT_PATTERNS:
            if pattern.search(command):
                risks.append(Risk(level, message, command))

        vlan_match = re.match(r"^\s*vlan\s+(\d+)\s*$", command, re.I)
        if vlan_match:
            current_vlan = int(vlan_match.group(1))
            continue
        if re.match(r"^\s*exit\s*$", command, re.I):
            current_vlan = None
            continue

        if mgmt_vlan and current_vlan == int(mgmt_vlan):
            if re.match(r"^\s*(no\s+)?ip\s+address", command, re.I):
                risks.append(
                    Risk("danger", f"This changes the IP of management VLAN {mgmt_vlan}.", command)
                )
            if re.match(r"^\s*no\s+(un)?tagged", command, re.I):
                risks.append(
                    Risk(
                        "warn",
                        f"Removing ports from management VLAN {mgmt_vlan} may cut your path.",
                        command,
                    )
                )
        if mgmt_ip and mgmt_ip in command and re.search(r"no\s+ip\s+address", command, re.I):
            risks.append(Risk("danger", f"This removes {mgmt_ip}, the address you connected to.", command))

    # De-duplicate identical (level, message, command) triples.
    seen: set[tuple[str, str, str]] = set()
    unique: list[Risk] = []
    for risk in risks:
        key = (risk.level, risk.message, risk.command)
        if key not in seen:
            seen.add(key)
            unique.append(risk)
    return unique
