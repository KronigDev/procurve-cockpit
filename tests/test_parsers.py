"""Parser tests against representative ProVision K/W.15.x output.

Run with plain Python (``python tests/test_parsers.py``) or under pytest --
there is no pytest-only syntax in here on purpose, because the point of these
tests is that they run anywhere the app runs.

The samples reproduce the real column layouts, including the quirks the parsers
exist to survive: two-column key/value lines, duplicated column headers, and
tables that start after a free-text preamble.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import parsers as P  # noqa: E402
from backend import plan  # noqa: E402
from backend.device import ProCurveDevice  # noqa: E402
from backend.transport import (  # noqa: E402
    CONFIRM_RE,
    ProCurveShell,
    TransportError,
    clean,
    detect_error,
    render_overwrites,
)

# --------------------------------------------------------------------------
# samples
# --------------------------------------------------------------------------

INTERFACES_BRIEF = """
 Status and Counters - Port Status

                          | Intrusion                           MDI   Flow  Bcast
  Port         Type       | Alert     Enabled Status Mode       Mode  Ctrl  Limit
  ------------ ---------- + --------- ------- ------ ---------- ----- ----- -----
  1            100/1000T  | No        Yes     Up     1000FDx    MDIX  off   0
  2            100/1000T  | No        Yes     Down   1000FDx    Auto  off   0
  3            100/1000T  | No        No      Down   1000FDx    Auto  off   0
  21           100/1000T  | No        Yes     Up     1000FDx    MDI   on    5
  A1           SFP+SR     | No        Yes     Up     10GigFD    NA    off   0
"""

INTERFACES_CONFIG = """
 Port Settings

  Port  Type      | Enabled Mode         Flow Ctrl MDI
  ----- --------- + ------- ------------ --------- ----
  1     100/1000T | Yes     Auto          Disable   Auto
  2     100/1000T | Yes     Auto-10       Disable   MDIX
  3     100/1000T | No      1000FDx       Enable    MDI
  21    100/1000T | Yes     100FDx        Disable   Auto
"""

LLDP_CONFIG = """
 LLDP Port Configuration

  Port  | AdminStatus  NotificationEnabled  Med Topology Trap Enabled
  ----- + ------------ -------------------- --------------------------
  1     | Tx_Rx        False                False
  2     | TxOnly       False                False
  3     | Disable      False                False
"""

STP_CONFIG = """
 Spanning Tree Port Configuration

  Port  Type      | Cost      Priority Admin Edge Port  BPDU Protection
  ----- --------- + --------- -------- ---------------- ---------------
  1     100/1000T | Auto      128      Yes              No
  2     100/1000T | 20000     128      No               Yes
"""

VLANS = """
 Status and Counters - VLAN Information

  Maximum VLANs to support : 256
  Primary VLAN : DEFAULT_VLAN
  Management VLAN : Mgmt

  VLAN ID Name                             | Status     Voice Jumbo
  ------- -------------------------------- + ---------- ----- -----
  1       DEFAULT_VLAN                     | Port-based No    No
  10      Servers                          | Port-based No    Yes
  99      Mgmt                             | Port-based No    No
"""

VLAN_DETAIL = """
 Status and Counters - VLAN Information - VLAN 10

  VLAN ID : 10
  Name : Servers
  Status : Port-based
  Voice : No
  Jumbo : Yes

  Port Information Mode     Unknown VLAN Status
  ---------------- -------- ------------ ----------
  1                Untagged Learn        Up
  2                Untagged Learn        Down
  24               Tagged   Learn        Up
"""

SYSTEM_INFO = """
 Status and Counters - General System Information

  System Name        : SW-KELLER
  System Contact     : noc@example.net
  System Location    : Rack 4 / HE 12

  MAC Age Time (sec) : 300

  Time Zone          : 60
  Daylight Time Rule : Western-Europe

  Software revision  : W.15.18.0015      Base MAC Addr      : 1cc1de-a1b2c3
  ROM Version        : W.14.03           Serial Number      : SG12ABCDEF

  Up Time            : 41 days           Memory   - Total   : 152,033,024
  CPU Util (%)       : 7                            Free    : 92,881,168

  IP Mgmt  - Pkts Rx : 12045             Packet   - Total   : 6750
             Pkts Tx : 9832              Buffers    Free    : 5221
"""

TRUNKS = """
 Trunk Configuration

  Port | Name                     Type      | Group Type
  ---- + ------------------------ --------- + ----- -----
  23   |                          100/1000T | Trk1  LACP
  24   |                          100/1000T | Trk1  LACP
"""

LLDP = """
 LLDP Remote Devices Information

  LocalPort | ChassisId                 PortId PortDescr SysName
  --------- + ------------------------- ------ --------- --------------------
  1         | 00 11 22 33 44 55         24     24        core-sw01
  21        | aa bb cc dd ee ff         3      Gi0/3     ap-flur
"""

MAC_TABLE = """
 Status and Counters - Port Address Table

  MAC Address   Located on Port
  ------------- ---------------
  001122-334455 1
  aabbcc-ddeeff 21
"""

ARP = """
 IP ARP table

  IP Address      MAC Address       Type    Port
  --------------- ----------------- ------- ----
  192.168.1.1     001122-334455     dynamic 1
  192.168.1.50    aabbcc-ddeeff     dynamic 21
"""

IP_CONFIG = """
 Internet (IP) Service

  IP Routing : Disabled

  Default Gateway : 192.168.1.1
  Default TTL     : 64
  Arp Age         : 20

  VLAN                             | IP Config  IP Address      Subnet Mask
  -------------------------------- + ---------- --------------- ---------------
  DEFAULT_VLAN                     | Manual     192.168.1.10    255.255.255.0
  Mgmt                             | DHCP/Bootp
"""

POE_BRIEF = """
 Status and Counters - Port Power Status

  Port   Power     Pre-std   Alloc   Alloc    Actual   Configured  Detection
         Enable    Detect    By      Power    Power    Type        Status
  ------ --------- --------- ------- -------- -------- ----------- ------------
  1      Yes       Off       usage   17 W     3.9 W                Delivering
  2      Yes       Off       usage   17 W     0 W                  Searching
  3      No        Off       usage   0 W      0 W                  Disabled
"""

# Verbatim from a 2910al. The community table is followed by further sections
# whose lines are indented too -- the table parser used to keep going and slice
# "Trap Receivers", "Traps Category" and every trap line into its columns.
SNMP_SERVER = """
SNMP Communities

  Community Name                   MIB View Write Access
  -------------------------------- -------- ------------
  public                           Manager  Unrestricted

 Trap Receivers

  Link-Change Traps Enabled on Ports [All] : All

  Traps Category                  Current Status
  _____________________________   __________________
  SNMP Authentication           : Extended
  Password change               : Enabled
  Login failures                : Enabled
  Port-Security                 : Enabled
  Authorization Server Contact  : Enabled
  DHCP-Snooping                 : Enabled
  Dynamic ARP Protection        : Enabled
  Dynamic IP Lockdown           : Enabled


  MAC address table changes     : Disabled
  MAC Address Count             : Disabled

  Address                Community              Events   Type   Retry   Timeout
  ---------------------- ---------------------- -------- ------ ------- -------


 Excluded MIBs


 Snmp Response Pdu Source-IP Information

  Selection Policy   : rfc1517

 Trap Pdu Source-IP Information

  Selection Policy   : rfc1517
"""

CDP_NEIGHBORS = """
 CDP neighbors information

  Port   Device ID                      | Platform             Capability
  ------ ------------------------------ + -------------------- ----------
  1      SEP001122334455                | Cisco IP Phone 7962  H
  21     ap-flur                         | AIR-CAP2702I         T B
"""

LLDP_DETAIL = """
 LLDP Remote Device Information Detail

  Local Port   : 21
  ChassisType  : mac-address
  ChassisId    : aa bb cc dd ee ff
  PortType     : local
  PortId       : 3
  SysName      : ap-flur
  System Descr : Cisco AP Software
  PortDescr    : GigabitEthernet0/3

  System Capabilities Supported  : bridge, wlan-access-point
  System Capabilities Enabled    : bridge, wlan-access-point
"""

RUNNING_CONFIG = """
Running configuration:

; J9145A Configuration Editor; Created on release #W.15.18.0015

hostname "SW-KELLER"
snmp-server location "Rack 4"
vlan 1
   name "DEFAULT_VLAN"
   untagged 1-22
   ip address 192.168.1.10 255.255.255.0
   exit
vlan 10
   name "Servers"
   tagged 23-24
   exit
"""

# --------------------------------------------------------------------------
# tests
# --------------------------------------------------------------------------

CHECKS: list[tuple[str, callable]] = []


def check(name):
    def wrap(fn):
        CHECKS.append((name, fn))
        return fn
    return wrap


@check("show snmp-server stops at the end of the community table")
def _t_snmp():
    communities = P.parse_snmp_communities(SNMP_SERVER)
    assert len(communities) == 1, communities
    assert communities[0] == {
        "name": "public", "mib_view": "Manager", "write_access": "Unrestricted",
    }, communities[0]

    full = P.parse_snmp_server(SNMP_SERVER)
    assert full["link_change_ports"] == "All", full["link_change_ports"]
    assert full["receivers"] == [], full["receivers"]

    names = [c["name"] for c in full["categories"]]
    assert "SNMP Authentication" in names, names
    assert "Dynamic IP Lockdown" in names, names
    assert "MAC Address Count" in names, names
    status = {c["name"]: c["status"] for c in full["categories"]}
    assert status["SNMP Authentication"] == "Extended"
    assert status["MAC address table changes"] == "Disabled"
    # The sections after the trap categories must not leak in as categories.
    assert "Selection Policy" not in names, names


@check("a blank line ends a table")
def _t_table_stops_at_blank():
    rows, _h, _i = P.parse_table(SNMP_SERVER)
    assert len(rows) == 1, rows
    assert rows[0]["Community Name"] == "public"


@check("show cdp neighbors")
def _t_cdp():
    rows = P.parse_cdp_neighbors(CDP_NEIGHBORS)
    assert len(rows) == 2, rows
    assert rows[0]["device_id"] == "SEP001122334455"
    assert rows[0]["platform"] == "Cisco IP Phone 7962"
    assert rows[1]["port"] == "21"


@check("show lldp info remote-device <port>")
def _t_lldp_detail():
    fields = P.parse_lldp_detail(LLDP_DETAIL)
    assert fields.get("SysName") == "ap-flur", fields
    assert fields.get("PortId") == "3", fields
    assert fields.get("ChassisId") == "aa bb cc dd ee ff", fields


@check("echo stripping keeps output that shares the echo's line")
def _t_strip_echo():
    strip = ProCurveShell._strip_echo_and_prompt

    normal = "SW# show version\nImage stamp: /sw/code\n\nSW# "
    assert strip(normal, "show version") == "Image stamp: /sw/code"

    # Some status screens position the cursor instead of sending newlines, so
    # after escape stripping the echo and the first line of output share one
    # line. Dropping the whole line used to swallow the entire reply.
    fused = "SW# show system-information Status and Counters\n  System Name : SW\nSW# "
    assert strip(fused, "show system-information") == (
        "Status and Counters\n  System Name : SW"
    )

    # A command that genuinely says nothing must still come back empty.
    assert strip("SW# no page\nSW# ", "no page") == ""


@check("show interfaces config")
def _t_port_config():
    cfg = P.parse_port_config(INTERFACES_CONFIG)
    assert sorted(cfg) == ["1", "2", "21", "3"], cfg
    assert cfg["1"] == {
        "enabled": "Yes", "mode": "Auto", "flow_ctrl": "Disable", "mdi": "Auto",
    }, cfg["1"]
    # The configured mode differs from the negotiated one in `show interfaces
    # brief` -- that difference is the whole reason this command is fetched.
    assert cfg["2"]["mode"] == "Auto-10"
    assert cfg["3"]["flow_ctrl"] == "Enable"
    assert cfg["21"]["mdi"] == "Auto"


@check("show lldp config")
def _t_lldp_config():
    admin = P.parse_lldp_config(LLDP_CONFIG)
    assert admin == {"1": "tx_rx", "2": "tx_only", "3": "disable"}, admin


@check("show spanning-tree config")
def _t_stp_port_config():
    stp = P.parse_stp_port_config(STP_CONFIG)
    assert stp["1"]["admin_edge"] is True
    assert stp["1"]["bpdu_protection"] is False
    assert stp["1"]["path_cost"] == "Auto"
    assert stp["2"]["admin_edge"] is False
    assert stp["2"]["bpdu_protection"] is True
    assert stp["2"]["path_cost"] == "20000"
    # Root guard has no column on this firmware; absence must read as "off",
    # not blow up.
    assert stp["1"]["root_guard"] is False


@check("show interfaces brief")
def _t_ports():
    ports = P.parse_ports(INTERFACES_BRIEF)
    assert len(ports) == 5, ports
    first = ports[0]
    assert first["port"] == "1", first
    assert first["type"] == "100/1000T", first
    assert first["enabled"] is True
    assert first["up"] is True
    assert first["mode"] == "1000FDx", first
    assert first["mdi"] == "MDIX", first
    assert first["flow_control"] == "off", first
    assert first["intrusion"] == "No", first
    assert ports[2]["enabled"] is False, ports[2]
    assert ports[2]["up"] is False
    assert ports[3]["bcast_limit"] == "5", ports[3]
    assert ports[3]["flow_control"] == "on", ports[3]
    assert ports[4]["port"] == "A1", ports[4]


@check("show vlans")
def _t_vlans():
    vlans = P.parse_vlans(VLANS)
    assert [v["id"] for v in vlans] == [1, 10, 99], vlans
    assert vlans[1]["name"] == "Servers"
    assert vlans[1]["jumbo"] is True
    assert vlans[0]["jumbo"] is False
    assert vlans[0]["primary"] is True, vlans[0]
    assert vlans[2]["is_mgmt"] is True, vlans[2]


@check("show vlan <id>")
def _t_vlan_ports():
    rows = P.parse_vlan_ports(VLAN_DETAIL)
    assert len(rows) == 3, rows
    assert rows[0] == {"port": "1", "mode": "untagged", "unknown_vlan": "Learn", "status": "Up"}, rows[0]
    assert rows[2]["mode"] == "tagged", rows[2]


@check("show system-information")
def _t_system():
    info = P.parse_system_info(SYSTEM_INFO)
    assert info["name"] == "SW-KELLER", info
    assert info["contact"] == "noc@example.net", info
    assert info["location"] == "Rack 4 / HE 12", info
    assert info["software"] == "W.15.18.0015", info
    assert info["rom"] == "W.14.03", info
    assert info["serial"] == "SG12ABCDEF", info
    assert info["base_mac"] == "1cc1de-a1b2c3", info
    assert info["cpu"] == "7", info
    assert info["mem_total"] == "152,033,024", info
    assert info["mem_free"] == "92,881,168", info
    assert info["time_zone"] == "60", info
    assert info["mac_age"] == "300", info


@check("show trunks (duplicate 'Type' headers)")
def _t_trunks():
    rows = P.parse_trunks(TRUNKS)
    assert len(rows) == 2, rows
    assert rows[0]["port"] == "23", rows[0]
    assert rows[0]["group"] == "Trk1", rows[0]
    assert rows[0]["type"] == "LACP", rows[0]


@check("show lldp info remote-device")
def _t_lldp():
    rows = P.parse_lldp_neighbors(LLDP)
    assert len(rows) == 2, rows
    assert rows[0]["port"] == "1"
    assert rows[0]["system_name"] == "core-sw01", rows[0]
    assert rows[1]["port_id"] == "3", rows[1]


@check("show mac-address / show arp")
def _t_forwarding():
    macs = P.parse_mac_table(MAC_TABLE)
    assert len(macs) == 2, macs
    assert macs[0]["mac"] == "001122-334455"
    assert macs[0]["port"] == "1"
    arps = P.parse_arp(ARP)
    assert len(arps) == 2, arps
    assert arps[1]["ip"] == "192.168.1.50", arps[1]
    assert arps[1]["port"] == "21", arps[1]


@check("show ip")
def _t_ip():
    rows = P.parse_ip_config(IP_CONFIG)
    assert len(rows) == 2, rows
    assert rows[0]["vlan"] == "DEFAULT_VLAN", rows[0]
    assert rows[0]["ip"] == "192.168.1.10", rows[0]
    assert rows[0]["mask"] == "255.255.255.0", rows[0]
    assert rows[1]["config"] == "DHCP/Bootp", rows[1]


@check("show power-over-ethernet brief")
def _t_poe():
    rows = P.parse_poe(POE_BRIEF)
    assert len(rows) == 3, rows
    assert rows[0]["enabled"] is True, rows[0]
    assert rows[0]["actual"] == "3.9 W", rows[0]
    assert rows[0]["alloc_by"] == "usage", rows[0]
    assert rows[0]["status"] == "Delivering", rows[0]
    assert rows[2]["enabled"] is False, rows[2]


@check("show running-config")
def _t_config():
    lines = P.parse_config_text(RUNNING_CONFIG)
    assert lines[0].startswith("; J9145A"), lines[:3]
    assert 'hostname "SW-KELLER"' in lines
    assert "   untagged 1-22" in lines, lines
    diff = P.diff_config(lines, lines[:-3])
    assert any(d["kind"] == "add" for d in diff), diff


@check("terminal cleanup")
def _t_clean():
    # ANSI + the CR-erase ProCurve uses to wipe its "-- MORE --" prompt.
    dirty = "\x1b[2Jheader\r\n-- MORE --, next page: Space\r                              \rvalue\r\n"
    out = clean(dirty)
    assert "MORE" not in out, repr(out)
    assert "header" in out and "value" in out, repr(out)
    assert render_overwrites("abcdef\rXY") == "XYcdef"


@check("error detection")
def _t_errors():
    assert detect_error("Invalid input: vlan9999") is not None
    assert detect_error("       ^\nInvalid input: foo") is not None
    assert detect_error("VLAN 1 cannot be deleted.") is not None
    assert detect_error("The port is already untagged in VLAN 1.") is not None
    assert detect_error("Unable to create VLAN.") is not None
    assert detect_error("Module not present.") is None
    assert detect_error("") is None
    assert detect_error(" 1 up 1000FDx") is None
    # Normal event-log text must not be mistaken for a command failure.
    assert detect_error(
        "W 08/13/26 09:14:02 00435 ports: port 3 login failed for user admin"
    ) is None
    assert detect_error("  Total Failed Attempts : 3") is None


@check("port range collapsing")
def _t_portlist():
    assert plan.port_list(["1", "2", "3", "7", "8", "12"]) == "1-3,7-8,12"
    assert plan.port_list(["5"]) == "5"
    assert plan.port_list(["3", "1", "2", "A1"]) == "1-3,A1"
    assert plan.port_list("1,2,4") == "1-2,4"


@check("plan: port settings")
def _t_plan_ports():
    p = plan.build("port.settings", {"ports": ["1", "2"], "enabled": False, "name": "Uplink"})
    assert p.commands == ["interface 1-2", "disable", 'name "Uplink"', "exit"], p.commands
    assert any(r.level == "warn" for r in p.risks), p.risks


@check("plan: untagged VLAN move releases the old VLAN first")
def _t_plan_vlan_move():
    p = plan.build("port.vlans", {
        "ports": ["5", "6"],
        "untagged": 20,
        "current_untagged": {"5": 10, "6": 10},
    })
    assert p.commands == [
        "vlan 10", "no untagged 5-6", "exit",
        "vlan 20", "untagged 5-6", "exit",
    ], p.commands


@check("plan: validation rejects bad input")
def _t_plan_validation():
    for intent, payload in [
        ("vlan.create", {"id": 5000}),
        ("vlan.delete", {"id": 1}),
        ("port.settings", {"ports": []}),
        ("port.settings", {"ports": ["1"], "name": 'bad"quote'}),
        ("stp.global", {"priority": 99}),
        ("trunk.create", {"ports": ["1", "2"], "group": "lag1"}),
        ("vlan.update", {"id": 10, "ip": "192.168.1.1"}),  # no mask
    ]:
        try:
            plan.build(intent, payload)
        except plan.PlanError:
            continue
        raise AssertionError(f"{intent} {payload} should have been rejected")


@check("plan: CIDR normalisation")
def _t_cidr():
    assert plan.cidr("192.168.1.1", "255.255.255.0") == "192.168.1.1/24"
    assert plan.cidr("10.0.0.1/8") == "10.0.0.1/8"


@check("risk: lockout detection")
def _t_risk():
    risks = plan.analyze_risk(["no ip ssh"], {})
    assert any(r.level == "danger" for r in risks), risks

    ctx = {"management_vlan": 99, "management_ip": "192.168.1.10"}
    risks = plan.analyze_risk(["vlan 99", "ip address 10.0.0.1/24", "exit"], ctx)
    assert any("management VLAN 99" in r.message for r in risks), risks

    # A non-management VLAN must not raise the alarm.
    risks = plan.analyze_risk(["vlan 10", "ip address 10.0.0.1/24", "exit"], ctx)
    assert not any(r.level == "danger" for r in risks), risks


@check("plan: raw lines still get risk analysis")
def _t_plan_raw():
    p = plan.build("raw", {"lines": ["hostname \x27x\x27", "no ip ssh"]})
    assert any(r.level == "danger" for r in p.risks), p.risks


# --------------------------------------------------------------------------
# flash / version / event log
# --------------------------------------------------------------------------

FLASH_W15 = """
 Image             Size(Bytes)    Date   Version
 ----------------- -------------- ------ --------------
 Primary Image     :   10475866   03/09/16 W.15.14.0012
 Secondary Image   :   10352128   01/22/15 W.15.13.0009

 Boot Rom Version: W.14.04
 Default Boot    : Primary
"""

FLASH_K16 = """
Image           Size (bytes) Date     Version
--------------- ------------ -------- --------------
Primary Image   :  15987030  03/24/17 KB.16.03.0004
Secondary Image :  15987030  03/24/17 KB.16.03.0004
BootROM Version : KB.16.01.0006
Default Boot Image : Secondary
"""

VERSION_W15 = """
Image stamp:    /ws/swbuildm/rel_venice_qaoff/code/build/anm(swbuildm_rel_venice_qaoff_rel_venice)
                Mar  9 2016 14:35:37
                W.15.14.0012
                188
Boot Image:     Secondary
"""

EVENT_LOG = """
 Keys:   W=Warning   I=Information
         M=Major     D=Debug
---- Reverse event Log listing: Events Since Boot ----
W 08/17/26 09:15:02 00331 FFI: port 5-Excessive CRC/alignment errors
I 08/17/26 09:14:55 00076 ports: port 5 is now on-line
M 08/16/26 23:01:11 00061 system: System went down without saving
    crash data
I 08/16/26 22:59:40 ports: port 2 is now off-line
---- Bottom of Log : Events Listed = 4 ----
"""


FLASH_ERASED = """
 Image             Size(Bytes)    Date   Version
 ----------------- -------------- ------ --------------
 Primary Image     :   0
 Secondary Image   :   10475866   03/09/16 W.15.14.0012

 Boot Rom Version: W.14.04
 Default Boot    : Secondary
"""


@check("show flash with an erased image keeps both rows honest")
def _t_flash_erased():
    data = P.parse_flash(FLASH_ERASED)
    slots = {img["slot"]: img for img in data["images"]}
    # The blank date/version columns must not swallow the next line: the
    # erased image stays empty and the intact one keeps its own row.
    assert sorted(slots) == ["primary", "secondary"], slots
    assert slots["primary"] == {
        "slot": "primary", "size_bytes": 0, "date": "", "version": "",
    }, slots["primary"]
    assert slots["secondary"]["version"] == "W.15.14.0012", slots["secondary"]
    assert data["default_boot"] == "secondary", data


@check("show flash (W.15 and K.16 spellings)")
def _t_flash():
    data = P.parse_flash(FLASH_W15)
    assert data["default_boot"] == "primary", data
    assert data["boot_rom"] == "W.14.04", data
    slots = {img["slot"]: img for img in data["images"]}
    assert slots["primary"]["version"] == "W.15.14.0012", slots
    assert slots["primary"]["size_bytes"] == 10475866, slots
    assert slots["secondary"]["date"] == "01/22/15", slots

    data = P.parse_flash(FLASH_K16)
    assert data["default_boot"] == "secondary", data
    assert data["boot_rom"] == "KB.16.01.0006", data
    assert len(data["images"]) == 2, data


@check("show version")
def _t_version():
    data = P.parse_version(VERSION_W15)
    assert data["version"] == "W.15.14.0012", data
    assert data["boot_image"] == "secondary", data
    assert data["build_date"] == "Mar  9 2016 14:35:37", data
    # Factory-installed builds carry a lowercase suffix, printed verbatim.
    data = P.parse_version(VERSION_W15.replace("W.15.14.0012", "W.15.14.0012m"))
    assert data["version"] == "W.15.14.0012m", data


@check("show logging -> structured events")
def _t_event_log():
    events = P.parse_event_log(EVENT_LOG)
    assert len(events) == 4, [e["message"] for e in events]
    assert events[0]["severity"] == "W"
    assert events[0]["severity_name"] == "warning"
    assert events[0]["code"] == "00331"
    assert events[0]["module"] == "FFI"
    assert events[0]["message"].startswith("port 5-Excessive"), events[0]
    # The wrapped line folds into the entry above it.
    assert events[2]["message"] == "System went down without saving crash data", events[2]
    # Old trains have no event code column.
    assert events[3]["code"] == "" and events[3]["module"] == "ports", events[3]


@check("plan: firmware & boot intents")
def _t_plan_firmware():
    p = plan.build("firmware.boot", {"image": "secondary"})
    assert p.commands == ["boot system flash secondary"], p.commands
    assert p.exec_level and any(r.level == "danger" for r in p.risks), p.risks

    p = plan.build("firmware.default_boot", {"image": "primary"})
    assert p.commands == ["boot set-default flash primary"], p.commands
    assert not any(r.level == "danger" for r in p.risks), p.risks

    p = plan.build("firmware.copy", {"to": "secondary"})
    assert p.commands == ["copy flash flash secondary"], p.commands

    p = plan.build("firmware.erase", {"image": "secondary"})
    assert any(r.level == "danger" for r in p.risks), p.risks

    p = plan.build("firmware.download", {
        "server": "192.168.1.50", "filename": "W_15_14_0012.swi", "image": "secondary",
    })
    assert p.commands == ["copy tftp flash 192.168.1.50 W_15_14_0012.swi secondary"], p.commands

    for bad in (
        {"image": "tertiary"},
        {},
    ):
        try:
            plan.build("firmware.boot", bad)
        except plan.PlanError:
            pass
        else:
            raise AssertionError(f"accepted {bad}")

    try:
        plan.build("firmware.download", {"server": "10.0.0.1", "filename": "a b.swi", "image": "primary"})
    except plan.PlanError:
        pass
    else:
        raise AssertionError("accepted a file name with a space")


@check("plan: reload modes")
def _t_plan_reload():
    p = plan.build("firmware.reload", {"mode": "now"})
    assert p.commands == ["reload"] and p.exec_level
    assert any(r.level == "danger" for r in p.risks), p.risks

    p = plan.build("firmware.reload", {"mode": "after", "minutes": 90})
    assert p.commands == ["reload after 01:30"], p.commands

    p = plan.build("firmware.reload", {"mode": "after", "minutes": 2 * 1440 + 65})
    assert p.commands == ["reload after 02:01:05"], p.commands

    p = plan.build("firmware.reload", {"mode": "at", "time": "23:15", "date": "08/18/26"})
    assert p.commands == ["reload at 23:15 08/18/26"], p.commands

    # Cancelling a scheduled reboot must not demand the danger confirmation.
    p = plan.build("firmware.reload", {"mode": "cancel"})
    assert p.commands == ["reload cancel"], p.commands
    assert not any(r.level == "danger" for r in p.risks), p.risks

    # Value ranges, not just shapes: 99:99 / month 13 / 3-digit years and
    # non-ASCII digits must all fail at plan time, not on the switch.
    for bad in (
        {"mode": "at", "time": "25 Uhr"},
        {"mode": "at", "time": "99:99"},
        {"mode": "at", "time": "23:15", "date": "13/05"},
        {"mode": "at", "time": "23:15", "date": "08/17/126"},
        {"mode": "at", "time": "٢٣:١٥"},
    ):
        try:
            plan.build("firmware.reload", bad)
        except plan.PlanError:
            pass
        else:
            raise AssertionError(f"accepted {bad}")

    try:
        plan.build("firmware.download", {
            "server": "сервер", "filename": "img.swi", "image": "primary",
        })
    except plan.PlanError:
        pass
    else:
        raise AssertionError("accepted a non-ASCII TFTP server")


PORT_SECURITY = """
 Port Security

  Port  Learn Mode  | Action                 Eavesdrop Prevention
  ----- ----------- + ---------------------- --------------------
  1     Static      | Send Alarm, Disable    Disabled
  2     Continuous  | None                   Disabled
  3     Continuous  | None                   Disabled
"""

SHOW_CPU = """
 4 percent busy, from 300 sec average
 1 percent busy, from 5 sec average
"""

SHOW_MEMORY = """
 Status and Counters - System Memory Information

  Params memory usage
   Total     :     1,048,576
   Free      :       524,288

  System memory usage
   Total     :   118,464,512
   Free      :    86,970,368
"""


@check("generic structured parser: kv + filterable tables")
def _t_structured():
    data = P.parse_structured(PORT_SECURITY)
    assert len(data["tables"]) == 1, data
    t = data["tables"][0]
    assert t["headers"][0] == "Port", t["headers"]
    assert len(t["rows"]) == 3, t["rows"]
    assert t["rows"][0]["Learn Mode"] == "Static", t["rows"][0]
    assert "Send Alarm" in t["rows"][0]["Action"], t["rows"][0]

    # KV-only output has no tables but keeps the pairs.
    data = P.parse_structured(" Telnet-Server: Enabled\n Telnet Sessions : 2\n")
    assert not data["tables"], data
    assert data["kv"]["Telnet-Server"] == "Enabled", data

    # An empty table ("no entries") must not hide the populated one below it.
    stacked = (
        " Port Access Status\n\n"
        "  Port  Status\n"
        "  ----- ------\n"
        "\n"
        " 802.1X Configuration\n\n"
        "  Port  Auth\n"
        "  ----- ------\n"
        "  1     Yes\n"
    )
    data = P.parse_structured(stacked)
    assert len(data["tables"]) == 1, data["tables"]
    assert data["tables"][0]["rows"][0]["Auth"] == "Yes", data["tables"]

    # A single full-width dash run is a divider between record blocks, not a
    # column separator -- it must not spawn a one-column garbage table.
    divided = (
        " Telnet Activity\n\n"
        "  --------------------------------------------------------\n"
        "  Session : ** 1\n  Privilege: Manager\n  From : Console\n"
        "  --------------------------------------------------------\n"
        "  Session :    2\n  Privilege: Operator\n  From : 10.0.0.5\n"
    )
    data = P.parse_structured(divided)
    assert data["tables"] == [], data["tables"]
    assert data["kv"].get("Privilege") == "Manager", data["kv"]


@check("stacked label-over-value output (show sntp on W.15)")
def _t_stacked_kv():
    text = (
        "SNTP Authentication\n"
        "    Disabled\n"
        "Time Sync Mode\n"
        "    Timep\n"
        "SNTP Mode\n"
        "    disabled\n"
        "Poll Interval (sec)\n"
        "    720\n"
        "Source IP Selection\n"
        "    Outgoing Interface\n"
    )
    data = P.parse_structured(text)
    assert data["kv"]["Time Sync Mode"] == "Timep", data["kv"]
    assert data["kv"]["SNTP Mode"] == "disabled", data["kv"]
    assert data["kv"]["Poll Interval (sec)"] == "720", data["kv"]
    # Colon output must never fall through to the stacked parser.
    normal = P.parse_structured(" Telnet-Server: Enabled\n Telnet Sessions : 2\n")
    assert normal["kv"]["Telnet-Server"] == "Enabled", normal["kv"]


@check("plan: console & front-panel settings")
def _t_plan_console_fp():
    p = plan.build("console.set", {"baud_rate": "115200", "flow_control": "none", "inactivity_timer": 10})
    assert p.commands == [
        "console baud-rate 115200", "console flow-control none", "console inactivity-timer 10",
    ], p.commands

    p = plan.build("front_panel.set", {"password_recovery": False})
    assert p.commands == ["no front-panel-security password-recovery"], p.commands
    assert any(r.level == "danger" for r in p.risks), p.risks
    p = plan.build("front_panel.set", {"password_clear": True})
    assert p.commands == ["front-panel-security password-clear"], p.commands
    assert not any(r.level == "danger" for r in p.risks), p.risks

    for bad in (
        {"baud_rate": "300"},
        {"flow_control": "rts-cts"},
        {"inactivity_timer": 999},
        {},
    ):
        try:
            plan.build("console.set", bad)
        except plan.PlanError:
            pass
        else:
            raise AssertionError(f"accepted {bad}")


@check("plan: security guard rails (snooping, ARP protect, 802.1X, AAA, filters)")
def _t_plan_guards():
    p = plan.build("dhcp_snooping.set", {"enabled": True, "vlans_add": [20], "trust_ports": ["1", "2"]})
    assert p.commands == ["dhcp-snooping", "dhcp-snooping vlan 20", "dhcp-snooping trust 1-2"], p.commands

    p = plan.build("arp_protect.set", {"vlans_remove": [30], "untrust_ports": ["5"]})
    assert p.commands == ["no arp-protect vlan 30", "no arp-protect trust 5"], p.commands

    p = plan.build("dot1x.set", {"active": True})
    assert p.commands == ["aaa port-access authenticator active"], p.commands
    assert any(r.level == "danger" for r in p.risks), p.risks

    p = plan.build("aaa.server", {"protocol": "radius", "host": "10.0.0.30", "key": "s3cret"})
    assert p.commands == ['radius-server host 10.0.0.30 key "s3cret"'], p.commands
    p = plan.build("aaa.server", {"protocol": "tacacs", "host": "10.0.0.31", "remove": True})
    assert p.commands == ["no tacacs-server host 10.0.0.31"], p.commands

    p = plan.build("aaa.login", {"access": "ssh", "stage": "login", "primary": "radius", "secondary": "local"})
    assert p.commands == ["aaa authentication ssh login radius local"], p.commands
    assert any(r.level == "danger" for r in p.risks), p.risks

    p = plan.build("filter.set", {"source_port": "7", "drop_ports": "1-4"})
    assert p.commands == ["filter source-port 7 drop 1-4"], p.commands
    p = plan.build("filter.set", {"source_port": "7", "remove": True})
    assert p.commands == ["no filter source-port 7"], p.commands

    p = plan.build("system.set", {"timep_mode": "manual", "timep_server": "10.0.0.5", "sntp_auth": False})
    assert p.commands == ["no sntp authentication", "ip timep manual 10.0.0.5"], p.commands

    p = plan.build("vlan.update", {"id": 10, "ipv6": True})
    assert p.commands == ["vlan 10", "ipv6 enable", "exit"], p.commands

    for intent, bad in (
        ("aaa.login", {"access": "carrier-pigeon", "stage": "login", "primary": "local"}),
        ("aaa.server", {"protocol": "radius", "host": "bad host"}),
        ("dot1x.set", {"ports": ["1"]}),
        ("filter.set", {"source_port": "7"}),
        ("system.set", {"timep_mode": "manual"}),
    ):
        try:
            plan.build(intent, bad)
        except plan.PlanError:
            pass
        else:
            raise AssertionError(f"accepted {intent} {bad}")


@check("kv parser keeps 'Label [default] : value' lines")
def _t_kv_defaults():
    kv = P.parse_kv(" STP Enabled [No] : Yes\n Force Version [MSTP-operation] : MSTP-operation\n")
    assert kv == {"STP Enabled": "Yes", "Force Version": "MSTP-operation"}, kv
    # Two bracketed pairs sharing one line (the port-security layout).
    kv = P.parse_kv("  Learn Mode [Continuous] : Static       Address Limit [1] : 4\n")
    assert kv == {"Learn Mode": "Static", "Address Limit": "4"}, kv


@check("show cpu / show memory as resource fallbacks")
def _t_resources():
    assert P.parse_cpu(SHOW_CPU) == "4"
    assert P.parse_cpu("CPU utilization: 17 %") == "17"
    assert P.parse_cpu("Total CPU Utilization (%) : 6") == "6"
    assert P.parse_cpu("no numbers here") == ""

    mem = P.parse_memory(SHOW_MEMORY)
    # The system block, not the params block above it.
    assert mem == {"total": "118464512", "free": "86970368"}, mem
    assert P.parse_memory("Total : 1,000\nFree : 400")["total"] == "1000"
    # A trailing Total-only block must not steal the pairing.
    mem = P.parse_memory(SHOW_MEMORY + "\n  Packet buffers\n   Total : 2,000\n")
    assert mem == {"total": "118464512", "free": "86970368"}, mem
    # K-train label style.
    mem = P.parse_memory(" Total Bytes : 190,102,272\n Free Bytes : 121,867,776\n Lowest Free : 121,241,600\n")
    assert mem == {"total": "190102272", "free": "121867776"}, mem
    # Columnar layout (headers over a dash-separated table).
    mem = P.parse_memory(
        " Status and Counters - System Memory Information\n\n"
        "  Total Bytes   Free Bytes   Lowest Free\n"
        "  ------------- ------------ ------------\n"
        "  118,464,512   86,970,368   82,970,368\n"
    )
    assert mem == {"total": "118464512", "free": "86970368"}, mem


#: Verbatim from an HP 2910al-24G on W.15.14.0018.
SHOW_SYSTEM_W15 = """
 Status and Counters - General System Information

  System Name        : HP-2910al-24G
  System Contact     : BR Rennen
  System Location    : BKR Rack - Testumgebung

  MAC Age Time (sec) : 300

  Time Zone          : 0
  Daylight Time Rule : None

  Software revision  : W.15.14.0018         Base MAC Addr      : 0026f1-427f80
  ROM Version        : W.14.06              Serial Number      : SG024IP0LM

  Up Time            : 5 days               Memory   - Total   : 100,663,296
  CPU Util (%)       : 0                               Free    : 68,814,132

  IP Mgmt  - Pkts Rx : 28,146               Packet   - Total   : 6750
             Pkts Tx : 26,289               Buffers    Free    : 5093
                                                       Lowest  : 5054
                                                       Missed  : 0
"""

SHOW_CPU_W15 = """
0 percent busy, from 300 sec ago
1 sec ave: 1 percent busy
5 sec ave: 1 percent busy
1 min ave: 1 percent busy
"""


@check("show system on a real 2910al (W.15.14.0018)")
def _t_show_system_w15():
    info = P.parse_system_info(SHOW_SYSTEM_W15)
    assert info["name"] == "HP-2910al-24G", info
    assert info["serial"] == "SG024IP0LM", info
    assert info["software"] == "W.15.14.0018", info
    assert info["cpu"] == "0", info
    assert info["mem_total"] == "100,663,296", info
    assert info["mem_free"] == "68,814,132", info
    assert info["uptime"].startswith("5 days"), info


@check("show cpu prefers the short averages over the since-boot line")
def _t_cpu_w15():
    # The leading "0 percent busy, from 300 sec ago" is not the current load.
    assert P.parse_cpu(SHOW_CPU_W15) == "1", P.parse_cpu(SHOW_CPU_W15)


@check("show uptime in both formats")
def _t_uptime():
    assert P.parse_uptime("  4:07:33:16  ") == 4 * 86400 + 7 * 3600 + 33 * 60 + 16
    # Verbatim W.15 output: dddd:hh:mm:ss with fractional seconds.
    assert P.parse_uptime("0005:04:01:18.68") == 5 * 86400 + 4 * 3600 + 60 + 18
    assert P.parse_uptime(" 44 days, 2 hours, 51 minutes ") == 44 * 86400 + 2 * 3600 + 51 * 60
    assert P.parse_uptime("no uptime here") is None


@check("plan: SNTP / timesync settings")
def _t_plan_sntp():
    p = plan.build("system.set", {"time_sync": "sntp", "sntp_mode": "unicast", "sntp_poll": 120})
    assert p.commands == ["timesync sntp", "sntp unicast", "sntp poll-interval 120"], p.commands

    p = plan.build("system.set", {"time_sync": "none", "sntp_mode": "disabled"})
    assert p.commands == ["no timesync", "no sntp"], p.commands

    for bad in (
        {"time_sync": "ntpd"},
        {"sntp_mode": "anycast"},
        {"sntp_poll": 10},
        {"sntp_poll": 9999},
    ):
        try:
            plan.build("system.set", bad)
        except plan.PlanError:
            pass
        else:
            raise AssertionError(f"accepted {bad}")


class FakeChannel:
    """Scripted ByteChannel: each sent line advances to the next canned reply."""

    def __init__(self, script):
        #: list of (reply | TransportError) delivered one per sent line.
        self.script = list(script)
        self.sent = []
        self.pending = b""

    def send_bytes(self, data):
        self.sent.append(data.decode())
        if self.script:
            self.pending = self.script.pop(0)

    def recv_bytes(self, size, timeout):
        if isinstance(self.pending, Exception):
            exc = self.pending
            self.pending = b""
            raise exc
        data = self.pending if isinstance(self.pending, bytes) else self.pending.encode()
        self.pending = b""
        return data

    def close(self):
        pass


@check("reboot dialogue: save question answered per intent, EOF means rebooting")
def _t_reboot_dialogue():
    assert CONFIRM_RE.search("Do you want to save current configuration [y/n/^C]? ")

    chan = FakeChannel([
        "reload\nDevice will be rebooted, do you want to continue [y/n]? ",
        "y\nDo you want to save current configuration [y/n/^C]? ",
        TransportError("SSH connection closed by switch"),
    ])
    device = ProCurveDevice(ProCurveShell(chan), "test")
    from backend.transport import SAVE_CONFIRM_RE
    result = device._run_reboot("reload", confirm_map=((SAVE_CONFIRM_RE, "n"),))
    assert result["ok"] and result["rebooting"], result
    # The continue question got "y", the save question the mapped "n".
    assert chan.sent == ["reload\n", "y\n", "n\n"], chan.sent


@check("console reload never saves: the save question gets 'n'")
def _t_console_reload_no_save():
    chan = FakeChannel([
        "reload\nDevice will be rebooted, do you want to continue [y/n]? ",
        "y\nDo you want to save current configuration [y/n/^C]? ",
        TransportError("SSH connection closed by switch"),
    ])
    device = ProCurveDevice(ProCurveShell(chan), "test")
    try:
        device.run_raw("reload", timeout=5)
    except TransportError:
        pass  # the session dying is what a real reboot looks like
    # Continue: yes. Save the running config on the way down: never silently.
    assert chan.sent == ["reload\n", "y\n", "n\n"], chan.sent


@check("reboot dialogue: a returning prompt means the switch did NOT reboot")
def _t_reboot_rejected():
    chan = FakeChannel([
        "boot system flash secondary\nThis will reboot the system, continue [y/n]? ",
        "y\nThe Secondary OS image is not valid.  Boot aborted.\nSW-CORE# ",
    ])
    device = ProCurveDevice(ProCurveShell(chan), "test")
    result = device._run_reboot("boot system flash secondary")
    assert result["rebooting"] is False, result
    assert result["ok"] is False, result
    assert "not valid" in (result["error"] or ""), result


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


# pytest picks these up automatically via the module-level `test_*` alias below.
def test_all():
    assert main() == 0


if __name__ == "__main__":
    raise SystemExit(main())
