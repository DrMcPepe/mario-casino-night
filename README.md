# Mario Casino Night

A local-first, real-time Wii Sports sportsbook and printable Beerio Kart event system for 13 players. Guests join the same Wi-Fi and use a browser. No app, account, cloud service, or database is required.

## What It Includes

- Mobile player view at `/`
- Full TV sportsbook at `/tv`
- Transparent OBS browser source at `/tv?overlay=1`
- PIN-protected host controls at `/admin`
- Printable master rulebook at `/rules`
- Exactly 13-player roster import from pasted text, `.txt`, or `.csv`
- 15-second starting wallets and a 60-second wallet cap
- Lost wagers converted into equal self-drinking debt
- Profit-only assignments with a 20-second lifetime recipient cap
- Undo for any pending market bet while betting is still open
- Grouped unpaid tabs with match and assignment context
- Sportsbook and per-sport Wii Sports W-L records for every player
- Host-confirmed shot buy-backs worth 5 seconds
- One-button test-event reset that preserves player names and phone claims
- Wii-inspired responsive interface and rotating TV top-five boards for tabs, match leaders, and wallets
- Per-selection TV odds, wagered seconds, bettor counts, and animated winning outcomes
- In-memory operation with an optional local JSON recovery checkpoint

## Requirements

- Windows PC with Node.js 22 or newer
- Dolphin Emulator and legally obtained game media
- Four Wii controllers
- All devices on the same private Wi-Fi network
- OBS Studio if using the in-game Wii Sports overlay

## First Run

```powershell
Copy-Item .env.example .env
npm install
npm start
```

Or double-click `scripts\start.cmd`.

The terminal prints the player, admin, and TV addresses. Open `/admin`, enter the PIN from `.env`, and import exactly 13 names.

The default development PIN is `2468`. Change it in `.env` before the event.

## Connect Phones

1. Put the PC and all phones on the same normal Wi-Fi network.
2. Avoid a guest network because it may block devices from seeing each other.
3. Start the server.
4. Open `/tv` on the display.
5. Guests scan the QR code or open the displayed numeric link.

If Windows asks for network access, allow Node.js on Private networks. If it does not ask, run PowerShell as Administrator once:

```powershell
New-NetFirewallRule -DisplayName "Mario Casino Night" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow -Profile Private
```

If the app displays the wrong adapter address, set the exact address in `.env`:

```text
PUBLIC_URL=http://192.168.1.42:5000
```

## Import Players

The admin accepts exactly 13 unique names. Paste one per line, paste a comma-separated list, or choose a text/CSV file. A first row containing `name`, `player`, or `player name` is ignored.

Replacing a roster after activity begins requires confirmation and resets the event.

## Testing Reset

The admin panel's **Reset test event** button clears all wallets, bets, match records, assignments, bar entries, and active matches. It keeps the 13 player names and existing phone claims so another test can begin immediately.

Players can undo all pending stakes in one market while the betting timer remains open. Once the host locks the book or the timer expires, those bets are final.

## OBS

Use three scenes:

| Scene | Source |
|---|---|
| Beerio Game | Dolphin only |
| Casino Dashboard | Browser source `http://localhost:5000/tv` |
| Casino Game | Dolphin plus browser source `http://localhost:5000/tv?overlay=1&side=right` |

See [`docs/OBS_SETUP.md`](docs/OBS_SETUP.md) for the full setup.

## State and Reset

Runtime state is held in memory. With `STATE_CHECKPOINT=true`, each mutation is also written to ignored local file `data/event-state.json` for restart recovery.

To start a completely fresh event, stop the server and delete `data/event-state.json`.

## Tests

```powershell
npm test
```

## Responsible Use

This project is for adults of legal drinking age. The host controls service and may pause play or refuse service at any time. Nobody should drive after participating. The software tracks game obligations; it does not determine whether serving someone is safe.

Game names belong to their respective owners. This repository contains no Nintendo game files, artwork, ROMs, keys, or proprietary assets.

## License

MIT. See [`LICENSE`](LICENSE).
