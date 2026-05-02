# 12x12 Voice Write

Sprache zu Text per Hotkey für Windows. Drück **F9**, sprich, drück nochmal — Text liegt in der Zwischenablage.

Powered by [Groq](https://groq.com) Whisper Large v3 Turbo (Transkription) + Llama 3.3 70B (Grammatik-Korrektur).
Free Tier reicht für hunderte Aufnahmen pro Tag.

![Window Screenshot](docs/screenshot.png)

---

## Features

- **Globaler Hotkey** von überall (F9 Default, frei wählbar in Settings)
- **Whisper Large v3 Turbo** via Groq — schnellste Transkription, ~300ms
- **KI-Korrektur** via Llama 3.3 70B — Grammatik, Zeichensetzung, deutsche Sprache bleibt deutsch
- **Auto-Paste** optional, sonst nur Clipboard
- **Auto-Update-Check** alle 6h gegen Manifest auf 12x12.community
- **Single-Instance-Lock** — keine Doppel-Instanzen
- **Auto-Start mit Windows**, läuft im System-Tray
- **Liquid-Glass Pill-Design** (260×44px) mit KITT-Scanner-Animation
- **Single-Instance-Lock** — keine Doppel-Instanzen, robuster Hotkey

## Installation

### Option 1 — Installer von 12x12.community
Direkt-Download: [12x12-Voice-Write-Setup.exe](https://netzwerk12xx12.web.app/downloads/12x12-Voice-Write-Setup.exe) (76 MB)

> Windows SmartScreen warnt evtl. (unsigniert) → "Weitere Informationen" → "Trotzdem ausführen". Bis SignPath-Signatur kommt.

### Option 2 — Vom Source bauen

```bash
git clone https://github.com/pierre-wagner/12x12-voice-write.git
cd 12x12-voice-write
npm install
npm start                    # Dev-Modus
npm run build                # Erstellt dist/12x12-Voice-Write-Setup-1.0.0.exe
```

## Setup

1. Beim ersten Start öffnet sich das Settings-Panel
2. **Groq API Key** eintragen — gratis von [console.groq.com](https://console.groq.com) (30 Sekunden)
3. Speichern, fertig

## Usage

- **F9** drücken → Aufnahme startet (Pille zeigt rote KITT-Animation)
- Sprich
- **F9** nochmal drücken → Whisper transkribiert + Llama korrigiert → Text in Zwischenablage
- **Strg+V** wo du willst (oder Auto-Paste in Settings aktivieren)

## Tech Stack

- **Electron 31** + Node.js 18+
- **Vanilla HTML/CSS/JS** (kein Framework — minimal Bundle)
- **electron-store** für Settings-Persistenz
- **electron-builder** mit NSIS-Target
- **auto-launch** für Windows-Autostart
- **form-data** für Whisper-API-Upload
- **Groq API** (OpenAI-kompatibel) für Whisper + Llama

## Architecture

```
main.js              Electron-Main: window, tray, hotkey, IPC, API-Calls, Update-Check
preload.js           IPC-Bridge zwischen Main + Renderer (contextIsolation)
src/
  index.html         UI — KITT-Scanner-Pille + Settings-Overlay
  style.css          Liquid-Glass + Scanner-Animation
  app.js             Recording, State-Machine, Settings
assets/              App-Icon + Tray-Icon (procedural via generate-icons.js)
generate-icons.js    PNG-Icons aus Code generieren (zlib-PNG-Encoder)
start-silent.vbs     Windows-Launcher ohne Console-Fenster
```

## Privacy

- **Audio**: lokal aufgenommen, geht **direkt** zu Groq's Whisper-API zur Transkription
- **Text**: geht zu Groq's Llama für Korrektur, dann in deine Zwischenablage
- **Nichts wird auf 12x12-Servern gespeichert** — alles fließt nur durch deinen Groq-Account
- **API-Key**: lokal in `%APPDATA%\12x12-voicewrite\config.json`, nicht in der Cloud

## Development

```bash
npm start                    # Lokal entwickeln (Electron mit Live-Code)
npm run build                # Windows-Installer bauen
node generate-icons.js       # Icons regenerieren (nach Änderung in generate-icons.js)
```

Logs landen in `%APPDATA%\12x12-voicewrite\app.log` — sehr hilfreich beim Debuggen.

## License

MIT — siehe [LICENSE](LICENSE)

## Author

Pierre Wagner — Teil der [12x12 Community](https://netzwerk12xx12.web.app).
