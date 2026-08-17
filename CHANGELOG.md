# Changelog

Alle nennenswerten Änderungen an ProCurve Cockpit stehen hier.

Das Format orientiert sich an [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
die Versionierung an [Semantic Versioning](https://semver.org/lang/de/).

## [Unveröffentlicht]

### Behoben

- Das Änderungs-Modal war dauerhaft sichtbar und ließ sich nicht wegklicken.
  Dem Stylesheet fehlte eine `[hidden]`-Regel: jede Autoren-Regel mit `display`
  schlägt das `[hidden] { display: none }` des Browsers, `.modal-backdrop`
  hatte also gewonnen. Betraf auch `#app` und die Badges.

### Geändert

- Die Port-Auswahl zeigt jetzt den **aktuellen** Zustand statt „unverändert“.
  Dafür wird zusätzlich `show interfaces config` gelesen — `show interfaces
  brief` liefert nur den ausgehandelten Zustand (`1000FDx`, `MDIX`), nicht den
  konfigurierten (`Auto`, `Auto-MDIX`). Neu ebenfalls gelesen: `show lldp
  config` und `show spanning-tree config`.
- Jedes Feld merkt sich seinen Ausgangswert und wird nur gesendet, wenn es
  davon abweicht. Vorbelegen erzeugt damit keine Konfigurationszeile.
- Bei Mehrfachauswahl mit unterschiedlichen Werten steht „gemischt“ statt
  eines willkürlich gewählten Werts.
- Bei einem einzelnen Port steht oben im Inspektor eine Übersicht: Status,
  Typ, VLANs, Trunk, LLDP-Nachbar.

### Robustheit

- `Up Time` und `CPU Util` werden zusätzlich per Textsuche gefunden, falls die
  Firmware den zweispaltigen Statusblock anders umbricht als dokumentiert.

## [1.0.0] — 2026-08-17

Erste Fassung. Vollständige Weboberfläche für HP/Aruba ProVision-Switches,
gebaut für den HP 2910al-24G.

### Hinzugefügt

**Transport**
- SSH-Verbindung mit Legacy-Krypto: `diffie-hellman-group14-sha1`,
  `diffie-hellman-group1-sha1`, Hostkey `ssh-rsa`, `aes*-cbc`, `hmac-sha1`.
  Die alten Verfahren werden bevorzugt, die modernen bleiben aktiv — es wird
  nichts abgeschaltet.
- Telnet-Fallback mit eigener RFC-854-Implementierung, da Python 3.13
  `telnetlib` entfernt hat.
- Persistente, serialisierte CLI-Sitzung (der Switch erlaubt nur eine).
- Prompt-Erkennung inklusive Kontext (`SW(config)#`), automatisches `no page`,
  VT100-Bereinigung und CR/Backspace-Overlay, damit `-- MORE --`-Reste
  verschwinden.
- Fehlererkennung getrennt nach zeilenanfangs-verankerten Präfixen und
  eindeutigen Phrasen, damit Wörter wie „failed" im Event-Log keine
  Falschmeldung auslösen.

**Parser**
- Generischer ProCurve-Tabellenparser, der Spaltengrenzen aus der Trennlinie
  (`---- + ----`) ableitet statt aus festen Offsets — überlebt damit
  Formatunterschiede zwischen Firmware-Ständen.
- Mehrzeilige Kopfzeilen werden zusammengefasst und doppelte Spaltennamen
  entschärft (`show trunks` hat zwei Spalten namens `Type`).
- Key/Value-Parser für zwei Paare pro Zeile plus eigener Block für die
  zweispaltige Speicheranzeige.
- Parser für Ports, Port-Namen, VLANs, VLAN-Mitgliedschaft, Trunks, LACP,
  LLDP, MAC-Tabelle, ARP, PoE, STP, IP-Konfiguration, Routen, Flash, Module,
  SNMP-Communities sowie Config-Text und Config-Diff.

**Bedienkonzept**
- Vorschau → Anwenden: jede Aktion erzeugt zuerst die exakten CLI-Zeilen,
  zeigt sie an und wird erst nach Bestätigung ausgeführt.
- Lockout-Risikoanalyse, die das Management-VLAN und die verbundene IP kennt
  und damit beim eigenen VLAN warnt, nicht bei jedem. Erkannt werden u. a.
  `no ip ssh`, IP-Änderungen am Management-VLAN, Entfernen von Ports daraus,
  `erase startup-config`, `reload`, `crypto key zeroize`, STP abschalten.
- Kritische Pläne verlangen zusätzlich, dass `APPLY` getippt wird.
- 21 Intent-Übersetzer (Port, VLAN, Trunk, STP, PoE, System, Logging, SNMP,
  Zugriff, Passwörter, Mirroring, Routing, QoS, Roh-CLI), vollständig offline
  und testbar ohne Switch.
- ProVision-Eigenheit berücksichtigt: ein Port kann nur in einem VLAN untagged
  sein, die alte Mitgliedschaft wird vorher automatisch gelöst.

**Oberfläche**
- 16 Panels in fünf Gruppen: Status, Konfiguration, Sicherheit, Diagnose,
  System.
- Frontblenden-Ansicht in physischer Anordnung (ungerade oben), Shift-Klick
  für Bereiche, Einfärbung nach Status, VLAN, Geschwindigkeit oder PoE.
- Klick-Matrix Port × VLAN, die alle Änderungen sammelt und daraus einen
  einzigen prüfbaren Plan macht.
- Config-Diff running vs. startup, Download als `.cfg`, Einspielen von Zeilen.
- CLI-Konsole über WebSocket auf derselben Sitzung als Escape-Hatch für alles,
  was nicht als Panel modelliert ist.
- Jedes Panel zeigt unten die Rohausgabe des zugehörigen `show`-Befehls, damit
  ein danebenliegender Parser sofort sichtbar wird.
- Vanilla ES-Module ohne Build-Step, dunkles Design.

**Backend**
- FastAPI mit REST und WebSocket, Sitzungsverwaltung über `X-Session`-Header.
- Fähigkeitserkennung beim Verbinden: PoE, Routing, LLDP, Stacking, Module,
  Portanzahl.
- TTL-Cache je `show`-Befehl; VLAN-Mitgliedschaft deutlich länger, da sie
  N+1 Roundtrips kostet und sich nur durch eigene Änderungen ändert.
- Bindet standardmäßig auf 127.0.0.1. Zugangsdaten liegen ausschließlich im
  Arbeitsspeicher und werden nie auf Platte geschrieben.

**Tests**
- 19 Parser-, Plan- und Risiko-Prüfungen gegen realistische
  K/W.15.x-Ausgaben.
- 6 Prüfungen der HTTP-Schicht, alle ohne Switch lauffähig.

### Wichtig

- `paramiko` ist bewusst auf `>=3.4,<4` gepinnt. **Paramiko 4 und 5 haben
  SHA-1-Key-Exchange und den `ssh-rsa`-Hostkey vollständig entfernt** — genau
  das, was ein ProVision-Switch als einziges anbietet. Ein
  `pip install -U paramiko` macht jede Verbindung unmöglich. Das Backend prüft
  das beim Start und beim Verbindungsaufbau und meldet es im Klartext, statt
  einen kryptischen Handshake-Fehler zu werfen.
- Die Parser wurden gegen die dokumentierten Ausgabeformate gebaut, nicht
  gegen ein reales Gerät. Abweichungen sind möglich; die Rohausgabe in jedem
  Panel ist der vorgesehene Weg, sie zu finden.

[1.0.0]: https://github.com/KronigDev/procurve-cockpit/releases/tag/v1.0.0
