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
from backend.transport import clean, detect_error, render_overwrites  # noqa: E402

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


@check("show interfaces config")
def _t_port_config():
    cfg = P.parse_port_config(INTERFACES_CONFIG)
    assert set(cfg) == {"1", "2", "3", "21"}, cfg
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
    print(f"\n{len(CHECKS) - failed}/{len(CHECKS)} bestanden")
    return 1 if failed else 0


# pytest picks these up automatically via the module-level `test_*` alias below.
def test_all():
    assert main() == 0


if __name__ == "__main__":
    raise SystemExit(main())
