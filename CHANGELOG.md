# Changelog

All notable changes to ProCurve Cockpit are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Code quality

CodeQL's quality suite reported 10 findings across 5 rules. All are addressed:

- **Unused import** (2, Python): `Body` in `main.py`, `field` in `transport.py`.
- **Unused variable, import, function or class** (3, JavaScript): leftover
  `rawBlock`, `checkbox` and `table` imports in three panels.
- **Statement has no effect** (3, Python): the `...` bodies of the
  `ByteChannel` protocol, replaced by docstrings that say what each method has
  to do.
- **Empty except** (1, Python): `ProCurveDevice.close()` swallowed a
  `TransportError` silently. It now logs at debug level and explains why the
  case is normal — the switch drops the session on `reload` and on its own idle
  timeout.
- **Unhashable object hashed** (1, Python, severity error) at
  `parsers.py:248`: `_pick()` looked its keys up by indexing. Every caller
  passes string literals, so it could not actually raise — but a helper that
  fuzzily matches labels coming straight off the wire has no business being
  able to. It now walks the key/value pairs instead of hashing, which also
  makes its three widening match passes explicit.
- `Risk` became a frozen dataclass along the way: it hashes by value, so risk
  de-duplication puts the objects straight into the set instead of building a
  parallel key tuple that could drift when a field is added.

### Fixed

- **`show snmp-server` was parsed as one giant community table.** A table used
  to survive a blank line if the next line was indented — but the sections that
  follow the community table (`Trap Receivers`, `Traps Category`, the trap list)
  are indented too, so all of them got sliced into the community columns, each
  with its own “Remove” button. A blank line now ends a table, full stop.
- **LLDP detail was always empty.** ProVision has no `detail` keyword on
  `show lldp info remote-device`; the long form is reached by naming a port. It
  is now fetched per port, but only for ports that actually reported a
  neighbour.

### Added

- **MAC lookup.** In *MAC & ARP* you can paste a MAC in any notation
  (`aa:bb:cc:dd:ee:ff`, `aabbcc-ddeeff`, `aabb.ccdd.eeff`, bare hex) or an IP
  address and get the port it is on. Partial input works too. When the MAC is
  not in the table, the answer says why that happens rather than just “nothing
  found”.
- **MAC addresses per port.** The port list has a MAC count column, and the
  inspector shows a searchable list of the MACs behind the selected port(s),
  each with its VLAN and — where ARP knows one — its IP.
- The port search now also matches MAC addresses, so pasting a MAC into the
  port filter narrows the list to the port it hangs on.
- CDP neighbours are rendered as a table instead of raw console output.
- SNMP trap receivers and trap categories are rendered as tables; an empty
  receiver list says outright that nobody is being notified.

### Changed

- The port inspector shows only the enable/disable button that would actually
  change something. With a mixed selection both appear, each labelled with how
  many ports it affects.

## [1.1.0] — 2026-08-17

First run against real hardware, and the language of the whole project switched
to English.

### Fixed

- **The change modal was permanently visible and could not be dismissed.** The
  stylesheet had no `[hidden]` rule, and any author rule carrying `display`
  beats the browser's `[hidden] { display: none }` however specific it is — so
  `.modal-backdrop { display: grid }` won. This also affected `#app` and the
  badges, meaning the app shell was already drawn behind the login screen.
- **The port search found nothing for `U100`.** It matched against
  `JSON.stringify(port)`, where the untagged VLAN is just `100`; the `U100`
  shorthand only exists in the rendered table. Search now runs against a
  purpose-built haystack that includes the printed shorthand, link state and
  neighbour name.
- **The search box was unstyled.** `input[type=search]` was missing from the
  form-control selector, so the browser default leaked through.
- **`show system-information` could come back empty.** Echo removal dropped the
  whole first line; when the echo and the first line of output share a line, that
  swallowed the entire reply. Only the command text is cut now.

### Changed

- **Everything is in English** — interface, README, changelog, comments, start
  scripts.
- The port inspector opens on the **current** state instead of “unchanged”. This
  needs `show interfaces config` in addition: `show interfaces brief` only
  reports the negotiated state (`1000FDx`, `MDIX`), not the configured one
  (`Auto`, `Auto-MDIX`). Also read now: `show lldp config` and
  `show spanning-tree config`.
- Each field remembers the value it started with and is only sent when it moved
  away from it, so preselecting never produces a configuration line.
- With a multi-port selection, differing values read “mixed” instead of showing
  an arbitrarily chosen one.
- A single selected port gets a summary at the top of the inspector: status,
  type, VLANs, trunk, LLDP neighbour.
- **The membership matrix was rewritten for legibility**: larger cells, a
  cross hair that lights up the row and column under the pointer, a heavier rule
  every four ports, port names next to port numbers, VLAN colour dots in the
  column heads, and a legend. Clicking a column head edits that VLAN.
- Port selection gained explicit *Select all*, *Clear selection*, *Invert*,
  *Only up / down / disabled*, a header checkbox that acts on the filtered rows
  only, and a *Select listed* button next to the search.

### Robustness

- A command that returns nothing now surfaces its **full transcript**, echo and
  prompt included. A bare “(empty)” is impossible to diagnose.
- `show system-information` falls back to `show system information` and
  `show system` when the first spelling produces nothing.
- `Up Time` and `CPU Util` are additionally located by scanning the raw text, in
  case the firmware wraps the two-column status block differently than
  documented.

## [1.0.0] — 2026-08-17

Initial release. Complete web interface for HP/Aruba ProVision switches, built
for the HP 2910al-24G.

### Added

**Transport**
- SSH connection with legacy crypto: `diffie-hellman-group14-sha1`,
  `diffie-hellman-group1-sha1`, host key `ssh-rsa`, `aes*-cbc`, `hmac-sha1`.
  The old algorithms are preferred, the modern ones stay active — nothing is
  disabled.
- Telnet fallback with a hand-written RFC 854 implementation, since Python 3.13
  removed `telnetlib`.
- Persistent, serialised CLI session (the switch permits only one).
- Prompt detection including context (`SW(config)#`), automatic `no page`,
  VT100 cleanup and CR/backspace overlay so `-- MORE --` leftovers disappear.
- Error detection split into line-anchored prefixes and unambiguous phrases, so
  a word like “failed” in the event log raises no false alarm.

**Parsers**
- Generic ProCurve table parser that derives column boundaries from the
  separator line (`---- + ----`) instead of fixed offsets, which lets it survive
  format differences between firmware trains.
- Stacked header lines are joined and duplicate column names disambiguated
  (`show trunks` has two columns called `Type`).
- Key/value parser for two pairs per line, plus a dedicated block for the
  two-column memory display.
- Parsers for ports, port names, VLANs, VLAN membership, trunks, LACP, LLDP,
  the MAC table, ARP, PoE, STP, IP configuration, routes, flash, modules, SNMP
  communities, as well as config text and config diff.

**Interaction model**
- Preview → apply: every action first produces the exact CLI lines, shows them,
  and executes only after confirmation.
- Lockout risk analysis that knows the management VLAN and the connected IP, and
  therefore warns about your own VLAN rather than every VLAN. Recognised among
  others: `no ip ssh`, IP changes on the management VLAN, removing ports from
  it, `erase startup-config`, `reload`, `crypto key zeroize`, disabling STP.
- Critical plans additionally require typing `APPLY`.
- 21 intent translators (port, VLAN, trunk, STP, PoE, system, logging, SNMP,
  access, credentials, mirroring, routing, QoS, raw CLI), entirely offline and
  testable without a switch.
- ProVision specifics respected: a port can only be untagged in one VLAN, so the
  previous membership is released first, automatically.

**Interface**
- 16 panels in five groups: Status, Configuration, Security, Diagnostics,
  System.
- Front-panel view in physical order (odd on top), shift-click for ranges,
  colouring by status, VLAN, speed or PoE.
- Click matrix port × VLAN that collects every change and turns it into a single
  reviewable plan.
- Config diff running vs startup, download as `.cfg`, pushing lines.
- CLI console over WebSocket on the same session, as an escape hatch for
  anything not modelled as a panel.
- Every panel shows the raw output of its `show` command, so a parser that is
  off becomes visible immediately.
- Vanilla ES modules, no build step, dark design.

**Backend**
- FastAPI with REST and WebSocket, session management via an `X-Session` header.
- Capability probing on connect: PoE, routing, LLDP, stacking, modules, port
  count.
- TTL cache per `show` command; VLAN membership considerably longer, since it
  costs N+1 round trips and only changes through our own edits.
- Binds to 127.0.0.1 by default. Credentials live in memory only and are never
  written to disk.

**Tests**
- 19 parser, plan and risk checks against realistic K/W.15.x output.
- 6 checks of the HTTP layer, all runnable without a switch.

### Important

- `paramiko` is deliberately pinned to `>=3.4,<4`. **Paramiko 4 and 5 removed
  SHA-1 key exchange and the `ssh-rsa` host key completely** — precisely what a
  ProVision switch offers as its only option. A `pip install -U paramiko` makes
  every connection impossible. The backend checks this at startup and on connect
  and reports it in plain words instead of throwing a cryptic handshake error.
- The parsers were written against documented output formats, not against a real
  device. Deviations are possible; the raw output block in each panel is the
  intended way to find them.

[1.1.0]: https://github.com/KronigDev/procurve-cockpit/releases/tag/v1.1.0
[1.0.0]: https://github.com/KronigDev/procurve-cockpit/releases/tag/v1.0.0
