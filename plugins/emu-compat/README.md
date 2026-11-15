# EmuCompat

A [degoog](https://degoog-org.github.io/docs/index.html) plugin for PC, PS2, PS3 and PS4 games.

## Title IDs (slot)

Type a title ID such as `BLUS30443`, `SLUS-20001` or `CUSA00419` and an "at a glance" card appears with:

- the game name and a Wikipedia summary
- cover art from [SteamGridDB](https://www.steamgriddb.com/) (needs a free API key)
- emulator compatibility: RPCS3 (PS3), PCSX2 (PS2) and ShadPS4 (PS4)
- the latest PS3 update version from Sony's update server
- a region badge (US, EU, JP, KR, Asia)
- a link to the game's page on the PCSX2 wiki (PS2) or the ShadPS4 wiki (PS4), only when that page exists

Several IDs separated by spaces or commas (up to 4) give one card each.

## Names (`!game`)

| Bang | Searches |
| --- | --- |
| `!game god of war` | PC, PS2, PS3 and PS4 together |
| `!game god of war ps2` | PS2 only (also `ps3`, `ps4`, `playstation 2`, ...) |
| `!game doom pc` | PC only (`pc` counts only as the last word, so `pc building simulator` is a name) |
| `!game BLUS30443` | the full card for a title ID |

Several matches show as tabs (at most 5): one per PC game, labelled `Name (PC, Year)`, then one per PlayStation platform. The tabs work without JavaScript. Each PlayStation tab shows the full card of the game's best title ID (best emulator compatibility, then US, Europe, Japan), followed by "Show other title IDs", which expands the rest of its title IDs (closed by default, works without JavaScript). If that card cannot be built in time, the tab lists the matching title IDs with region and compatibility, and links to the emulator wiki when the game has a page there. The trailing form also works: `god of war !game`. Run `!game` on its own for a short usage hint.

- PS2 and PS4 names are matched against the PCSX2 and ShadPS4 databases (downloaded once, cached for a day).
- PS3 has no local name database, so a PS3 search sends the name to rpcs3.net. Add `ps2` or `ps4` to keep a search local.
- Degoog loads one command per folder and never tells a command which trigger was typed, so separate `!ps2`-style bangs are not possible; the platform keyword does that job.

## PC games

A PC game card shows the Steam name and release year, the top three Steam tags as the genre ("Metroidvania · Platformer · Souls-like"), the operating systems (Linux, macOS, Windows), the Steam Deck rating (Verified, Playable, Unsupported or Unknown, shown as an icon; its name appears beside it on hover or focus), a Steam link and, when GOG sells the game, a DRM-free GOG link.

- The description is Steam's short store description in the visitor's browser language when Steam has it (English otherwise, or always with **Use browser language** off), not Wikipedia. **Show Wikipedia description** turns it off as well.
- No native Linux build: the Linux entry shows the ProtonDB tier, such as `Linux (Proton Gold)`, linking to the game's ProtonDB page. No ProtonDB reports: `Linux ✗`.
- Plain searches: typing a popular game's name shows its card without a bang. Like the TMDb plugin, how close the name is decides how popular the game must be (**Minimum Steam reviews**, default 1000): the exact name (ignoring case, ™/® and suffixes such as "Remastered") needs the minimum, a name that starts with the search word by word (`dark souls` → *Dark Souls III*) needs 3×, a partial word match 8×. Turn **Similar names on plain searches** off to keep plain searches to the exact name. A trailing "game", "video game" or "oyunu" (`blasphemous game`) marks a game search: close matches then need no reviews, so upcoming games show too. Searches that are clearly not about a game ("how to …", "weather", "recipe", URLs) never reach Steam. When a PC game matches, PlayStation titles with exactly the same name are added as tabs (`god of war` → PC, PS2, PS4); without one, no PlayStation source is asked. Turn **PC games on plain searches** off to stop plain searches from asking Steam.
- Sources: Steam's store APIs (`storesearch`, `IStoreBrowseService/GetItems`, `IStoreService/GetTagList`), ProtonDB's summary API and GOG's catalog, all without keys and all cached for a day. Cover art comes from SteamGridDB, looked up by Steam app id (a name lookup mixes up remakes such as God of War 2005 and 2018). SteamDB and PCGamingWiki are not used: neither offers a public API for this.

## Setup

1. Copy the `emu-compat` folder into `data/plugins/`, then restart degoog.
2. Open Settings, then Plugins, and configure **EmuCompat**.
3. Optional: paste a SteamGridDB API key to enable cover art.

## Notes

- The slot works on the script-free `/nojs` page.
- Images go through degoog's image proxy and every lookup runs on the server, so the browser never contacts SteamGridDB, Steam, ProtonDB or GOG directly.
- Sony's update server presents a certificate that fails normal validation. Certificate checks are skipped for that one host only, and that retry does not use your outgoing proxy; every other request is validated and follows your proxy settings.
- PlayStation descriptions come from Wikipedia. With **Use browser language** on, the article is found on the English Wikipedia and replaced by its translation in the visitor's language when one exists (`tr.wikipedia.org`, ...); otherwise the English summary is shown.
- With **Use browser language** off, the card's own text (labels, compatibility levels, regions, Steam Deck status) is also written in English, whatever degoog's language.
- Wiki pages are confirmed with a HEAD request and cached for a day, so a game without a wiki page simply has no link.
- `!game` uses the slot's settings; if the slot is disabled it runs with the defaults.
- Sony's update server is only contacted while "Show version" is on. With that and RPCS3 compatibility both off, PS3 IDs have no data source and show no card.
- A card that is not ready within 8 seconds is left out; its lookups finish in the background, so the next search has it.
- Set `LOG_LEVEL=debug` to see why a lookup returned nothing.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Slot, `!game` command, providers and rendering |
| `template.html` | Card markup |
| `style.css` | Card styles, using degoog CSS variables |
| `locales/en.json`, `locales/tr.json` | Strings (English, Turkish), rendered with `{{ t:plugin-emu-compat.key }}` |

## Credits and license

Substantially inspired by [EthanC/degoog-extensions](https://github.com/EthanC/degoog-extensions). Licensed under AGPL-3.0, like that repository.
