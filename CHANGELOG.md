# Changelog

All notable changes to ProCurve Cockpit are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Stage → review → apply.** Config changes no longer go to the switch one
  form at a time: they are staged locally (each still previewing its exact
  CLI), the top bar shows “N pending changes”, and from there the whole set
  is reviewed, applied in one batch (with or without `write memory`) or
  discarded. The typed APPLY confirmation for dangerous commands moved to
  that apply step. Exec-level operations (reboot, image copy, TFTP) keep
  applying immediately behind their own confirmation.
- **The Save button only exists while there is something to save**; before
  the first applied change the top bar shows no save control at all.
- **No more console dumps as primary UI.** Every command without a dedicated
  parser now goes through a generic structure parser (key/value pairs plus
  every table, derived from the dash separator lines) and renders as real
  elements — definition lists and tables with a filter box on anything
  longer than six rows. This covers port security, 802.1X, DHCP snooping,
  ARP protect, RADIUS, TACACS+, authentication methods, SSH/telnet/web
  status, all QoS views, ACL overview and assignments, RIP, DHCP helpers,
  PoE system status, per-port STP and MST configuration, SNTP, debug
  destinations, boot history and startup config files. The raw text remains
  available, but only collapsed as a diagnostic fallback.
- **System resources no longer depend on one command.** Where a train
  rejects the status page (“Invalid input: system-information”) or omits
  CPU/memory from it, the dashboard tiles now fill from `show cpu` and
  `show memory` instead of staying empty.
- Hardening from the adversarial review of this round:
  - Staged changes are cleared on every session boundary and guarded
    everywhere they could silently die: disconnect asks first, closing or
    reloading the tab warns, and an exec-level reboot dialog points out that
    staged changes are not applied yet. A batch staged on switch A can never
    be applied to switch B.
  - Each staged change is applied as its own context-clean batch, so a raw
    block that forgets an `exit` cannot corrupt the changes staged after it;
    applied changes leave the queue immediately, so a connection loss
    mid-batch keeps only the un-applied remainder staged.
  - The review modal re-renders risks and the typed-APPLY gate when a change
    is removed, and the list itself renders correctly (a `replaceChildren`
    array bug showed `[object HTMLDivElement]` instead of the changes).
  - `Apply & save` and `write memory` now report “already saved” instead of
    turning the unsaved badge on; global keyboard shortcuts pause while a
    modal is open.
  - Parser fixes surfaced by real outputs: `Label [default] : value` lines
    (STP config, SNTP, 802.1X) now parse; single full-width dash dividers
    (`show telnet` session blocks) no longer produce one-column garbage
    tables; `show memory` pairs Total/Free per block instead of marrying
    values from different blocks; `show cpu` also understands the
    `CPU Util (%) : N` label style. Cached fetches are no longer mutated in
    place, removing a cross-parser race on `show spanning-tree config`.
  - The Access panel derives SSH/Telnet/web state from the structured pairs
    instead of a substring test on raw text that was effectively always
    “on”.
  - A second verification pass caught fallout of those fixes: staging now
    actually resolves as staged (a modal-close race made every staging look
    like a cancel, leaving panel edit buffers primed for duplicate staging);
    the review modal freezes while the batch is being sent (no mid-apply
    Remove/double-apply), works on a snapshot of the queue, and puts the
    un-applied remainder back if the connection dies mid-batch; result
    dialogs now say what actually happened (“applied, but write memory
    failed” instead of “0 of N commands rejected”); a batch with rejected
    commands is never written to startup config, matching the backend rule;
    a bare `write memory` no longer re-renders the page (which wiped
    half-typed forms); a reboot clears the by-then unappliable staged set
    instead of tripping the leave-page warning; empty tables (“no entries”)
    no longer hide populated tables below them; and the memory parser lost
    a catastrophic-backtracking regex (97 s on pathological input → 2.5 ms).

### Added

- **Firmware & boot panel.** `show flash` is now parsed for real — both
  images with size/date/version, boot ROM version and the default boot —
  instead of key/value-mangling the multi-column lines. The new panel under
  *System → Firmware & boot* covers everything the switch can do here:
  set the default boot image (`boot set-default flash`), boot from a specific
  image (`boot system flash`), copy one image over the other
  (`copy flash flash`), erase an image, update firmware over TFTP
  (`copy tftp flash`), and reboot — now, in *N* minutes (`reload after`),
  at a fixed time (`reload at`), plus cancelling the schedule.
- **Exec-level plans.** Boot/reload/copy/erase live outside `configure
  terminal`, so plans now carry an `exec_level` flag and `/api/apply` runs
  them at manager level. A command that takes the switch down on purpose is
  treated as a success when the session drops, with a dedicated “switch is
  rebooting” dialog instead of a spurious error; on “Apply & save”,
  `write memory` runs *before* the reboot command.
- **Event log panel.** `show logging -r` is parsed into structured entries
  (severity, date, time, event code, system, message — wrapped lines folded,
  old trains without the code column handled). The new *Status → Event log*
  page is a real table with full-text search, per-severity toggles with
  counts, a system filter, row limits, download and an optional 30-second
  auto-refresh that keeps the filters as they are.
- **Overview upgrades.** The dashboard now shows a *Flash & boot* card
  (images with running/default badges, boot ROM, build date) and renders
  *Recent events* as a table with severity badges instead of raw text.
- `show version` is parsed too: running revision, build date and which flash
  image the switch actually booted from.
- Risk analysis learned the difference between rebooting and not:
  `boot set-default` and `reload cancel` no longer demand the typed APPLY
  confirmation, while `erase flash` now does.
- Hardening from an adversarial review of the above:
  - The confirm detector now understands the `[y/n/^C]` form of ProVision's
    “Do you want to save current configuration?” question, and answers it the
    way the user chose (Apply = n, Apply & save = y — where the save already
    ran anyway). Before, a reboot with unsaved changes wedged at that
    question while the UI claimed the switch was rebooting.
  - `run()` now waits out its full timeout instead of giving up after 20
    seconds of silence — a `copy flash flash` or TFTP download no longer
    reports success mid-copy and desynchronises the session.
  - An SSH session ending is now reported as such (paramiko's EOF was
    indistinguishable from silence before), which is also the reliable
    “switch went down” signal for `reload`/`boot` on both transports —
    and if the prompt comes back instead, the reboot is reported as
    *rejected*, whatever the switch's wording.
  - A failed `write memory` aborts an exec batch instead of rebooting on
    top of the failure.
  - Flash parsing survives an erased image (blank columns no longer swallow
    the next line) and factory `m`-suffixed revisions parse.
  - `reload at/…` now validates value ranges (no more `reload at 99:99`
    reaching the switch) and all firmware inputs are ASCII-checked.
  - Event-log panel: severity counts and the system dropdown update on
    refresh, truncation is always labelled, a failed manual refresh shows
    a toast.
  - A second verification pass caught fallout of the first round: a typed
    `reload` in the CLI console (and raw config lines) now answers the save
    question with **n** instead of silently committing the running config —
    rebooting to discard a bad change keeps working. An abortive close (TCP
    RST mid-reboot) is treated like a clean EOF on both transports, a
    switch's parting words before hanging up ("maximum number of sessions")
    survive into the login error, and a batch aborted by a failed save no
    longer triggers panel refreshes or the unsaved badge.

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
