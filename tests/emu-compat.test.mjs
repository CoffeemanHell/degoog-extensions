import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const pluginUrl = new URL("plugins/emu-compat/", root);
const read = (url) => readFile(url, "utf8");

const manifest = JSON.parse(await read(new URL("package.json", root)));
const template = await read(new URL("template.html", pluginUrl));
const locale = JSON.parse(await read(new URL("locales/en.json", pluginUrl)));
const mod = await import(new URL("index.js", pluginUrl).href);
const { slot, _internals } = mod;
const command = mod.default;

/* ------------------------------- fixtures -------------------------------- */

const SONY_HOST = "a0.ww.np.dl.playstation.net";
const PATCH_XML = `<?xml version='1.0' encoding='UTF-8'?>
<titlepatch status="alive" titleid="BLUS30464"><tag name="BLUS30464_T4"><package version="01.05" size="34437328" sha1sum="1858" url="http://b0.ww.np.dl.playstation.net/x.pkg" ps3_system_ver="03.0000"><paramsfo><TITLE>Skate 3 DLC</TITLE></paramsfo></package></tag></titlepatch>`;
const GAME_INDEX = `SLUS-21621:
  name: "Persona 3"
  region: "NTSC-U"
  compat: 5
SLPM-66445:
  name: "ペルソナ3"
  name-en: "Persona 3 [Japan]"
  region: "NTSC-J"
SLUS-21782:
  name: "Persona 4"
  region: "NTSC-U"
  compat: 6
`;
const SHAD_DB = {
  CUSA00900: {
    linux: { name: "Bloodborne", status: "status-ingame", issue_number: "7", last_tested: "2026-01-01" },
    windows: { name: "Bloodborne", status: "status-playable", issue_number: "9", last_tested: "2025-01-01" },
  },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** Steam apps by appid: what storesearch, GetItems and ProtonDB know about each. */
const STEAM_APPS = {
  367520: { name: "Hollow Knight", reviews: 509119, year: 2017, deck: 3, tagids: [1628, 1625, 29482],
    platforms: { windows: true, mac: true, steamos_linux: true },
    descriptions: { english: "Forge your own path in Hollow Knight!", turkish: "Hollow Knight'ta kendi yolunu çiz!" } },
  999: { name: "Hollow Knight Fan Remake", reviews: 50, year: 2020, deck: 0, tagids: [1625],
    platforms: { windows: true, mac: false, steamos_linux: false }, proton: "gold" },
  998: { name: "Hollow Knight Demo", reviews: 20, deck: 0, tagids: [],
    platforms: { windows: true, mac: false, steamos_linux: false } },
};
const STEAM_TAGS = [
  { tagid: 1628, name: "Metroidvania" },
  { tagid: 1625, name: "Platformer" },
  { tagid: 29482, name: "Souls-like" },
];
const GOG_PRODUCTS = [{ title: "Hollow Knight", slug: "hollow_knight" }];
const STEAM_HOSTS = new Set(["store.steampowered.com", "api.steampowered.com"]);

/** Steam, ProtonDB and GOG answers built from STEAM_APPS (null for other hosts). */
function pcResponse(url, apps) {
  const { hostname, pathname, searchParams } = url;
  if (hostname === "store.steampowered.com" && pathname === "/api/storesearch/") {
    const term = searchParams.get("term").toLowerCase();
    const items = Object.entries(apps)
      .filter(([, app]) => app.name.toLowerCase().includes(term))
      .map(([id, app]) => ({ type: "app", id: Number(id), name: app.name }));
    return json({ total: items.length, items });
  }
  if (hostname === "api.steampowered.com" && pathname.includes("GetTagList")) {
    return json({ response: { tags: STEAM_TAGS } });
  }
  if (hostname === "api.steampowered.com" && pathname.includes("GetItems")) {
    const { ids, context } = JSON.parse(searchParams.get("input_json"));
    const language = context?.language ?? "english";
    const store_items = ids.map(({ appid }) => {
      const app = apps[appid];
      const descriptions = app.descriptions ?? {};
      return {
        appid,
        // Steam localises names too ("ELDEN RING" stays, others do not); the card must not use it.
        name: language === "english" ? app.name : `${app.name} [${language}]`,
        basic_info: { short_description: descriptions[language] ?? descriptions.english ?? "" },
        tagids: app.tagids,
        reviews: { summary_filtered: { review_count: app.reviews } },
        release: app.year ? { steam_release_date: Date.UTC(app.year, 5, 1) / 1000 } : {},
        platforms: { ...app.platforms, steam_deck_compat_category: app.deck },
      };
    });
    return json({ response: { store_items } });
  }
  if (hostname === "www.protondb.com") {
    const tier = apps[/(\d+)\.json$/.exec(pathname)?.[1]]?.proton;
    return tier ? json({ tier, total: 10 }) : new Response("", { status: 404 });
  }
  if (hostname === "catalog.gog.com") return json({ products: GOG_PRODUCTS });
  return null;
}

/** A fetch that answers for every upstream the plugin talks to and records each request. */
function fakeFetch({ rpcs3Title = "Skate 3", sgdbGames = [], hang = false, steamApps = STEAM_APPS, steamDown = false } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const { hostname, pathname } = new URL(url);
    calls.push(`${init.method ?? "GET"} ${hostname}`);
    if (hang) return new Promise(() => {});
    if (steamDown && STEAM_HOSTS.has(hostname)) throw new Error("Steam is down");
    const pc = pcResponse(new URL(url), steamApps);
    if (pc) return pc;
    if (hostname === SONY_HOST) {
      return pathname.includes("BLUS30464") ? new Response(PATCH_XML) : new Response("", { status: 404 });
    }
    if (hostname === "rpcs3.net") {
      return json({ results: { BLUS30464: { title: rpcs3Title, status: "Playable" } } });
    }
    if (hostname === "raw.githubusercontent.com") return new Response(GAME_INDEX);
    if (hostname === "github.com") return json(SHAD_DB);
    if (hostname === "www.steamgriddb.com") {
      const steamId = /\/grids\/steam\/(\d+)$/.exec(pathname)?.[1];
      if (steamId) return json({ data: [{ url: `https://cdn2.steamgriddb.com/grid/steam-${steamId}.png` }] });
      return pathname.includes("/search/")
        ? json({ data: sgdbGames })
        : json({ data: [{ url: "https://cdn2.steamgriddb.com/grid/cover.png" }] });
    }
    if (hostname === "en.wikipedia.org") {
      const params = new URL(url).searchParams;
      // Only the Turkish Wikipedia has a translation of the article.
      if (params.get("prop") === "langlinks") {
        const links = params.get("lllang") === "tr" ? [{ lang: "tr", "*": "Skate 3 (oyun)" }] : [];
        return json({ query: { pages: { 1: { title: params.get("titles"), langlinks: links } } } });
      }
      return pathname.endsWith("/api.php")
        ? json({ query: { search: [{ title: "Skate 3" }] } })
        : json({ extract: "Skate 3 is a skateboarding video game." });
    }
    if (hostname === "tr.wikipedia.org" && pathname.endsWith("/Skate_3_(oyun)")) {
      return json({ extract: "Skate 3, bir kaykay video oyunudur." });
    }
    return new Response("", { status: 404 }); // emulator wikis: no page
  };
  fetcher.calls = calls;
  fetcher.to = (host) => calls.filter((call) => call.endsWith(` ${host}`)).length;
  return fetcher;
}

async function setup({ settings = {}, ...fetchOptions } = {}) {
  const fetcher = fakeFetch(fetchOptions);
  await _internals.clearCaches();
  slot.init({ template, fetch: fetcher });
  slot.configure(settings);
  return fetcher;
}

const context = { signProxyUrl: (url) => `/api/proxy/image?url=${encodeURIComponent(url)}` };
const run = (query) => slot.execute(query, context);
const nameOf = (html) => /class="ps3-name"[^>]*>([^<]*)</.exec(html)?.[1];

/** Every `{{ t:key }}` tag in the output must exist in locales/en.json; no `{{name}}` may be left. */
function assertTranslatable(html) {
  assert.doesNotMatch(html, /\{\{\w+\}\}/, "template placeholder left in the output");
  for (const [, key] of html.matchAll(/\{\{ t:([\w.-]+) \}\}/g)) {
    const value = key.split(".").reduce((node, part) => node?.[part], locale);
    assert.equal(typeof value, "string", `missing locale key ${key}`);
  }
}

/* --------------------------------- shape --------------------------------- */

test("exports match the degoog plugin contract", async () => {
  assert.equal(slot.id, "emu-compat");
  for (const field of slot.settingsSchema) {
    assert.equal(typeof field.default, "string", field.key);
    assert.equal(typeof locale[`${slot.id}-slot`].settings[field.key]?.label, "string", field.key);
  }
  assert.ok(slot.settingsSchema.some((field) => field.key === "pcPlainSearch"));
  assert.ok(slot.settingsSchema.some((field) => field.key === "pcMinReviews"));
  assert.ok(locale[`${slot.id}-slot`].settings, "settings labels are translated under the settings id");
  assert.ok(slot.slotPositions.includes(slot.position));
  assert.equal(slot.isClientExposed, false);
  assert.equal(slot.supportsNojs, true);

  assert.equal(command.trigger, "game");
  assert.match((await command.execute("", context)).html, /!game god of war/);
  assert.equal(command.supportsNojs, true);
});

test("only the slot is configured: degoog hands a command its own, empty settings", async () => {
  // Regression: a shared configure() on the command reset the API key and covers vanished.
  assert.equal(mod.plugin, undefined);
  assert.equal(command.configure, undefined);

  const settings = { steamGridDbApiKey: "key", showDescription: "false" };
  const fetcher = await setup({ settings, sgdbGames: [{ id: 2, name: "Persona 3" }] });
  command.init({ template, fetch: fetcher });
  assert.match((await command.execute("SLUS-21621", context)).html, /<img class="ps3-cover"/);
});

test("store manifest lists the plugin", async () => {
  const entry = manifest.plugins.find((item) => item.path === "plugins/emu-compat");
  assert.ok(entry);
  assert.equal(entry.type, "slot");
  assert.match(entry.version, /^\d+\.\d+\.\d+$/);
  await read(new URL(`${entry.path}/index.js`, root));
});

test("every locale has the same keys as en.json", async () => {
  const keys = (node, prefix = "") =>
    Object.entries(node).flatMap(([key, value]) =>
      typeof value === "object" ? keys(value, `${prefix}${key}.`) : [`${prefix}${key}`],
    );
  for (const file of await readdir(new URL("locales/", pluginUrl))) {
    const other = JSON.parse(await read(new URL(`locales/${file}`, pluginUrl)));
    assert.deepEqual(keys(other).sort(), keys(locale).sort(), file);
  }
});

/* -------------------------------- parsing -------------------------------- */

test("recognises title ids and nothing else", () => {
  const cases = {
    BLUS30464: "BLUS30464",
    "blus-30464": "BLUS30464",
    " BLES01807 ": "BLES01807",
    "CUSA-04762": "CUSA04762",
    slus20001: "SLUS-20001",
    "ALCH-0004": "ALCH-0004",
    "GWS-12345": "GWS-12345",
    BLUS304: null,
    BLUS304640: null,
    SLUS123456: null,
    SLUS12345678: null,
    "BLUS--30464": null,
    BLUS_30464: null,
    ABCD12345: null,
    steam12345: null,
  };
  for (const [query, id] of Object.entries(cases)) {
    assert.equal(_internals.identify(query)?.id ?? null, id, query);
  }
});

test("with plain search off, the slot triggers only when every word is a title id", () => {
  slot.configure({ pcPlainSearch: "false" });
  for (const query of ["BLUS30464", "BLUS30464 patch", "BLUS30464, BLES01807", "ps3 BLUS30464"]) {
    assert.equal(slot.trigger(query), true, query);
  }
  const negatives = ["", "patch", "skate 3", "BLUS 30464", "BLUS30464 skate", "https://x.test/BLUS30464"];
  for (const query of [...negatives, null, undefined, 30464]) {
    assert.equal(slot.trigger(query), false, String(query));
  }
  slot.configure({});
});

test("with plain search on, names trigger the slot too", () => {
  slot.configure({});
  for (const query of ["hollow knight", "skate 3", "BLUS30464"]) assert.equal(slot.trigger(query), true, query);
  for (const query of ["", "a", "god of war ps2", "x".repeat(61), null]) {
    assert.equal(slot.trigger(query), false, String(query));
  }
});

test("!game arguments: ids, names and the platform keyword", () => {
  const parse = _internals.parseBangArgs;
  assert.deepEqual(parse("BLUS30464 patch"), { kind: "ids", targets: [{ platform: "ps3", id: "BLUS30464" }] });
  assert.deepEqual(parse("god of war ps2"), {
    kind: "name",
    platforms: ["ps2"],
    title: "god of war",
    key: "godofwar",
  });
  assert.deepEqual(parse("skate").platforms, ["pc", "ps2", "ps3", "ps4"]);
  assert.equal(parse("god of war patch").title, "god of war", "trailing noise goes");
  assert.equal(parse("title fight").title, "title fight", "noise inside a name stays");
  assert.equal(parse("patch").title, "patch", "a name is never emptied");
  assert.equal(parse(""), null);
  assert.equal(parse("playstation 2"), null);
});

test("parses Sony's patch XML", () => {
  const { parseLookup } = _internals;
  assert.deepEqual(parseLookup("BLUS30464", PATCH_XML), { id: "BLUS30464", name: "Skate 3 DLC", version: "01.05" });
  assert.equal(parseLookup("BLES00001", PATCH_XML), null, "answer for another title");
  assert.equal(parseLookup("BLUS30464", PATCH_XML.replace("alive", "dead")), null);
  assert.equal(parseLookup("BLUS30464", '<titlepatch status="alive" titleid="BLUS30464"></titlepatch>'), null);
  assert.throws(() => parseLookup("BLUS30464", ""));
});

test("parses the PCSX2 index and ShadPS4 records", () => {
  const db = _internals.parseGameIndex(GAME_INDEX);
  assert.deepEqual(db.get("SLUS-21621"), { id: "SLUS-21621", name: "Persona 3", region: "NTSC-U", compat: 5 });
  assert.equal(db.get("SLPM-66445").name, "Persona 3 [Japan]", "name-en wins over name");
  assert.equal(_internals.regionOf("ps2", "SLPM-66445", "NTSC-J"), "jp");
  assert.equal(_internals.regionOf("ps2", "SLES-50000", ""), "eu", "falls back to the prefix");
  assert.equal(_internals.regionOf("ps3", "BLUS30464"), "us");

  const best = _internals.bestShadEntry(SHAD_DB.CUSA00900);
  assert.equal(best.os, "windows", "best status wins over the newest report");
  assert.equal(_internals.bestShadEntry(null), null);
});

/* ------------------------------- rendering ------------------------------- */

test("renders a PS3 card and caches the lookups", async () => {
  const fetcher = await setup();
  const { title, html } = await run("blus-30464");
  assert.equal(title, "");
  assert.equal(nameOf(html), "Skate 3");
  assert.match(html, />01\.05</);
  assert.match(html, /ps3-compat--playable/);
  assert.match(html, /Skate 3 is a skateboarding video game\./);
  assertTranslatable(html);

  const requests = fetcher.calls.length;
  assert.equal((await run("BLUS30464")).html, html);
  assert.equal(fetcher.calls.length, requests, "second search is served from the cache");
});

test("unknown ids render nothing", async () => {
  await setup();
  assert.deepEqual(await run("SLUS-99999"), { title: "", html: "" });
});

test("escapes upstream data", async () => {
  await setup({ rpcs3Title: '<img src=x onerror=alert(1)>{{ t:evil }}' });
  const { html } = await run("BLUS30464");
  assert.ok(!html.includes("<img src=x"), "markup from an API is escaped");
  assert.ok(!html.includes("{{ t:evil"), "an API cannot inject a translation tag");
});

test("Sony is not contacted while the version is hidden", async () => {
  const fetcher = await setup({ settings: { showVersion: "false" } });
  assert.equal(nameOf((await run("BLUS30464")).html), "Skate 3");
  assert.equal(fetcher.to(SONY_HOST), 0);
});

test("the card never links to Sony's update server", async () => {
  await setup({ settings: { showCompatibility: "false", showDescription: "false" } });
  const { html } = await run("BLUS30464");
  assert.equal(nameOf(html), "Skate 3 DLC");
  assert.ok(!html.includes(SONY_HOST));
  assert.match(html, /class="ps3-name" href="https:\/\/rpcs3\.net\/compatibility\?g=BLUS30464"/);
});

test("cover art needs an exact SteamGridDB name", async () => {
  const settings = { steamGridDbApiKey: "key", showDescription: "false" };

  await setup({ settings, sgdbGames: [{ id: 1, name: "Persona 3 Reload" }] });
  let { html } = await run("SLUS-21621");
  assert.equal(nameOf(html), "Persona 3", "a longer name is another game");
  assert.ok(!html.includes("<img"));

  await setup({ settings, sgdbGames: [{ id: 1, name: "Persona 3 Reload" }, { id: 2, name: "PERSONA 3" }] });
  ({ html } = await run("SLUS-21621"));
  assert.equal(nameOf(html), "PERSONA 3");
  assert.match(html, /<img class="ps3-cover" src="\/api\/proxy\/image\?url=https%3A%2F%2Fcdn2\.steamgriddb\.com/);
  assertTranslatable(html);
});

test("a card that misses the deadline is dropped", async (t) => {
  await setup({ hang: true });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = run("SLUS-21621");
  t.mock.timers.tick(8000);
  assert.deepEqual(await pending, { title: "", html: "" });
});

test("replacing the API key clears cached artwork, the first key does not", async () => {
  let cleared = 0;
  const cache = { get: async () => undefined, set: async () => {}, clear: async () => void cleared++ };
  await _internals.clearCaches();
  slot.configure({});
  slot.init({ template, fetch: fakeFetch(), useCache: () => cache });
  slot.configure({ steamGridDbApiKey: "first" });
  assert.equal(cleared, 0);
  slot.configure({ steamGridDbApiKey: "second" });
  await new Promise(setImmediate);
  assert.equal(cleared, 1);
  slot.configure({});
});

/* --------------------------------- !game ---------------------------------- */

test("!game lists title ids for a name", async () => {
  const fetcher = await setup();
  const { title, html } = await command.execute("persona ps2", context);
  assert.equal(title, "PlayStation 2: persona");
  assert.match(html, /SLUS-21621/);
  assert.match(html, /SLPM-66445/);
  assert.equal(fetcher.to("rpcs3.net"), 0, "a platform keyword keeps the search off other platforms");
  assertTranslatable(html);
});

test("!game renders cards for ids, a usage hint for nothing, a notice for no match", async () => {
  await setup();
  assert.match((await command.execute("CUSA00900", context)).html, /ps3-compat--playable/);

  for (const args of ["", "zzzz ps2"]) {
    const { html } = await command.execute(args, context);
    assert.match(html, /ps3-hint/);
    assertTranslatable(html);
  }
});

/* ----------------------------- PC providers ------------------------------ */

test("pcMatchKey strips marks and edition suffixes", () => {
  const { pcMatchKey } = _internals;
  assert.equal(pcMatchKey("DARK SOULS™: REMASTERED"), "darksouls");
  assert.equal(pcMatchKey("The Witcher 3: Wild Hunt – Game of the Year Edition"), "thewitcher3wildhunt");
  assert.equal(pcMatchKey("Portal 2"), "portal2");
});

test("searchPc strict keeps exact, popular matches", async () => {
  const fetcher = await setup();
  const games = await _internals.searchPc("hollow knight", "hollowknight", fetcher, { plain: { minReviews: 1000 } });
  assert.equal(games.length, 1);
  assert.deepEqual(games[0], {
    appid: 367520,
    name: "Hollow Knight",
    year: "2017",
    tags: ["Metroidvania", "Platformer", "Souls-like"],
    platforms: { linux: true, mac: true, windows: true },
    deck: 3,
    reviews: 509119,
    description: "Forge your own path in Hollow Knight!",
  });
});

test("searchPc loose lists name matches", async () => {
  const fetcher = await setup();
  const games = await _internals.searchPc("hollow knight", "hollowknight", fetcher, {});
  assert.deepEqual(games.map((game) => game.appid), [367520, 998, 999]);
  assert.equal(games[1].year, "", "no release date, no year");
});

test("protonTier and gogUrl", async () => {
  const fetcher = await setup();
  assert.equal(await _internals.protonTier(999, fetcher), "gold");
  assert.equal(await _internals.protonTier(367520, fetcher), null);
  assert.equal(await _internals.gogUrl("Hollow Knight", fetcher), "https://www.gog.com/en/game/hollow_knight");
  assert.equal(await _internals.gogUrl("Hollow Knight Fan Remake", fetcher), null);
});

/* ------------------------------ PC on !game ------------------------------ */

const bang = async (args) => (await command.execute(args, context)).html;
/** The tab panel (or the whole html, without tabs) that shows this game name. */
const panelOf = (html, name) =>
  html.split('class="ps3-tab-panel"').find((part) => part.includes(`>${name}<`)) ?? "";
const tabLabels = (html) => [...html.matchAll(/<label class="ps3-tab-label"[^>]*>([^<]*)</g)].map((m) => m[1]);

test("!game hollow knight pc renders tabs for PC matches", async () => {
  await setup();
  const html = await bang("hollow knight pc");
  assert.equal(html.match(/class="ps3-tab-input"/g)?.length, 3);
  assert.equal(tabLabels(html)[0], "Hollow Knight (PC, 2017)");
  assert.ok(tabLabels(html).includes("Hollow Knight Demo (PC)"), "no year, no year in the label");
  const panel = panelOf(html, "Hollow Knight");
  assert.match(panel, /Metroidvania · Platformer · Souls-like/);
  assert.match(panel, /labels\.steamDeck/);
  assert.match(panel, /href="https:\/\/www\.gog\.com\/en\/game\/hollow_knight"/);
  assert.match(panel, /href="https:\/\/store\.steampowered\.com\/app\/367520\/"/);
  assertTranslatable(html);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son\w+=/i);
});

test("platforms are alphabetical and Proton links to ProtonDB", async () => {
  await setup();
  const html = await bang("hollow knight pc");
  const remake = panelOf(html, "Hollow Knight Fan Remake");
  assert.ok(remake.indexOf("Linux") < remake.indexOf("macOS"));
  assert.ok(remake.indexOf("macOS") < remake.indexOf("Windows"));
  assert.match(remake, /<a [^>]*href="https:\/\/www\.protondb\.com\/app\/999"[^>]*>Linux \(Proton Gold\)<\/a>/);
  assert.doesNotMatch(panelOf(html, "Hollow Knight"), /protondb\.com/, "native Linux needs no Proton");
  assert.doesNotMatch(remake, /gog\.com/, "not sold on GOG");
});

test("ProtonDB 404 shows Linux ✗", async () => {
  await setup();
  const demo = panelOf(await bang("hollow knight pc"), "Hollow Knight Demo");
  assert.match(demo, /Linux ✗/);
  assert.doesNotMatch(demo, /protondb\.com/);
});

test("Steam Deck status is an icon whose text shows on hover or focus, unknown included", async () => {
  await setup();
  const html = await bang("hollow knight pc");
  const deck = (name) => /labels\.steamDeck[^]*?<\/dd>/.exec(panelOf(html, name))?.[0] ?? "";
  const verified = deck("Hollow Knight");
  assert.match(verified, /<span class="ps3-deck" tabindex="0"><svg class="ps3-deck-icon ps3-deck-icon--verified"[^>]*aria-hidden="true"/,
    "focusable, so keyboard and touch users can reveal the text too");
  assert.match(verified, /<\/svg><span class="ps3-deck-label">\{\{ t:plugin-emu-compat\.deck\.verified \}\}<\/span><\/span><\/dd>$/);
  assert.doesNotMatch(verified, /<title>/, "no second, native tooltip");
  assert.match(deck("Hollow Knight Demo"), /ps3-deck-icon--unknown[^]*deck\.unknown/);
  assertTranslatable(html);
});

test("single match has no tab bar", async () => {
  await setup();
  const html = await bang("hollow knight fan remake pc");
  assert.doesNotMatch(html, /ps3-tab-input/);
  assert.match(html, />Hollow Knight Fan Remake</);
});

test("pc keyword only counts as the last word", () => {
  const parse = _internals.parseBangArgs;
  assert.deepEqual(parse("pc building simulator").platforms, ["pc", "ps2", "ps3", "ps4"]);
  assert.equal(parse("pc building simulator").title, "pc building simulator");
  assert.deepEqual(parse("doom pc").platforms, ["pc"]);
  assert.equal(parse("doom pc").title, "doom");
});

test("!game without keyword: PC tab first, PS tabs after", async () => {
  await setup();
  let html = await bang("persona");
  assert.doesNotMatch(html, /ps3-tab-input/, "PS2 alone needs no tabs");
  assert.match(html, /SLUS-21621/);

  await setup({ steamApps: { 2161700: { name: "Persona 3 Reload", reviews: 30000, year: 2024, deck: 3, tagids: [],
    platforms: { windows: true, mac: false, steamos_linux: false } } } });
  html = await bang("persona");
  assert.deepEqual(tabLabels(html), ["Persona 3 Reload (PC, 2024)", "Persona 3 (PS2)"]);
});

test("Steam failing keeps PS results", async () => {
  await setup({ steamDown: true });
  assert.match(await bang("persona"), /SLUS-21621/);
});

test("two tab blocks never share radio names", async () => {
  await setup();
  const names = (html) => new Set([...html.matchAll(/name="(ps3-tabs-[^"]+)"/g)].map((m) => m[1]));
  const first = names(await bang("hollow knight pc"));
  const second = names(await bang("hollow knight pc"));
  assert.equal(first.size, 1);
  assert.ok(![...first].some((name) => second.has(name)));
});

/* --------------------------- PC on plain search --------------------------- */

test("plain search shows popular exact matches", async () => {
  await setup({ settings: { showDescription: "false" } });
  for (const query of ["hollow knight", "Hollow Knight"]) {
    const { html } = await run(query);
    assert.equal(nameOf(html), "Hollow Knight", query);
    assert.doesNotMatch(html, /ps3-tab-input/, "one match, no tabs");
    assertTranslatable(html);
  }
});

test("plain search ignores unpopular and partial matches", async () => {
  await setup();
  for (const query of ["hollow knight fan remake", "holl", "python tutorial"]) {
    assert.deepEqual(await run(query), { title: "", html: "" }, query);
  }
});

test("pcMinReviews is respected", async () => {
  await setup({ settings: { pcMinReviews: "10" } });
  assert.equal(nameOf((await run("hollow knight fan remake")).html), "Hollow Knight Fan Remake");
  await setup({ settings: { pcMinReviews: "abc" } });
  assert.equal((await run("hollow knight fan remake")).html, "", "an invalid value means 1000");
});

test("no Steam request when it should not search", async () => {
  let fetcher = await setup({ settings: { pcPlainSearch: "false" } });
  assert.equal((await run("hollow knight")).html, "");
  assert.equal(fetcher.to("store.steampowered.com"), 0);

  fetcher = await setup();
  await run("BLUS30464");
  await run("god of war ps2");
  assert.equal(fetcher.to("store.steampowered.com"), 0);
});

test("plain search survives Steam failure", async () => {
  await setup({ steamDown: true });
  assert.deepEqual(await run("hollow knight"), { title: "", html: "" });
});

test("a slow plain search gives up after the card deadline", async (t) => {
  // Steam answers slowly (4 s each), GOG never answers: without an overall deadline this takes ~13 s.
  const slow = fakeFetch();
  const fetcher = (url, init) => {
    const { hostname } = new URL(url);
    if (hostname === "catalog.gog.com") return new Promise(() => {});
    if (STEAM_HOSTS.has(hostname)) return new Promise((resolve) => setTimeout(() => resolve(slow(url, init)), 4000));
    return slow(url, init);
  };
  await _internals.clearCaches();
  slot.init({ template, fetch: fetcher });
  slot.configure({});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const pending = run("hollow knight").finally(() => (settled = true));
  for (let second = 0; second < 9; second += 1) {
    await new Promise(setImmediate);
    t.mock.timers.tick(1000);
  }
  await new Promise(setImmediate);
  assert.ok(settled, "answered within 9 seconds");
  assert.deepEqual(await pending, { title: "", html: "" });
});

/* ------------------------- PC description (Steam) ------------------------- */

test("steamLanguage maps browser locales to Steam languages", () => {
  const { steamLanguage } = _internals;
  const cases = {
    tr: "turkish", "tr-TR": "turkish", de: "german", "pt-BR": "brazilian", "pt-PT": "portuguese",
    "zh-TW": "tchinese", "zh-CN": "schinese", "es-ES": "spanish", "es-MX": "latam", ko: "koreana",
    xx: "english", "": "english", undefined: "english",
  };
  for (const [locale, language] of Object.entries(cases)) {
    assert.equal(steamLanguage(locale === "undefined" ? undefined : locale), language, locale);
  }
});

test("PC card shows Steam's short description in the visitor's language", async () => {
  const fetcher = await setup();
  const tr = (await command.execute("hollow knight pc", { ...context, locale: "tr-TR" })).html;
  const hk = panelOf(tr, "Hollow Knight");
  assert.match(hk, /<p class="ps3-description">Hollow Knight&#39;ta kendi yolunu çiz!<\/p>/);
  assert.doesNotMatch(tr, /\[turkish\]/, "the card keeps Steam's English name");
  assert.equal(fetcher.to("en.wikipedia.org"), 0, "PC cards do not ask Wikipedia");

  const en = panelOf(await bang("hollow knight pc"), "Hollow Knight");
  assert.match(en, /Forge your own path in Hollow Knight!/, "no locale means English");
});

test("PC description falls back to English and follows showDescription", async () => {
  await setup();
  const de = (await command.execute("hollow knight pc", { ...context, locale: "de" })).html;
  assert.match(panelOf(de, "Hollow Knight"), /Forge your own path in Hollow Knight!/);

  await setup({ settings: { showDescription: "false" } });
  assert.doesNotMatch(await bang("hollow knight pc"), /ps3-description/);
});

test("PC cover comes from SteamGridDB by Steam app id, not by name", async () => {
  // Regression: a name search put the 2005 PS2 "God of War" cover on the 2018 PC game.
  const settings = { steamGridDbApiKey: "key", showDescription: "false" };
  await setup({ settings, sgdbGames: [{ id: 5, name: "Hollow Knight" }] });
  const panel = panelOf(await bang("hollow knight pc"), "Hollow Knight");
  assert.match(panel, /<img class="ps3-cover" src="\/api\/proxy\/image\?url=https%3A%2F%2Fcdn2\.steamgriddb\.com%2Fgrid%2Fsteam-367520\.png"/);
  assert.doesNotMatch(panel, /cover\.png/);
});

const PERSONA_ON_STEAM = {
  2161700: { name: "Persona 3", reviews: 5000, year: 2024, deck: 3, tagids: [],
    platforms: { windows: true, mac: false, steamos_linux: false } },
};

test("plain search adds exact PlayStation matches as tabs", async () => {
  await setup({ steamApps: PERSONA_ON_STEAM, settings: { showDescription: "false" } });
  const { html } = await run("persona 3");
  assert.deepEqual(tabLabels(html), ["Persona 3 (PC, 2024)", "Persona 3 (PS2)"]);
  const ps2 = html.split('class="ps3-tab-panel"')[2] ?? "";
  assert.match(ps2, /SLUS-21621/);
  assert.doesNotMatch(ps2, /SLPM-66445/, "\"Persona 3 [Japan]\" is not the exact name");
  assertTranslatable(html);
});

test("plain search shows no PlayStation tab without a popular PC match", async () => {
  const fetcher = await setup();
  assert.deepEqual(await run("persona 3"), { title: "", html: "" });
  assert.equal(fetcher.to("rpcs3.net"), 0, "PlayStation sources are not asked");
});

/* ---------------------- PlayStation tabs as full cards --------------------- */

test("bestRow prefers compatibility, then US, Europe, Japan", () => {
  const { bestRow } = _internals;
  const row = (id, region, tone) => ({ id, region, tone });
  assert.equal(bestRow([row("A", "jp", "playable"), row("B", "us", "ingame")]).id, "A", "compatibility first");
  assert.equal(bestRow([row("A", "jp", "playable"), row("B", "eu", "playable"), row("C", "us", "playable")]).id, "C");
  assert.equal(bestRow([row("A", "asia", "unknown"), row("B", "jp", "unknown")]).id, "B");
  assert.equal(bestRow([row("A", null, "unknown")]).id, "A");
});

test("a PlayStation result is a card for its best title id, the others listed below", async () => {
  await setup();
  const { title, html } = await command.execute("persona ps2", context);
  assert.equal(title, "PlayStation 2: persona");
  assert.equal(nameOf(html), "Persona 3");
  assert.match(html, /<span class="ps3-id">SLUS-21621<\/span>/, "the playable US release gets the card");
  assert.match(/<details[^]*<\/details>/.exec(html)?.[0] ?? "", /SLUS-21782/, "a better-rated other game stays in the list");
  assert.match(html, /ps3-compat--playable/);
  const others = /<details class="ps3-card ps3-others">([^]*?)<\/details>/.exec(html)?.[1] ?? "";
  assert.match(others, /^<summary class="ps3-others-toggle">\{\{ t:plugin-emu-compat\.nameSearch\.showOtherIds \}\} \(2\)<\/summary>/,
    "closed by default, the button names the count");
  assert.match(others, /SLPM-66445/);
  assert.doesNotMatch(others, /SLUS-21621/, "the card's id is not listed twice");
  assert.doesNotMatch(html, /nameSearch\.hint/, "no 'use a title id' hint under a card");
  assertTranslatable(html);
});

test("browserLanguage off keeps PC descriptions in English", async () => {
  await setup({ settings: { browserLanguage: "false" } });
  const html = (await command.execute("hollow knight pc", { ...context, locale: "tr-TR" })).html;
  assert.match(panelOf(html, "Hollow Knight"), /Forge your own path in Hollow Knight!/);
  assert.doesNotMatch(html, /kendi yolunu/);
});

/* ------------------- PlayStation description in the visitor's language ------------------- */

const description = (html) => /<p class="ps3-description">([^<]*)<\/p>/.exec(html)?.[1];

test("wikiLanguage keeps only a plain language code", () => {
  const { wikiLanguage } = _internals;
  const cases = { "tr-TR": "tr", tr: "tr", "pt_BR": "pt", EN: "en", x: "en", "../evil": "en", "tr.evil.com": "en", "": "en" };
  for (const [locale, language] of Object.entries(cases)) assert.equal(wikiLanguage(locale), language, locale);
  assert.equal(wikiLanguage(undefined), "en");
});

test("PS description comes from the visitor's Wikipedia when it has the article", async () => {
  await setup();
  const { html } = await slot.execute("BLUS30464", { ...context, locale: "tr-TR" });
  assert.equal(description(html), "Skate 3, bir kaykay video oyunudur.");
  assert.match(html, /href="https:\/\/tr\.wikipedia\.org\/wiki\/Skate_3_\(oyun\)"/, "read more opens the Turkish page");
});

test("PS description falls back to English, and stays English with browserLanguage off", async () => {
  await setup();
  let { html } = await slot.execute("BLUS30464", { ...context, locale: "de" });
  assert.equal(description(html), "Skate 3 is a skateboarding video game.", "no German article");

  const fetcher = await setup({ settings: { browserLanguage: "false" } });
  ({ html } = await slot.execute("BLUS30464", { ...context, locale: "tr-TR" }));
  assert.equal(description(html), "Skate 3 is a skateboarding video game.");
  assert.equal(fetcher.to("tr.wikipedia.org"), 0);
});

test("browserLanguage off renders the plugin's own text in English", async () => {
  await setup({ settings: { browserLanguage: "false", showDescription: "false" } });
  const { html } = await run("BLUS30464");
  assert.doesNotMatch(html, /\{\{ t:/, "no translation tags left for degoog to localise");
  assert.match(html, />Playable</);
  assert.match(html, />RPCS3 compatibility</);
  const pc = await bang("hollow knight pc");
  assert.doesNotMatch(pc, /\{\{ t:/);
  assert.match(pc, /class="ps3-deck-label">Verified</);
});

test("plain search ignores a trailing 'game' / 'video game' / 'oyunu'", async () => {
  await setup({ settings: { showDescription: "false" } });
  for (const query of ["hollow knight game", "Hollow Knight video game", "hollow knight videogame", "hollow knight oyunu"]) {
    assert.equal(nameOf((await run(query)).html), "Hollow Knight", query);
  }
  assert.deepEqual(await run("game"), { title: "", html: "" });
});

test("a game whose name ends in 'game' still matches as typed", async () => {
  await setup({
    settings: { showDescription: "false" },
    steamApps: { 837470: { name: "Untitled Goose Game", reviews: 40000, year: 2020, deck: 3, tagids: [],
      platforms: { windows: true, mac: true, steamos_linux: false } } },
  });
  assert.equal(nameOf((await run("untitled goose game")).html), "Untitled Goose Game");
});

/* ------------------- plain search: similarity tiers, intent ------------------- */

const app = (name, reviews, year) => ({
  name, reviews, year, deck: 0, tagids: [], platforms: { windows: true, mac: false, steamos_linux: false },
});
const plainNames = async (query) => {
  const { html } = await run(query);
  return [...html.matchAll(/class="ps3-name"[^>]*>([^<]*)</g)].map((m) => m[1]);
};

test("plain search shows a popular game that starts with the search, word by word", async () => {
  await setup({ settings: { showDescription: "false" } });
  assert.deepEqual(await plainNames("hollow"), ["Hollow Knight"], "509k reviews, unpopular look-alikes stay out");
  assert.deepEqual(await plainNames("holl"), [], "half a word is not a match");
});

test("a looser match needs more reviews than an exact one", async () => {
  const settings = { showDescription: "false" };
  await setup({ settings, steamApps: { 10: app("Dark Souls", 2000, 2011), 11: app("Dark Souls III", 2500, 2016) } });
  assert.deepEqual(await plainNames("dark souls"), ["Dark Souls"], "the sequel needs 3x the limit");
  await setup({ settings, steamApps: { 10: app("Dark Souls", 2000, 2011), 11: app("Dark Souls III", 5000, 2016) } });
  assert.deepEqual(await plainNames("dark souls"), ["Dark Souls", "Dark Souls III"]);
});

test("a game word skips the review limit, so an unreleased game shows only then", async () => {
  await setup({ settings: { showDescription: "false" }, steamApps: { 20: app("Starfall Tactics", 0) } });
  assert.deepEqual(await plainNames("starfall tactics"), []);
  assert.deepEqual(await plainNames("starfall tactics game"), ["Starfall Tactics"]);
  assert.deepEqual(await plainNames("starfall tactics oyunu"), ["Starfall Tactics"]);
});

test("searches that are clearly not about a game never reach Steam", async () => {
  const fetcher = await setup();
  for (const query of ["how to fix wifi", "weather istanbul", "recipe for pancakes", "https://example.com", "what is the meaning of life"]) {
    assert.deepEqual(await run(query), { title: "", html: "" }, query);
  }
  assert.equal(fetcher.to("store.steampowered.com"), 0);
});

test("pcMinReviews is a number field", () => {
  const field = slot.settingsSchema.find((item) => item.key === "pcMinReviews");
  assert.equal(field.type, "number");
  assert.equal(field.min, "0");
});


test("pcLooseMatches off keeps plain search to the exact name", async () => {
  const settings = { showDescription: "false", pcLooseMatches: "false" };
  await setup({ settings });
  assert.deepEqual(await plainNames("hollow"), []);
  assert.deepEqual(await plainNames("hollow game"), [], "a game word does not bring partial names back");
  assert.deepEqual(await plainNames("hollow knight"), ["Hollow Knight"]);
  await setup({ settings, steamApps: { 10: app("Dark Souls", 2000, 2011), 11: app("Dark Souls III", 50000, 2016) } });
  assert.deepEqual(await plainNames("dark souls"), ["Dark Souls"]);
});
