"""Parsers for ProCurve ``show`` output.

ProVision firmware formats almost every table the same way: an optional
preamble of ``Key : Value`` lines, one or more header lines, a line of dashes
that defines the column boundaries, then the rows.  Rather than hard-coding
column offsets per command -- which drifts between K/W/WB firmware trains -- we
derive the columns from the dash line itself.  That makes the parsers survive
firmware differences, and anything genuinely unparseable still reaches the UI as
raw text.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

DASH_LINE_RE = re.compile(r"^[\s\-+|]*$")
# The key charset includes []: ProVision prints defaults in brackets on the
# config-flavoured pages ("STP Enabled [No] : Yes"); the bracket part is
# stripped from the key after matching.
KV_RE = re.compile(r"(?P<k>[A-Za-z][A-Za-z0-9 _/%()#.\-\[\]]*?)\s*:\s*(?P<v>.*?)\s*(?=$)")
_KV_DEFAULT_RE = re.compile(r"\s*\[[^\]]*\]\s*$")


# --------------------------------------------------------------------------
# generic building blocks
# --------------------------------------------------------------------------


def _is_dash_line(line: str) -> bool:
    return bool(line.strip()) and DASH_LINE_RE.match(line) is not None and line.count("-") >= 5


def _column_spans(dash_line: str) -> list[tuple[int, int]]:
    """Column boundaries derived from the runs of ``-`` in the separator line.

    Each span is widened to the start of the following one so values that
    overflow their column (long port names, big counters) are not truncated.
    """
    runs = [(m.start(), m.end()) for m in re.finditer(r"-+", dash_line)]
    spans: list[tuple[int, int]] = []
    for idx, (start, _end) in enumerate(runs):
        next_start = runs[idx + 1][0] if idx + 1 < len(runs) else 10**6
        spans.append((0 if idx == 0 else start, next_start))
    return spans


def _slice(line: str, span: tuple[int, int]) -> str:
    return line[span[0] : span[1]].strip().strip("|+").strip()


def _headers(lines: list[str], dash_idx: int, spans: list[tuple[int, int]]) -> list[str]:
    """Join up to three stacked header lines per column."""
    header_lines: list[str] = []
    for i in range(dash_idx - 1, max(-1, dash_idx - 4), -1):
        line = lines[i]
        if not line.strip() or _is_dash_line(line):
            break
        header_lines.insert(0, line)
    names: list[str] = []
    seen: dict[str, int] = {}
    for col, span in enumerate(spans):
        parts = [_slice(line, span) for line in header_lines]
        name = " ".join(p for p in parts if p).strip() or f"col{col + 1}"
        # `show trunks` has two columns called "Type"; keep both reachable
        # instead of letting the second silently overwrite the first.
        if name in seen:
            seen[name] += 1
            name = f"{name} {seen[name]}"
        else:
            seen[name] = 1
        names.append(name)
    return names


def parse_table(text: str, start: int = 0) -> tuple[list[dict[str, str]], list[str], int]:
    """Parse the first dash-delimited table found at or after line *start*.

    Returns ``(rows, headers, next_line_index)``; ``rows`` is empty when no
    table is present.
    """
    lines = text.split("\n")
    dash_idx = -1
    for i in range(start, len(lines)):
        # A real column separator has at least two dash runs; a single
        # full-width run is just a divider between record blocks and must not
        # spawn a one-column garbage table.
        if _is_dash_line(lines[i]) and len(re.findall(r"-+", lines[i])) >= 2:
            dash_idx = i
            break
    if dash_idx == -1:
        return [], [], len(lines)

    spans = _column_spans(lines[dash_idx])
    headers = _headers(lines, dash_idx, spans)
    rows: list[dict[str, str]] = []
    i = dash_idx + 1
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            # A blank line ends the table, full stop. Trying to be clever here
            # ("the next line is indented, so it is probably still data") ate
            # whole following sections: `show snmp-server` continues with
            # " Trap Receivers" and its key/value block, all of which got
            # sliced into the community table's columns.
            break
        if _is_dash_line(line):
            break
        values = [_slice(line, span) for span in spans]
        if not any(values):
            break
        rows.append(dict(zip(headers, values)))
        i += 1
    return rows, headers, i


def parse_all_tables(text: str) -> list[list[dict[str, str]]]:
    """Every dash-delimited table in *text*, in order.

    An *empty* table (separator followed by a blank line -- "no entries" on
    this switch) is skipped, not treated as the end: real output puts
    populated tables after empty ones.
    """
    tables: list[list[dict[str, str]]] = []
    idx = 0
    lines_total = len(text.split("\n"))
    while idx < lines_total:
        rows, _headers_, next_idx = parse_table(text, idx)
        if rows:
            tables.append(rows)
        if next_idx <= idx:
            break
        idx = next_idx
    return tables


def parse_kv(text: str) -> dict[str, str]:
    """Collect ``Key : Value`` pairs, including several pairs on one line.

    ProCurve's ``show system-information`` puts two columns of pairs on a single
    line, so we split on runs of two-plus spaces before matching.
    """
    result: dict[str, str] = {}
    for raw in text.split("\n"):
        line = raw.rstrip()
        if ":" not in line:
            continue
        if _is_dash_line(line):
            continue
        # Split into chunks that each hold at most one "key : value" pair.
        chunks = _split_kv_chunks(line)
        for chunk in chunks:
            m = KV_RE.match(chunk.strip())
            if not m:
                continue
            key = re.sub(r"\s+", " ", m.group("k")).strip()
            # Drop a trailing "[default]" -- the value carries the live state.
            key = _KV_DEFAULT_RE.sub("", key)
            value = m.group("v").strip()
            if key and key not in result:
                result[key] = value
    return result


def _split_kv_chunks(line: str) -> list[str]:
    """Cut *line* before every ``<gap><key> :`` that starts a new pair."""
    cuts = [0]
    for m in re.finditer(r"\s{2,}(?=[A-Za-z][A-Za-z0-9 _/%()#.\-\[\]]*?\s*:)", line):
        if m.start() > 0:
            cuts.append(m.end())
    cuts.append(len(line))
    return [line[cuts[i] : cuts[i + 1]] for i in range(len(cuts) - 1)]


def _get(row: dict[str, str], *candidates: str, default: str = "") -> str:
    """Fetch a value by fuzzy header name -- headers wobble between firmwares."""
    lowered = {k.lower().replace(" ", ""): v for k, v in row.items()}
    for cand in candidates:
        key = cand.lower().replace(" ", "")
        if key in lowered:
            return lowered[key]
    for cand in candidates:
        key = cand.lower().replace(" ", "")
        for k, v in lowered.items():
            if key in k:
                return v
    return default


def _yes(value: str) -> bool:
    return value.strip().lower() in ("yes", "y", "on", "enabled", "true", "up")


# --------------------------------------------------------------------------
# command specific parsers
# --------------------------------------------------------------------------


def parse_system_info(text: str) -> dict[str, Any]:
    """``show system-information``.

    Memory and CPU are pulled with dedicated patterns: the firmware prints them
    in a two-column block where the labels are indented continuations
    (``Memory   - Total``, then a bare ``Free`` on the next line), which is more
    than the generic key/value split should have to guess at.
    """
    kv = parse_kv(text)
    return {
        "name": _pick(kv, "System Name"),
        "contact": _pick(kv, "System Contact"),
        "location": _pick(kv, "System Location"),
        "software": _pick(kv, "Software revision", "Software Revision"),
        "rom": _pick(kv, "ROM Version"),
        "serial": _pick(kv, "Serial Number"),
        "base_mac": _pick(kv, "Base MAC Addr", "MAC Address"),
        # These three sit in the two-column half of the block, where a firmware
        # that lays the columns out differently can defeat the key/value split.
        # Fall back to scanning the raw text for the label itself.
        "uptime": _pick(kv, "Up Time", "Uptime") or _scan_pair(text, r"Up\s*-?\s*Time"),
        "cpu": (_pick(kv, "CPU Util (%)", "CPU Util")
                or _scan_pair(text, r"CPU\s*Util[^:\n]*")),
        "mem_total": _memory(text, "Total"),
        "mem_free": _memory(text, "Free"),
        "mac_age": _pick(kv, "MAC Age Time (sec)", "MAC Age Time"),
        "time_zone": _pick(kv, "Time Zone"),
        "raw": kv,
    }


def _scan_pair(text: str, label_pattern: str) -> str:
    """Find ``<label> : <value>`` in raw text, stopping before the next column.

    Used only as a fallback for the two-column status block: a value there ends
    either at the end of the line or where the next ``Key :`` pair begins.
    """
    m = re.search(
        rf"{label_pattern}\s*:\s*(?P<v>.*?)(?=\s{{2,}}[A-Za-z][\w /%()\-]*\s*:|$)",
        text,
        re.I | re.M,
    )
    return m.group("v").strip() if m else ""


_MEM_BLOCK_RE = re.compile(
    r"Memory\s*-?\s*Total\s*:\s*(?P<total>[\d,]+)(?P<rest>(?:.|\n)*?)(?:\n\s*\n|\Z)",
    re.I,
)


def _memory(text: str, which: str) -> str:
    """Pull the switch's memory figures out of the two-column status block."""
    block = _MEM_BLOCK_RE.search(text)
    if not block:
        return ""
    if which.lower() == "total":
        return block.group("total")
    free = re.search(r"\bFree\s*:\s*([\d,]+)", block.group("rest"), re.I)
    return free.group(1) if free else ""


def _pick(kv: dict[str, str], *names: str) -> str:
    """First value whose key matches one of *names*, in three widening passes.

    The passes are tried in order across *all* names before the next one
    starts, so an exact hit on the second name still beats a fuzzy hit on the
    first.  Matching walks the pairs instead of indexing: labels come straight
    off the wire, and a lookup helper should not be able to raise on one.
    """
    pairs = list(kv.items())
    for name in names:
        for key, value in pairs:
            if key == name:
                return value
    lowered = [(key.lower(), value) for key, value in pairs]
    for name in names:
        needle = name.lower()
        for key, value in lowered:
            if key == needle:
                return value
    # Last resort: the firmware sometimes prefixes a label ("Memory - Total").
    for name in names:
        needle = name.lower()
        for key, value in lowered:
            if needle in key:
                return value
    return ""


def parse_ports(text: str) -> list[dict[str, Any]]:
    """``show interfaces brief`` -> one dict per physical port."""
    rows, _h, _i = parse_table(text)
    ports: list[dict[str, Any]] = []
    for row in rows:
        port = _get(row, "Port")
        if not port or port.lower().startswith("port"):
            continue
        ports.append(
            {
                "port": port,
                "type": _get(row, "Type"),
                "enabled": _yes(_get(row, "Enabled")),
                "status": _get(row, "Status") or "Down",
                "up": _get(row, "Status").strip().lower() == "up",
                "mode": _get(row, "Mode"),
                "mdi": _get(row, "MDI Mode", "MDI"),
                "flow_control": _get(row, "Flow Ctrl", "Flow Control"),
                "bcast_limit": _get(row, "Bcast Limit", "Bcast"),
                "intrusion": _get(row, "Intrusion Alert", "Intrusion"),
            }
        )
    return ports


def parse_port_names(text: str) -> dict[str, str]:
    """``show name`` -> friendly name per port."""
    names: dict[str, str] = {}
    for table in parse_all_tables(text):
        for row in table:
            port = _get(row, "Port")
            if port:
                names[port] = _get(row, "Name")
    # Older firmware prints "Port : 1  Name : uplink" blocks instead of a table.
    if not names:
        for block in re.split(r"\n\s*\n", text):
            kv = parse_kv(block)
            if "Port" in kv:
                names[kv["Port"]] = kv.get("Name", "")
    return names


def parse_port_config(text: str) -> dict[str, dict[str, str]]:
    """``show interfaces config`` -> the *configured* settings per port.

    ``show interfaces brief`` reports what the link negotiated (``1000FDx``,
    ``MDIX``, ``off``).  The inspector has to preselect what is actually in the
    running config (``Auto``, ``Auto-MDIX``, ``Disable``) -- otherwise picking
    "the value that is already shown" would generate a real config change.
    """
    config: dict[str, dict[str, str]] = {}
    for table in parse_all_tables(text):
        for row in table:
            port = _get(row, "Port")
            if not port or port.lower().startswith("port"):
                continue
            config[port] = {
                "enabled": _get(row, "Enabled"),
                "mode": _get(row, "Mode"),
                "flow_ctrl": _get(row, "Flow Ctrl", "Flow Control"),
                "mdi": _get(row, "MDI Mode", "MDI"),
            }
    return config


#: `show lldp config` spells the mode Tx_Rx / TxOnly / RxOnly depending on the
#: firmware train; the UI and the CLI both want tx_rx / tx_only / rx_only.
_LLDP_ADMIN = {
    "tx_rx": "tx_rx",
    "txrx": "tx_rx",
    "tx_only": "tx_only",
    "txonly": "tx_only",
    "rx_only": "rx_only",
    "rxonly": "rx_only",
    "disable": "disable",
    "disabled": "disable",
}


def parse_lldp_config(text: str) -> dict[str, str]:
    """``show lldp config`` -> per-port admin status, normalised to CLI values."""
    out: dict[str, str] = {}
    for table in parse_all_tables(text):
        for row in table:
            port = _get(row, "Port")
            status = _get(row, "AdminStatus", "Admin Status")
            if not port or not status:
                continue
            key = status.strip().lower().replace("-", "_")
            out[port] = _LLDP_ADMIN.get(key, status.strip())
    return out


def parse_stp_port_config(text: str) -> dict[str, dict[str, Any]]:
    """``show spanning-tree config`` -> per-port STP settings.

    The column set differs noticeably between the RSTP and MSTP builds, so
    every lookup goes through the fuzzy header matcher and simply yields a
    default when a column is absent on this firmware.
    """
    out: dict[str, dict[str, Any]] = {}
    for table in parse_all_tables(text):
        for row in table:
            port = _get(row, "Port")
            if not port or not re.match(r"^[A-Za-z]?\d", port):
                continue
            out[port] = {
                "path_cost": _get(row, "Path Cost", "Cost"),
                "priority": _get(row, "Priority", "Prio"),
                "admin_edge": _yes(_get(row, "Admin Edge Port", "Edge Port", "Edge")),
                "bpdu_protection": _yes(_get(row, "BPDU Protection", "BPDU Guard")),
                "root_guard": _yes(_get(row, "Root Guard", "Root Grd")),
            }
    return out


def parse_vlans(text: str) -> list[dict[str, Any]]:
    """``show vlans``."""
    kv = parse_kv(text)
    rows, _h, _i = parse_table(text)
    vlans: list[dict[str, Any]] = []
    for row in rows:
        vid = _get(row, "VLAN ID", "VLAN")
        if not vid.isdigit():
            continue
        vlans.append(
            {
                "id": int(vid),
                "name": _get(row, "Name"),
                "status": _get(row, "Status"),
                "voice": _yes(_get(row, "Voice")),
                "jumbo": _yes(_get(row, "Jumbo")),
                "management": _get(row, "Management", default=""),
            }
        )
    primary = kv.get("Primary VLAN", "")
    mgmt = kv.get("Management VLAN", "")
    for vlan in vlans:
        vlan["primary"] = vlan["name"] == primary or str(vlan["id"]) == primary
        vlan["is_mgmt"] = bool(mgmt) and (vlan["name"] == mgmt or str(vlan["id"]) == mgmt)
    return vlans


def parse_vlan_ports(text: str) -> list[dict[str, str]]:
    """``show vlan <id>`` -> port membership rows."""
    rows, _h, _i = parse_table(text)
    out: list[dict[str, str]] = []
    for row in rows:
        port = _get(row, "Port Information", "Port")
        if not port:
            continue
        out.append(
            {
                "port": port,
                "mode": _get(row, "Mode").lower(),
                "unknown_vlan": _get(row, "Unknown VLAN"),
                "status": _get(row, "Status"),
            }
        )
    return out


def parse_trunks(text: str) -> list[dict[str, str]]:
    """``show trunks``."""
    rows, _h, _i = parse_table(text)
    out: list[dict[str, str]] = []
    for row in rows:
        port = _get(row, "Port")
        group = _get(row, "Group Name", "Group")
        if not port or not group:
            continue
        out.append(
            {
                "port": port,
                "name": _get(row, "Name"),
                "group": group,
                # The row carries the port's media type *and* the trunk type
                # under headers that both read "Type"; the deduplicated second
                # one is the trunk protocol (LACP / Trk).
                "type": _get(row, "Group Type", "Type 2", "Type"),
            }
        )
    return out


def parse_lacp(text: str) -> list[dict[str, str]]:
    """``show lacp``."""
    rows, _h, _i = parse_table(text)
    return [
        {
            "port": _get(row, "Port", "PORT", "Numb"),
            "enabled": _get(row, "LACP Enabled", "Enabled"),
            "trunk": _get(row, "Trunk Group", "Trunk"),
            "status": _get(row, "Port Status", "Status"),
            "partner": _get(row, "LACP Partner", "Partner"),
            "key": _get(row, "Admin Key", "Key"),
        }
        for row in rows
        if _get(row, "Port", "PORT", "Numb")
    ]


def parse_lldp_neighbors(text: str) -> list[dict[str, str]]:
    """``show lldp info remote-device``."""
    rows, _h, _i = parse_table(text)
    out: list[dict[str, str]] = []
    for row in rows:
        port = _get(row, "LocalPort", "Local Port", "Port")
        if not port:
            continue
        out.append(
            {
                "port": port,
                "chassis_id": _get(row, "ChassisId", "Chassis Id"),
                "port_id": _get(row, "PortId", "Port Id"),
                "port_descr": _get(row, "PortDescr", "Port Descr"),
                "system_name": _get(row, "SysName", "System Name"),
            }
        )
    return out


def parse_mac_table(text: str) -> list[dict[str, str]]:
    """``show mac-address``."""
    out: list[dict[str, str]] = []
    for table in parse_all_tables(text):
        for row in table:
            mac = _get(row, "MAC Address", "MAC")
            if not mac or "-" not in mac:
                continue
            out.append(
                {
                    "mac": mac,
                    "port": _get(row, "Located on Port", "Port"),
                    "vlan": _get(row, "VLAN"),
                }
            )
    return out


def parse_arp(text: str) -> list[dict[str, str]]:
    """``show arp``."""
    rows, _h, _i = parse_table(text)
    return [
        {
            "ip": _get(row, "IP Address", "IP"),
            "mac": _get(row, "MAC Address", "MAC"),
            "type": _get(row, "Type"),
            "port": _get(row, "Port"),
        }
        for row in rows
        if _get(row, "IP Address", "IP")
    ]


def parse_poe(text: str) -> list[dict[str, Any]]:
    """``show power-over-ethernet brief``."""
    out: list[dict[str, Any]] = []
    for table in parse_all_tables(text):
        for row in table:
            port = _get(row, "Port")
            if not port or not re.match(r"^[A-Za-z]?\d", port):
                continue
            out.append(
                {
                    "port": port,
                    "enabled": _yes(_get(row, "Power Enable", "Enable")),
                    "priority": _get(row, "Priority", "Pri"),
                    "alloc_by": _get(row, "Alloc By", "Allocated By"),
                    "alloc": _get(row, "Alloc Power", "Allocated"),
                    "actual": _get(row, "Actual Power", "Actual"),
                    "status": _get(row, "Status", "Power Status"),
                    "class": _get(row, "Class"),
                }
            )
    return out


def parse_stp(text: str) -> dict[str, Any]:
    """``show spanning-tree``."""
    kv = parse_kv(text)
    rows, _h, _i = parse_table(text)
    ports = [
        {
            "port": _get(row, "Port"),
            "type": _get(row, "Type"),
            "cost": _get(row, "Cost"),
            "priority": _get(row, "Priority", "Prio"),
            "state": _get(row, "State"),
            "role": _get(row, "Role"),
            "designated_bridge": _get(row, "Designated Bridge", "Desig Bridge"),
        }
        for row in rows
        if _get(row, "Port")
    ]
    return {
        "enabled": _yes(kv.get("STP Enabled", kv.get("Spanning Tree", "No"))),
        "mode": kv.get("Mode", kv.get("Protocol Version", "")),
        "priority": kv.get("Switch Priority", kv.get("Priority", "")),
        "root_mac": kv.get("Root MAC Address", ""),
        "root_path_cost": kv.get("Root Path Cost", ""),
        "root_port": kv.get("Root Port", ""),
        "ports": ports,
        "info": kv,
    }


def parse_ip_config(text: str) -> list[dict[str, str]]:
    """``show ip`` -> per-VLAN addressing."""
    out: list[dict[str, str]] = []
    for table in parse_all_tables(text):
        for row in table:
            vlan = _get(row, "VLAN")
            if not vlan:
                continue
            out.append(
                {
                    "vlan": vlan,
                    "config": _get(row, "IP Config", "Config"),
                    "ip": _get(row, "IP Address", "IP"),
                    "mask": _get(row, "Subnet Mask", "Mask"),
                    "proxy_arp": _get(row, "Proxy ARP", default=""),
                }
            )
    return out


def parse_routes(text: str) -> list[dict[str, str]]:
    """``show ip route``."""
    rows, _h, _i = parse_table(text)
    return [
        {
            "destination": _get(row, "Destination"),
            "gateway": _get(row, "Gateway"),
            "vlan": _get(row, "VLAN"),
            "type": _get(row, "Type"),
            "metric": _get(row, "Metric"),
            "distance": _get(row, "Dist.", "Distance"),
        }
        for row in rows
        if _get(row, "Destination")
    ]


#: `Primary Image : 10475866 03/09/16 W.15.14.0012` -- size, date and version
#: share the value column, which is why the generic key/value split cannot be
#: used here.  Date and version are optional so an erased image still parses;
#: the whitespace between fields is `[^\S\n]` (space/tab, never a newline) so
#: an image row with empty columns cannot swallow the start of the next line.
_FLASH_IMAGE_RE = re.compile(
    r"^[^\S\n]*(?P<slot>Primary|Secondary)[^\S\n]+Image[^\S\n]*:?[^\S\n]*(?P<size>[\d,]+)"
    r"(?:[^\S\n]+(?P<date>\d{1,2}/\d{1,2}/\d{2,4}))?"
    r"(?:[^\S\n]+(?P<version>[A-Za-z][\w.]+))?",
    re.I | re.M,
)


def parse_flash(text: str) -> dict[str, Any]:
    """``show flash`` -> both images, boot ROM version and the default boot.

    The spellings drift between trains (``Boot Rom Version`` / ``BootROM
    Version``, ``Default Boot`` / ``Default Boot Image``), so the labels are
    matched loosely.
    """
    images = []
    for m in _FLASH_IMAGE_RE.finditer(text):
        images.append(
            {
                "slot": m.group("slot").lower(),
                "size_bytes": int(m.group("size").replace(",", "")),
                "date": m.group("date") or "",
                "version": m.group("version") or "",
            }
        )
    rom = re.search(r"Boot\s*ROM\s*Version\s*:\s*(\S+)", text, re.I)
    default = re.search(r"Default\s*Boot(?:\s*Image)?\s*:\s*([A-Za-z]+)", text, re.I)
    return {
        "images": images,
        "boot_rom": rom.group(1) if rom else "",
        "default_boot": default.group(1).lower() if default else "",
        "fields": parse_kv(text),
    }


#: The software revision stands on a line of its own inside the image stamp
#: block ("W.15.14.0012", "KB.16.03.0004", "U.11.62").  Factory-installed
#: builds carry a lowercase suffix ("W.15.14.0012m"), printed verbatim.
_SW_VERSION_RE = re.compile(
    r"^\s*(?P<v>[A-Z]{1,3}\.\d{2}\.\d{2}(?:\.\d{1,4})?[a-z]?)\s*$", re.M
)
_BUILD_DATE_RE = re.compile(
    r"^\s*(?P<d>[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}\s+\d{2}:\d{2}:\d{2})\s*$", re.M
)


def parse_version(text: str) -> dict[str, str]:
    """``show version`` -> running revision and which flash image booted."""
    version = _SW_VERSION_RE.search(text)
    fallback = None
    if not version:
        # Some trains only say "... revision W.15.14.0012, ROM ..." in prose.
        fallback = re.search(r"revision\s*:?\s+(?P<v>[A-Z]{1,3}\.\d[\w.]*)", text, re.I)
    date = _BUILD_DATE_RE.search(text)
    boot = re.search(r"Boot\s*Image\s*:\s*([A-Za-z]+)", text, re.I)
    return {
        "version": (version or fallback).group("v") if (version or fallback) else "",
        "build_date": date.group("d") if date else "",
        "boot_image": boot.group(1).lower() if boot else "",
    }


#: `I 08/17/26 12:34:56 00076 ports: port 1 is now on-line` -- older trains
#: omit the five digit event code.
_EVENT_RE = re.compile(
    r"^\s*(?P<sev>[A-Z])\s+"
    r"(?P<date>\d{2}/\d{2}/\d{2,4})\s+"
    r"(?P<time>\d{2}:\d{2}:\d{2})\s+"
    r"(?:(?P<code>\d{3,6}):?\s+)?"
    r"(?P<module>[A-Za-z][\w.\-/]*)\s*:\s?"
    r"(?P<msg>.*)$"
)

_EVENT_SEVERITIES = {"M": "major", "W": "warning", "I": "info", "D": "debug"}


def parse_event_log(text: str) -> list[dict[str, str]]:
    """``show logging`` -> one entry per event.

    Wrapped continuation lines are folded into the entry above; the listing
    banner and the ``---- Bottom of Log ----`` footer never match and drop out.
    """
    entries: list[dict[str, str]] = []
    for raw in text.split("\n"):
        line = raw.rstrip()
        if not line.strip():
            continue
        m = _EVENT_RE.match(line)
        if m:
            sev = m.group("sev").upper()
            entries.append(
                {
                    "severity": sev,
                    "severity_name": _EVENT_SEVERITIES.get(sev, sev.lower()),
                    "date": m.group("date"),
                    "time": m.group("time"),
                    "code": m.group("code") or "",
                    "module": m.group("module"),
                    "message": m.group("msg").strip(),
                }
            )
        elif entries and line.startswith(" ") and "----" not in line:
            entries[-1]["message"] += " " + line.strip()
    return entries


def parse_modules(text: str) -> list[dict[str, str]]:
    """``show modules``."""
    out: list[dict[str, str]] = []
    for table in parse_all_tables(text):
        for row in table:
            slot = _get(row, "Slot", "Module")
            if not slot:
                continue
            out.append(
                {
                    "slot": slot,
                    "description": _get(row, "Module Description", "Description"),
                    "serial": _get(row, "Serial Number", "Serial"),
                    "status": _get(row, "Status"),
                }
            )
    return out


def parse_port_counters(text: str) -> dict[str, str]:
    """``show interfaces <port>`` -- counters live in the KV preamble."""
    return parse_kv(text)


def parse_structured(text: str) -> dict[str, Any]:
    """Generic ``show`` output -> key/value pairs plus every table, in order.

    The structure behind every command without a dedicated parser: the UI
    renders the pairs as a definition list and each table as a filterable
    table, instead of dumping console text at the user.
    """
    tables: list[dict[str, Any]] = []
    total = len(text.split("\n"))
    idx = 0
    while idx < total:
        rows, headers, next_idx = parse_table(text, idx)
        # Skip empty tables ("no entries") instead of stopping -- populated
        # tables legitimately follow them.
        if rows:
            tables.append({"headers": headers, "rows": rows})
        if next_idx <= idx:
            break
        idx = next_idx
    return {"kv": parse_kv(text), "tables": tables}


_CPU_RE = re.compile(r"(\d+)\s*(?:percent|%)", re.I)
#: Label style: "CPU Util (%) : 25" / "Total CPU Utilization (%) : 6".
_CPU_LABEL_RE = re.compile(r"(?:cpu|utili[sz]ation)[^:\n]*:\s*(\d+)", re.I)


def parse_cpu(text: str) -> str:
    """``show cpu`` -> utilisation as a bare number string ("4")."""
    m = _CPU_RE.search(text) or _CPU_LABEL_RE.search(text)
    return m.group(1) if m else ""


#: Line-scoped and with a bounded gap on purpose: a multi-line regex with
#: open-ended whitespace eaters invited catastrophic backtracking on padded
#: output.  The gap covers " Bytes : " and friends.
_MEM_TOTAL_RE = re.compile(r"\bTotal[^\d\n]{0,24}([\d,]+)", re.I)
_MEM_FREE_RE = re.compile(r"\bFree[^\d\n]{0,24}([\d,]+)", re.I)


def parse_memory(text: str) -> dict[str, str]:
    """``show memory`` -> total/free bytes of *system* memory.

    Total and Free must come from the same block -- pairing them independently
    would marry a params-block Total to a system-block Free.  The system block
    always comes last, so the last complete pair wins.  Some trains print a
    columnar layout instead ("Total Bytes  Free Bytes  Lowest Free"); that is
    the fallback.
    """
    total = free = ""
    block_total = ""
    for line in text.split("\n"):
        m = _MEM_TOTAL_RE.search(line)
        if m:
            block_total = m.group(1)
        m = _MEM_FREE_RE.search(line)
        if m and block_total:
            total, free = block_total, m.group(1)
            block_total = ""
    if not total:
        for row in find_table(text, "Total", "Free"):
            t = _get(row, "Total Bytes", "Total")
            f = _get(row, "Free Bytes", "Free")
            if t and f:
                total, free = t, f
    return {"total": total.replace(",", ""), "free": free.replace(",", "")}


def parse_uptime(text: str) -> int | None:
    """``show uptime`` -> seconds.

    Two formats exist: ``4:07:33:16`` (days:hours:minutes:seconds) and the
    wordy ``44 days, 2 hours, 51 minutes``.
    """
    m = re.search(r"\b(\d+):(\d{1,2}):(\d{1,2}):(\d{1,2})\b", text)
    if m:
        days, hours, minutes, seconds = (int(g) for g in m.groups())
        return days * 86400 + hours * 3600 + minutes * 60 + seconds
    total = 0
    found = False
    for pattern, factor in (
        (r"(\d+)\s*days?", 86400),
        (r"(\d+)\s*hours?", 3600),
        (r"(\d+)\s*min", 60),
        (r"(\d+)\s*sec", 1),
    ):
        m = re.search(pattern, text, re.I)
        if m:
            total += int(m.group(1)) * factor
            found = True
    return total if found else None


def find_table(text: str, *required: str) -> list[dict[str, str]]:
    """The first table whose headers contain all of *required* (fuzzy match)."""
    idx = 0
    total = len(text.split("\n"))
    while idx < total:
        rows, headers, idx = parse_table(text, idx)
        if not headers:
            break
        flat = " ".join(headers).lower().replace(" ", "")
        if all(name.lower().replace(" ", "") in flat for name in required):
            return rows
        if not rows and idx >= total:
            break
    return []


def parse_snmp_communities(text: str) -> list[dict[str, str]]:
    """``show snmp-server`` -> the community table only."""
    out: list[dict[str, str]] = []
    for row in find_table(text, "Community"):
        name = _get(row, "Community Name", "Community")
        if not name:
            continue
        out.append(
            {
                "name": name,
                "mib_view": _get(row, "MIB View"),
                "write_access": _get(row, "Write Access", "Write"),
            }
        )
    return out


#: Trap categories are printed as `Label : Status` under a separator drawn with
#: underscores -- not the usual dashes, so the table parser never sees them.
_TRAP_CAT_RE = re.compile(r"^\s{2,}(?P<name>[A-Za-z][\w .\-/]*?)\s*:\s*(?P<status>\S[^\n]*?)\s*$")


def parse_snmp_server(text: str) -> dict[str, Any]:
    """``show snmp-server`` in full: communities, trap targets, trap categories."""
    receivers = []
    for row in find_table(text, "Address", "Community"):
        address = _get(row, "Address")
        if not address:
            continue
        receivers.append(
            {
                "address": address,
                "community": _get(row, "Community"),
                "events": _get(row, "Events"),
                "type": _get(row, "Type"),
                "retry": _get(row, "Retry"),
                "timeout": _get(row, "Timeout"),
            }
        )

    categories: list[dict[str, str]] = []
    lines = text.split("\n")
    start = next(
        (i for i, line in enumerate(lines) if "traps category" in line.lower()), None
    )
    if start is not None:
        for line in lines[start + 1 :]:
            # The next top-level section ends the block. Detected by indent, not
            # by name: matching on words like "Snmp" would fire on the category
            # line "SNMP Authentication : Extended" itself. Section headers sit
            # at one space, content at two or more.
            if line.strip() and not line.startswith("  "):
                break
            match = _TRAP_CAT_RE.match(line)
            if match:
                categories.append(
                    {"name": match.group("name").strip(), "status": match.group("status").strip()}
                )

    link_change = ""
    match = re.search(r"Link-Change Traps[^:\n]*:\s*(\S[^\n]*)", text, re.I)
    if match:
        link_change = match.group(1).strip()

    return {
        "communities": parse_snmp_communities(text),
        "receivers": receivers,
        "categories": categories,
        "link_change_ports": link_change,
    }


def parse_cdp_neighbors(text: str) -> list[dict[str, str]]:
    """``show cdp neighbors``."""
    out: list[dict[str, str]] = []
    for row in find_table(text, "Port"):
        port = _get(row, "Port", "Local Port")
        device = _get(row, "Device ID", "DeviceId", "Device")
        if not port or not device:
            continue
        out.append(
            {
                "port": port,
                "device_id": device,
                "platform": _get(row, "Platform"),
                "capability": _get(row, "Capability", "Capabilities"),
                "address": _get(row, "Address"),
            }
        )
    return out


def parse_lldp_detail(text: str) -> dict[str, str]:
    """``show lldp info remote-device <port>`` -> the detail block as key/value.

    ProVision has no ``detail`` keyword on this command; the long form is
    reached by naming a port, which is why this is parsed per port.
    """
    fields = parse_kv(text)
    # Drop the banner line ("Information detail for port 5") -- it is a heading,
    # not a property of the neighbour.
    return {k: v for k, v in fields.items() if v and not k.lower().startswith("information")}


def parse_config_text(text: str) -> list[str]:
    """Normalise ``show running-config`` into clean lines.

    Strips the ``Running configuration:`` banner and any stray prompt echo so
    the result can be diffed against the startup config.
    """
    lines = []
    started = False
    for raw in text.split("\n"):
        line = raw.rstrip()
        if not started:
            if line.strip().lower().startswith(("running configuration", "startup configuration")):
                started = True
                continue
            if line.strip().startswith(";"):  # version banner, e.g. "; J9145A ..."
                started = True
            elif not line.strip():
                continue
            else:
                started = True
        if PROMPT_ECHO_RE.match(line):
            continue
        lines.append(line)
    # The banner line is followed by a blank one; trim padding at both ends so
    # two dumps of the same config compare equal.
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


PROMPT_ECHO_RE = re.compile(r"^[A-Za-z0-9][\w.\-]*(\([^)]*\))?[#>]\s*$")


def diff_config(running: Iterable[str], startup: Iterable[str]) -> list[dict[str, str]]:
    """A line-oriented diff between running and startup config.

    Uses difflib so moved blocks show up as a move rather than a full rewrite.
    """
    import difflib

    a = [ln.rstrip() for ln in startup]
    b = [ln.rstrip() for ln in running]
    out: list[dict[str, str]] = []
    for line in difflib.unified_diff(a, b, "startup-config", "running-config", lineterm="", n=3):
        if line.startswith("+++") or line.startswith("---"):
            kind = "meta"
        elif line.startswith("@@"):
            kind = "hunk"
        elif line.startswith("+"):
            kind = "add"
        elif line.startswith("-"):
            kind = "del"
        else:
            kind = "ctx"
        out.append({"kind": kind, "text": line})
    return out
