# EmuCompat

A [degoog](https://degoog-org.github.io/docs/index.html) plugin for PS2, PS3 and PS4 titles.

## Title IDs (slot)

Type a title ID such as `BLUS30443`, `SLUS-20001` or `CUSA00419` and an "at a glance" card appears with:

- the game name and a Wikipedia summary
- cover art from [SteamGridDB](https://www.steamgriddb.com/) (needs a free API key)
- emulator compatibility: RPCS3 (PS3), PCSX2 (PS2) and ShadPS4 (PS4)
- the latest PS3 update version from Sony's update server
- a region badge (US, EU, JP, KR, Asia)
- a link to the game's page on the PCSX2 wiki (PS2) or the ShadPS4 wiki (PS4), only when that page exists

Several IDs separated by spaces or commas (up to 4) give one card each.

## Names (`!emu`)

| Bang | Searches |
| --- | --- |
| `!emu god of war` | PS2, PS3 and PS4 together |
| `!emu god of war ps2` | PS2 only (also `ps3`, `ps4`, `playstation 2`, ...) |
| `!emu BLUS30443` | the full card for a title ID |

Each result lists the matching title IDs with region and compatibility, and links to the emulator wiki when the game has a page there. The trailing form also works: `god of war !emu`. Run `!emu` on its own for a short usage hint.

- PS2 and PS4 names are matched against the PCSX2 and ShadPS4 databases (downloaded once, cached for a day).
- PS3 has no local name database, so a PS3 search sends the name to rpcs3.net. Add `ps2` or `ps4` to keep a search local.
- Degoog loads one command per folder and never tells a command which trigger was typed, so separate `!ps2`-style bangs are not possible; the platform keyword does that job.

## Setup

1. Copy the `emu-compat` folder into `data/plugins/`, then restart degoog.
2. Open Settings, then Plugins, and configure **EmuCompat**.
3. Optional: paste a SteamGridDB API key to enable cover art.

## Notes

- The slot works on the script-free `/nojs` page.
- Images go through degoog's image proxy, so the browser never contacts SteamGridDB directly.
- Sony's update server presents a certificate that fails normal validation. Certificate checks are skipped for that one host only, and that retry does not use your outgoing proxy; every other request is validated and follows your proxy settings.
- Wiki pages are confirmed with a HEAD request and cached for a day, so a game without a wiki page simply has no link.
- `!emu` uses the slot's settings; if the slot is disabled it runs with the defaults.
- Sony's update server is only contacted while "Show version" is on. With that and RPCS3 compatibility both off, PS3 IDs have no data source and show no card.
- A card that is not ready within 8 seconds is left out; its lookups finish in the background, so the next search has it.
- Set `LOG_LEVEL=debug` to see why a lookup returned nothing.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Slot, `!emu` command, providers and rendering |
| `template.html` | Card markup |
| `style.css` | Card styles, using degoog CSS variables |
| `locales/en.json`, `locales/tr.json` | Strings (English, Turkish), rendered with `{{ t:plugin-emu-compat.key }}` |

## Credits and license

Substantially inspired by [EthanC/degoog-extensions](https://github.com/EthanC/degoog-extensions). Licensed under AGPL-3.0, like that repository.
