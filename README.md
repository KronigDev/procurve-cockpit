# ProCurve Cockpit

A modern web interface for HP/Aruba **ProVision** switches — built for the
**HP 2910al-24G**, works just as well on the 2810, 2510, 3500yl, 5400zl and
relatives.

Instead of the Java web UI from 2009, the cockpit drives a persistent SSH
session to the CLI. That makes **every** feature of the switch reachable — on
ProVision the CLI is the only complete interface (SNMP can write only fragments,
the old web UI even less).

```
   Browser ──HTTP/WS──> FastAPI (local) ──SSH(legacy crypto)──> 2910al
```

Current version: **1.1.0** — see [CHANGELOG.md](CHANGELOG.md).

## Quick start

```powershell
.\start.ps1
```

The first run creates a virtual environment and installs the dependencies, then
opens <http://127.0.0.1:8710/>. Enter IP, user and password there — nothing is
written to disk.

Double-clicking `start.bat` works too.

## Why this is necessary at all

The 2910al speaks SSH from 2008: key exchange `diffie-hellman-group14-sha1`,
host key `ssh-rsa`, cipher `aes*-cbc`, MAC `hmac-sha1`. PuTTY still offers those;
modern SSH libraries do not.

> **Important:** the dependency is deliberately pinned to `paramiko>=3.4,<4`.
> **Paramiko 4 and 5 removed SHA-1 key exchange and `ssh-rsa` entirely** — which
> makes a connection to a ProVision switch impossible. A `pip install -U
> paramiko` breaks the cockpit. The backend checks this at startup and again when
> connecting, and says so in plain words instead of throwing a cryptic handshake
> error.

Telnet is built in as a fallback for switches where `ip ssh` was never enabled.
Since Python 3.13 removed `telnetlib`, `backend/transport.py` speaks the
necessary parts of RFC 854 itself.

## How it works: preview → apply

No click reaches the switch unreviewed. Every action first produces **the exact
CLI lines** that would be sent. Those are shown, together with a risk analysis,
and only executed after confirmation.

Commands that can lock you out additionally require you to type `APPLY`. The
analysis knows your management VLAN and the IP you are connected through, so it
warns about *your* VLAN rather than every VLAN.

Recognised among others: `no ip ssh`, IP changes on the management VLAN,
removing ports from the management VLAN, `erase startup-config`, `reload`,
`crypto key zeroize`, disabling spanning tree.

## Features

| Area | What you get |
|---|---|
| **Overview** | Model, firmware, serial, uptime, CPU, memory, modules, log |
| **Ports** | Front-panel view with multi-select (shift-click), name, enable/disable, speed/duplex, flow control, MDI, broadcast limit, LLDP mode, VLAN assignment, per-port STP. Every control opens on the value currently configured |
| **VLANs** | Create/change/delete, IP (static/DHCP), jumbo, voice, DHCP relay, primary/management VLAN, **click matrix port × VLAN** |
| **Trunks** | Create and dissolve LACP / static trunk / FEC, LACP status |
| **Spanning tree** | RSTP/MSTP/STP, bridge priority, MST region, per port: cost, priority, admin edge, BPDU protection, root guard |
| **PoE** | Per port on/off (= remote reboot of an access point), priority, allocation method, power limit, live draw |
| **Neighbours** | LLDP/CDP including detail output |
| **MAC & ARP** | Full-text search, MAC↔IP correlation through the ARP table |
| **IP & routing** | VLAN interfaces, routing table, static routes, default gateway, IP routing on/off, RIP status |
| **Security** | SSH/Telnet/web on/off, manager/operator passwords, SNMP communities and trap targets, port security, 802.1X/RADIUS/TACACS/DHCP snooping/ARP protect (read-only) |
| **QoS** | Port priority, DSCP mapping, rate limits |
| **ACLs** | CLI block editor with preview |
| **Mirroring** | Set up and remove SPAN sessions |
| **System** | Host name, location, contact, banner, time zone, daylight saving, SNTP, syslog |
| **Configuration** | running vs startup as a diff, download as `.cfg`, push lines, `write memory`, `reload`, factory reset |
| **CLI console** | A full command line on the same session — everything not modelled above |

The front panel can be coloured by **status, VLAN, speed or PoE**.

## When a panel looks wrong

The parsers were written against the documented K/W.15.x output formats, not
against your particular switch. If a table stays empty or columns slip:

1. Every panel has **“Raw output: `show …`”** at the bottom — that is what the
   switch actually replied. If a command returns nothing at all, the block shows
   the full transcript including echo and prompt, so you can tell silence apart
   from a rejected command.
2. Add that output as a new sample in `tests/test_parsers.py` and adjust the
   parser. The tests run without a switch.

The parsers derive column boundaries from the separator line (`---- + ----`)
rather than from fixed offsets, so they absorb format differences between
firmware trains on their own.

## Tests

```powershell
.\.venv\Scripts\python.exe tests\test_parsers.py   # parsers + plan building + risk analysis
.\.venv\Scripts\python.exe tests\test_api.py       # HTTP layer, no switch needed
```

## Layout

```
backend/
  transport.py   SSH (legacy crypto) + Telnet, prompt detection, paging, error detection
  parsers.py     Generic ProCurve table parser + one parser per command
  device.py      Command layer: show calls, caching, capability probing
  plan.py        UI intent -> CLI lines + lockout risk analysis (never touches the switch)
  main.py        FastAPI: REST + WebSocket console, session management
frontend/
  index.html     Login + app shell
  app.css        Design
  js/            ES modules, no build step
    panels/      one module per area
tests/
```

## Branches

- `main` — default branch, should always run
- `dev` — where work happens, merged into `main` afterwards

Every notable change belongs in [CHANGELOG.md](CHANGELOG.md).

## Limits, honestly

- **No atomic `config replace`.** ProVision cannot do it over the CLI; pushed
  lines are merged into the running configuration.
- **One CLI session.** The switch allows exactly one, so all requests are
  serialised. With several panels open, one of them waits briefly.
- **Passwords travel over the CLI in clear text** (`password manager plaintext
  …`) — that is a property of the switch, not of this interface. Over SSH the
  transport is encrypted, but the command can show up in the switch log.
- **`show tech` and `show logging`** take several seconds on these boxes; the log
  on the overview page is therefore loaded afterwards.
- **Do not put this on a network.** The server has no authentication of its own;
  whoever reaches it reaches the open switch session. That is why it binds to
  127.0.0.1.
