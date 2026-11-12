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
`;
const SHAD_DB = {
  CUSA00900: {
    linux: { name: "Bloodborne", status: "status-ingame", issue_number: "7", last_tested: "2026-01-01" },
    windows: { name: "Bloodborne", status: "status-playable", issue_number: "9", last_tested: "2025-01-01" },
  },
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

/** A fetch that answers for every upstream the plugin talks to and records each request. */
function fakeFetch({ rpcs3Title = "Skate 3", sgdbGames = [], hang = false } = {}) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const { hostname, pathname } = new URL(url);
    calls.push(`${init.method ?? "GET"} ${hostname}`);
    if (hang) return new Promise(() => {});
    if (hostname === SONY_HOST) {
      return pathname.includes("BLUS30464") ? new Response(PATCH_XML) : new Response("", { status: 404 });
    }
    if (hostname === "rpcs3.net") {
      return json({ results: { BLUS30464: { title: rpcs3Title, status: "Playable" } } });
    }
    if (hostname === "raw.githubusercontent.com") return new Response(GAME_INDEX);
    if (hostname === "github.com") return json(SHAD_DB);
    if (hostname === "www.steamgriddb.com") {
      return pathname.includes("/search/")
        ? json({ data: sgdbGames })
        : json({ data: [{ url: "https://cdn2.steamgriddb.com/grid/cover.png" }] });
    }
    if (hostname === "en.wikipedia.org") {
      return pathname.endsWith("/api.php")
        ? json({ query: { search: [{ title: "Skate 3" }] } })
        : json({ extract: "Skate 3 is a skateboarding video game." });
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

test("exports match the degoog plugin contract", () => {
  assert.equal(slot.id, "emu-compat");
  for (const field of slot.settingsSchema) assert.equal(typeof field.default, "string", field.key);
  assert.ok(locale[`${slot.id}-slot`].settings, "settings labels are translated under the settings id");
  assert.ok(slot.slotPositions.includes(slot.position));
  assert.equal(slot.isClientExposed, false);
  assert.equal(slot.supportsNojs, true);

  assert.equal(command.trigger, "emu");
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

test("the slot triggers only when every word is a title id", () => {
  for (const query of ["BLUS30464", "BLUS30464 patch", "BLUS30464, BLES01807", "ps3 BLUS30464"]) {
    assert.equal(slot.trigger(query), true, query);
  }
  const negatives = ["", "patch", "skate 3", "BLUS 30464", "BLUS30464 skate", "https://x.test/BLUS30464"];
  for (const query of [...negatives, null, undefined, 30464]) {
    assert.equal(slot.trigger(query), false, String(query));
  }
});

test("!emu arguments: ids, names and the platform keyword", () => {
  const parse = _internals.parseBangArgs;
  assert.deepEqual(parse("BLUS30464 patch"), { kind: "ids", targets: [{ platform: "ps3", id: "BLUS30464" }] });
  assert.deepEqual(parse("god of war ps2"), {
    kind: "name",
    platforms: ["ps2"],
    title: "god of war",
    key: "godofwar",
  });
  assert.deepEqual(parse("skate").platforms, ["ps2", "ps3", "ps4"]);
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

/* --------------------------------- !emu ---------------------------------- */

test("!emu lists title ids for a name", async () => {
  const fetcher = await setup();
  const { title, html } = await command.execute("persona ps2", context);
  assert.equal(title, "PlayStation 2: persona");
  assert.match(html, /SLUS-21621/);
  assert.match(html, /SLPM-66445/);
  assert.equal(fetcher.to("rpcs3.net"), 0, "a platform keyword keeps the search off other platforms");
  assertTranslatable(html);
});

test("!emu renders cards for ids, a usage hint for nothing, a notice for no match", async () => {
  await setup();
  assert.match((await command.execute("CUSA00900", context)).html, /ps3-compat--playable/);

  for (const args of ["", "zzzz ps2"]) {
    const { html } = await command.execute(args, context);
    assert.match(html, /ps3-hint/);
    assertTranslatable(html);
  }
});
