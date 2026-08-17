# ProCurve Cockpit

Eine moderne Weboberfläche für HP/Aruba **ProVision**-Switches — gebaut für den
**HP 2910al-24G**, funktioniert genauso mit 2810, 2510, 3500yl, 5400zl und
Verwandten.

Statt des Java-Web-UIs von 2009 fährt das Cockpit hinten eine persistente
SSH-Sitzung zur CLI. Damit ist **jedes** Feature des Switches erreichbar — die
CLI ist auf ProVision die einzige vollständige Schnittstelle (SNMP kann nur
Bruchteile schreiben, das alte Web-UI noch weniger).

```
   Browser ──HTTP/WS──> FastAPI (lokal) ──SSH(Legacy-Krypto)──> 2910al
```

Aktuelle Version: **1.0.0** — siehe [CHANGELOG.md](CHANGELOG.md).

## Schnellstart

```powershell
.\start.ps1
```

Beim ersten Start wird eine virtuelle Umgebung angelegt und die Abhängigkeiten
installiert; danach öffnet sich <http://127.0.0.1:8710/>. Dort IP, Benutzer und
Passwort eingeben — es wird nichts auf Platte geschrieben.

Alternativ per Doppelklick auf `start.bat`.

## Warum das überhaupt nötig ist

Der 2910al spricht SSH von 2008: Key-Exchange `diffie-hellman-group14-sha1`,
Hostkey `ssh-rsa`, Cipher `aes*-cbc`, MAC `hmac-sha1`. PuTTY bietet das noch an,
moderne SSH-Bibliotheken nicht mehr.

> **Wichtig:** Die Abhängigkeit ist bewusst auf `paramiko>=3.4,<4` gepinnt.
> **Paramiko 4 und 5 haben SHA-1-Kex und `ssh-rsa` komplett entfernt** — damit
> ist keine Verbindung zu einem ProVision-Switch mehr möglich. Ein
> `pip install -U paramiko` macht das Cockpit kaputt. Das Backend prüft das
> beim Start und beim Verbindungsaufbau und sagt es deutlich, statt einen
> kryptischen Handshake-Fehler zu werfen.

Telnet ist als Fallback eingebaut, falls auf einem Switch `ip ssh` nie aktiviert
wurde. Da Python 3.13 `telnetlib` entfernt hat, spricht `backend/transport.py`
das Nötigste von RFC 854 selbst.

## Bedienkonzept: Vorschau → Anwenden

Kein Klick geht direkt an den Switch. Jede Aktion erzeugt zuerst **exakt die
CLI-Zeilen**, die gesendet würden. Die werden angezeigt, zusammen mit einer
Risikoanalyse, und erst nach Bestätigung ausgeführt.

Befehle, die dich aussperren können, verlangen zusätzlich, dass du `APPLY`
tippst. Die Analyse kennt dabei dein Management-VLAN und die IP, über die du
gerade verbunden bist — sie warnt also bei *deinem* VLAN, nicht bei jedem.

Erkannt werden u. a.: `no ip ssh`, IP-Änderung am Management-VLAN, Entfernen von
Ports aus dem Management-VLAN, `erase startup-config`, `reload`,
`crypto key zeroize`, Abschalten von Spanning Tree.

## Funktionsumfang

| Bereich | Was geht |
|---|---|
| **Übersicht** | Modell, Firmware, Seriennummer, Uptime, CPU, Speicher, Module, Log |
| **Ports** | Frontblenden-Ansicht mit Mehrfachauswahl (Shift-Klick), Name, Enable/Disable, Speed/Duplex, Flow Control, MDI, Broadcast-Limit, LLDP-Modus, VLAN-Zuordnung, STP pro Port |
| **VLANs** | Anlegen/Ändern/Löschen, IP (statisch/DHCP), Jumbo, Voice, DHCP-Relay, Primary-/Management-VLAN, **Klick-Matrix Port × VLAN** |
| **Trunks** | LACP / statischer Trunk / FEC anlegen und auflösen, LACP-Status |
| **Spanning Tree** | RSTP/MSTP/STP, Bridge-Priorität, MST-Region, pro Port: Kosten, Priorität, Admin-Edge, BPDU-Protection, Root-Guard |
| **PoE** | Pro Port ein/aus (= Fernneustart eines Access Points), Priorität, Zuteilungsmethode, Leistungsgrenze, Live-Verbrauch |
| **Nachbarn** | LLDP/CDP inkl. Detailausgabe |
| **MAC & ARP** | Volltextsuche, MAC↔IP-Verknüpfung über die ARP-Tabelle |
| **IP & Routing** | VLAN-Interfaces, Routing-Tabelle, statische Routen, Default-Gateway, IP-Routing an/aus, RIP-Status |
| **Sicherheit** | SSH/Telnet/Web an/aus, Manager-/Operator-Passwörter, SNMP-Communities und Trap-Ziele, Port-Security, 802.1X/RADIUS/TACACS/DHCP-Snooping/ARP-Protect (lesend) |
| **QoS** | Port-Priorität, DSCP-Mapping, Rate-Limits |
| **ACLs** | CLI-Block-Editor mit Vorschau |
| **Mirroring** | SPAN-Sessions einrichten und entfernen |
| **System** | Hostname, Standort, Kontakt, Banner, Zeitzone, Sommerzeit, SNTP, Syslog |
| **Konfiguration** | running vs. startup als Diff, Download als `.cfg`, Zeilen einspielen, `write memory`, `reload`, Werksreset |
| **CLI-Konsole** | Vollwertige Kommandozeile auf derselben Sitzung — alles, was oben nicht modelliert ist |

Die Frontblende lässt sich nach **Status, VLAN, Geschwindigkeit oder PoE**
einfärben.

## Wenn ein Panel komisch aussieht

Die Parser wurden gegen die dokumentierten K/W.15.x-Ausgabeformate gebaut, nicht
gegen deinen konkreten Switch. Falls eine Tabelle leer bleibt oder Spalten
verrutschen:

1. In jedem Panel gibt es unten **„Rohausgabe: `show …`“** — dort steht, was der
   Switch tatsächlich geantwortet hat.
2. Diese Ausgabe als neues Sample in `tests/test_parsers.py` eintragen und den
   Parser anpassen. Die Tests laufen ohne Switch.

Die Parser leiten Spaltengrenzen aus der Trennlinie (`---- + ----`) ab statt aus
festen Offsets, decken also Formatunterschiede zwischen Firmware-Ständen von
selbst ab.

## Tests

```powershell
.\.venv\Scripts\python.exe tests\test_parsers.py   # Parser + Plan-Erzeugung + Risikoanalyse
.\.venv\Scripts\python.exe tests\test_api.py       # HTTP-Schicht, ohne Switch
```

## Aufbau

```
backend/
  transport.py   SSH (Legacy-Krypto) + Telnet, Prompt-Erkennung, Paging, Fehlererkennung
  parsers.py     Generischer ProCurve-Tabellenparser + Parser je Kommando
  device.py      Kommandoschicht: show-Aufrufe, Caching, Fähigkeitserkennung
  plan.py        UI-Absicht -> CLI-Zeilen + Lockout-Risikoanalyse (kein Switch-Zugriff)
  main.py        FastAPI: REST + WebSocket-Konsole, Sitzungsverwaltung
frontend/
  index.html     Login + App-Shell
  app.css        Design
  js/            ES-Module ohne Build-Step
    panels/      ein Modul pro Bereich
tests/
```

## Branches

- `main` — Standardbranch, soll immer lauffähig sein
- `dev` — hier wird gearbeitet, danach nach `main` gemergt

Jede nennenswerte Änderung gehört in [CHANGELOG.md](CHANGELOG.md).

## Grenzen, ehrlich

- **Kein atomares `config replace`.** ProVision kann das über die CLI nicht;
  eingespielte Zeilen werden in die laufende Konfiguration eingemischt.
- **Eine CLI-Sitzung.** Der Switch erlaubt genau eine, also werden alle Anfragen
  serialisiert. Bei parallelen Panels wartet eines kurz.
- **Passwörter gehen im Klartext über die CLI** (`password manager plaintext …`)
  — das ist eine Eigenheit des Switches, nicht dieser Oberfläche. Über SSH ist
  die Übertragung verschlüsselt, im Switch-Log kann der Befehl aber auftauchen.
- **`show tech` und `show logging`** brauchen auf diesen Geräten mehrere
  Sekunden; das Log wird auf der Übersicht deshalb nachgeladen.
- **Nicht ins Netz stellen.** Der Server hat keine eigene Authentifizierung; wer
  ihn erreicht, erreicht die offene Switch-Sitzung. Deshalb bindet er auf
  127.0.0.1.
