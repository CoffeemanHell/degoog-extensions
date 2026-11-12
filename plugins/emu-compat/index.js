/**
 * EmuCompat - a degoog slot plugin.
 *
 * Recognises a PlayStation title ID (PS2 / PS3 / PS4) in the search bar and renders an
 * "at a glance" card with the game name, cover art (SteamGridDB), emulator compatibility
 * (RPCS3, PCSX2, ShadPS4), the latest PS3 patch version (Sony) and a Wikipedia summary.
 *
 * Contract: https://degoog-org.github.io/docs/developer.html (slot plugins)
 * Strings:  locales/<lang>.json, rendered with the server-side `{{ t:key }}` syntax
 *
 * Substantially inspired by https://github.com/EthanC/degoog-extensions (AGPL-3.0).
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { get as httpsGet } from "node:https";

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const PLUGIN_ID = "emu-compat";
/** Top-level key of locales/<lang>.json: "plugin-<plugin name>" (degoog translation docs). */
const I18N_NAMESPACE = `plugin-${PLUGIN_ID}`;
const USER_AGENT = "degoog-emu-compat";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const HTTP_TIMEOUT_MS = 5 * 1000;
const DB_TIMEOUT_MS = 30 * 1000;
// shortcut: a card that misses this deadline is dropped whole (its lookups keep running and
// fill the cache for the next search); render it without the slow extras if that gets common.
const CARD_TIMEOUT_MS = 8 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DB_BYTES = 64 * 1024 * 1024;
const CACHE_ENTRY_LIMIT = 500;
const DB_TTL_MS = DAY_MS;
const ERROR_TTL_MS = 5 * MINUTE_MS;

/** Cache lifetimes per lookup kind: found / not found / upstream failure. */
const ttl = (hit, miss = HOUR_MS) => ({ hit, miss, error: ERROR_TTL_MS });
const TTL = Object.freeze({
  patch: ttl(6 * HOUR_MS),
  rpcs3: ttl(DAY_MS),
  wiki: ttl(DAY_MS, 6 * HOUR_MS),
  emuWiki: ttl(DAY_MS, 6 * HOUR_MS),
  artwork: ttl(DAY_MS),
});

const SONY_PATCH_HOST = "a0.ww.np.dl.playstation.net";
const sonyPatchUrl = (id) => `https://${SONY_PATCH_HOST}/tpl/np/${id}/${id}-ver.xml`;
/** Hosts whose certificate fails standard TLS validation (Sony's update CDN). */
const INSECURE_TLS_HOSTS = new Set([SONY_PATCH_HOST]);

const PCSX2_INDEX_URL =
  "https://raw.githubusercontent.com/PCSX2/pcsx2/master/bin/resources/GameIndex.yaml";
const PCSX2_COMPAT_URL = "https://pcsx2.net/compatibility-list.html";

const SHAD_REPO_URL = "https://github.com/shadps4-compatibility/shadps4-game-compatibility";
/** Newest published snapshot (a release-pinned URL goes stale and eventually answers 404). */
const SHAD_DB_URLS = [`${SHAD_REPO_URL}/releases/latest/download/compatibility_data.json`];
/** ShadPS4 statuses from worst to best (the "status-" prefix is stripped before lookup). */
const SHAD_STATUS_ORDER = ["nothing", "boots", "menus", "ingame", "playable"];

const SGDB_API_URL = "https://www.steamgriddb.com/api/v2";
const SGDB_DOMAIN = "steamgriddb.com";
const SGDB_GRID_DIMENSIONS = "600x900,342x482,460x215,920x430,660x930,512x512,1024x1024";
const ARTWORK_EDITION_SUFFIX =
  /\s+\b(?:DLC|Update|Patch|Complete Edition|Remastered|Remaster|Deluxe|GOTY|TS)\b.*$/i;
const ARTWORK_ABBREVIATIONS = Object.freeze({
  doa: "dead or alive",
  gow: "god of war",
  gta: "grand theft auto",
  mgs: "metal gear solid",
  ff: "final fantasy",
  re: "resident evil",
  sotc: "shadow of the colossus",
  rac: "ratchet and clank",
  sly: "sly cooper",
});

const PS3_PREFIXES = new Set([
  "BLES", "BLUS", "BCES", "BCUS", "BLJM", "BLAS", "BLKS", "BCJS", "BCAS",
  "NPEB", "NPUB", "NPJB", "NPAB", "NPHB", "NPMB", "NPRB", "NPEG", "NPUG",
]);
const PS2_PREFIXES = new Set([
  "ALCH", "CPCS", "FVGK", "GUST", "GWS", "PAPX", "PBGP", "PBPX", "PCPX", "PDPX", "PSXC",
  "PUPX", "SCAJ", "SCCS", "SCED", "SCES", "SCKA", "SCPM", "SCPN", "SCPS", "SCUS", "SLAJ",
  "SLED", "SLES", "SLKA", "SLPM", "SLPS", "SLUF", "SLUS", "SRPM", "TCES", "TCPS", "TLES",
]);
const PS4_PREFIXES = new Set(["CUSA"]);

/**
 * Checked in order; the first rule whose pattern and prefix both match wins.
 * PS2 serials in PCSX2's index have 5 digits, a handful have 4 ("ALCH-0004").
 */
const ID_RULES = [
  { platform: "ps2", prefixes: PS2_PREFIXES, pattern: /^([A-Z]{3,4})-?(\d{4,5})$/, join: (p, n) => `${p}-${n}` },
  { platform: "ps4", prefixes: PS4_PREFIXES, pattern: /^([A-Z]{4})-?(\d{5})$/, join: (p, n) => `${p}${n}` },
  { platform: "ps3", prefixes: PS3_PREFIXES, pattern: /^([A-Z]{4})-?(\d{5})$/, join: (p, n) => `${p}${n}` },
];

/** Every compatibility level any of the three emulators can report (CSS: .ps3-compat--<tone>). */
const COMPAT_TONES = new Set([
  "unknown", "nothing", "loadable", "intro", "boots", "menus", "ingame", "playable", "perfect",
]);
/** PCSX2 stores its compatibility rating as a number from 0 to 6. */
const PCSX2_TONES = ["unknown", "nothing", "intro", "menus", "ingame", "playable", "perfect"];

/** At most this many title IDs are rendered for one query ("BLUS30443 BLES00123 ..."). */
const MAX_TARGETS = 4;
const MAX_NAME_RESULTS = 8;
const RPCS3_SEARCH_LIMIT = 25;
/** A bang needs at least this many letters/digits of a name before it searches. */
const NAME_MIN_LENGTH = 2;

/** "ps3", "PS 4", "playstation 2": narrows an `!emu` search to one platform. */
const PLATFORM_KEYWORD = /\b(?:ps|playstation)\s?([234])\b/gi;
/** Words that may accompany a title ID or name without being part of it ("BLUS30443 patch"). */
const QUERY_NOISE_WORDS = new Set([
  "patch", "patches", "update", "updates", "id", "ids", "serial", "title", "compat", "compatibility",
]);

const ALL_PLATFORMS = Object.freeze(["ps2", "ps3", "ps4"]);
const PLATFORM_LABELS = Object.freeze({
  ps2: "PlayStation 2",
  ps3: "PlayStation 3",
  ps4: "PlayStation 4",
});

/**
 * Emulator wikis (both MediaWiki). A page is only linked after a request confirms it exists.
 * PS3 is not listed: its compatibility rows already link to the RPCS3 wiki and compat list.
 */
const EMULATOR_WIKIS = Object.freeze({
  ps2: (title) => `https://wiki.pcsx2.net/${wikiSlug(title)}`,
  ps4: (title) => `https://wiki.shadps4.net/index.php?title=${wikiSlug(title)}`,
});

/** PS2 product code prefixes whose region is certain; used when PCSX2's own field is unusable. */
const PS2_REGION_BY_PREFIX = Object.freeze({
  SLUS: "us", SCUS: "us",
  SLES: "eu", SCES: "eu", SCED: "eu", SLED: "eu", TCES: "eu", TLES: "eu",
  SLPS: "jp", SLPM: "jp", SCPS: "jp", SCPM: "jp", SCPN: "jp",
  SLAJ: "asia", SCAJ: "asia",
  SLKA: "kr", SCKA: "kr",
});

/** Third letter of a PS3 product code: U = US, E = Europe, J = Japan, A/H = Asia, K = Korea. */
const PS3_REGION_BY_LETTER = Object.freeze({ U: "us", E: "eu", J: "jp", A: "asia", H: "asia", K: "kr" });

const EMPTY_RESULT = Object.freeze({ title: "", html: "" });
const EXTERNAL_ICON =
  '<i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>';

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

/** Single source of truth: the toggle defaults below are derived from this schema. */
const settingsSchema = [
  {
    key: "showCover",
    label: "Show cover art",
    type: "toggle",
    default: "true",
    fieldset: "Cover art",
    description: "Show the game's cover art from SteamGridDB. Requires an API key.",
  },
  {
    key: "steamGridDbApiKey",
    label: "SteamGridDB API key",
    type: "password",
    secret: true,
    default: "",
    fieldset: "Cover art",
    description: "Required for cover art. Cover art stays disabled while this is empty.",
    visibleWhen: { key: "showCover", equals: "true" },
  },
  {
    key: "showDescription",
    label: "Show Wikipedia description",
    type: "toggle",
    default: "true",
    fieldset: "Content",
    description: "Show the short Wikipedia summary for the title.",
  },
  {
    key: "showRegion",
    label: "Show region badge",
    type: "toggle",
    default: "true",
    fieldset: "Content",
    description: "Show the release region (US, EU, JP, ...) next to the title ID.",
  },
  {
    key: "showDetails",
    label: "Show details",
    type: "toggle",
    default: "true",
    fieldset: "Content",
    description: "List the detail rows (compatibility, version) below the title.",
  },
  {
    key: "showCompatibility",
    label: "Show RPCS3 / ShadPS4 compatibility",
    type: "toggle",
    default: "true",
    fieldset: "Content",
    description: "Look up PS3 titles in the RPCS3 database and PS4 titles in the ShadPS4 database.",
    visibleWhen: { key: "showDetails", equals: "true" },
  },
  {
    key: "showCompat",
    label: "Show PCSX2 compatibility",
    type: "toggle",
    default: "true",
    fieldset: "Content",
    description: "Show the PCSX2 compatibility rating for PS2 titles.",
    visibleWhen: { key: "showDetails", equals: "true" },
  },
  {
    key: "showVersion",
    label: "Show version",
    type: "toggle",
    default: "true",
    fieldset: "Content",
    description:
      "Show the latest PS3 update version. Sony's update server is only contacted while this is on.",
    visibleWhen: { key: "showDetails", equals: "true" },
  },
];

const DEFAULT_SETTINGS = Object.freeze(
  Object.fromEntries(
    settingsSchema.map((field) => [
      field.key,
      field.type === "toggle" ? field.default === "true" : (field.default ?? ""),
    ]),
  ),
);

/* -------------------------------------------------------------------------- */
/* Module state (filled by init() / configure())                              */
/* -------------------------------------------------------------------------- */

let template = "";
let pluginFetch = null;
let cacheFactory = null;
let settings = { ...DEFAULT_SETTINGS };

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

const isDebug = () => String(globalThis.process?.env?.LOG_LEVEL ?? "").toLowerCase() === "debug";
const debug = (...args) => {
  if (isDebug()) console.debug(`[${PLUGIN_ID}]`, ...args);
};

/** Runs a best-effort async step (cache I/O): failures are logged, never thrown. */
async function safely(task) {
  try {
    return await task();
  } catch (error) {
    debug("non-fatal error:", error);
    return undefined;
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Escapes text for HTML. `{{` is neutralised so API data can never inject a template tag. */
const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{\{/g, "&#123;&#123;");

const hostMatches = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

/** Returns a normalised http(s) URL, or "" when the value is not a safe link. */
function safeUrl(value, domain) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (domain && !hostMatches(url.hostname, domain)) return "";
    return url.href;
  } catch {
    return "";
  }
}

const normalizeName = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const parseToggle = (value, fallback) => {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return fallback;
};

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

async function readResponse(response, maxBytes, headOnly = false) {
  if (!response) throw new Error("empty response");
  if (headOnly) {
    await response.body?.cancel?.().catch(() => {});
    const status = Number(response.status) || 0;
    return { status, ok: status >= 200 && status < 300, text: "" };
  }
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response too large (${declared} bytes)`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) throw new Error(`response too large (${buffer.byteLength} bytes)`);
  const status = Number(response.status) || 0;
  return {
    status,
    ok: typeof response.ok === "boolean" ? response.ok : status >= 200 && status < 300,
    text: new TextDecoder().decode(buffer),
  };
}

/** Native request with certificate validation disabled. Only used for INSECURE_TLS_HOSTS. */
function insecureGet(url, { headers, timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(
      url,
      { headers, rejectUnauthorized: false, timeout: timeoutMs },
      (response) => {
        const chunks = [];
        let received = 0;
        response.on("data", (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            request.destroy(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            text: Buffer.concat(chunks).toString("utf8"),
          });
        });
        response.on("error", reject);
      },
    );
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

function allowsInsecureTls(url) {
  try {
    return INSECURE_TLS_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * GET a URL through degoog's proxy-aware fetch (ctx.fetch). Certificate validation is only
 * bypassed for hosts listed in INSECURE_TLS_HOSTS; every other failure is thrown.
 *
 * @returns {Promise<{status: number, ok: boolean, text: string}>}
 */
async function httpGet(url, options = {}) {
  const {
    fetcher,
    method = "GET",
    headers = {},
    timeoutMs = HTTP_TIMEOUT_MS,
    maxBytes = MAX_BODY_BYTES,
  } = options;
  const requestHeaders = { "User-Agent": USER_AGENT, ...headers };
  const send = typeof fetcher === "function" ? fetcher : (...args) => globalThis.fetch(...args);
  try {
    return await withTimeout(
      (async () =>
        readResponse(
          await send(url, {
            method,
            headers: requestHeaders,
            signal: AbortSignal.timeout(timeoutMs),
          }),
          maxBytes,
          method === "HEAD",
        ))(),
      timeoutMs,
    );
  } catch (error) {
    if (!allowsInsecureTls(url)) throw error;
    debug(`retrying ${url} without certificate validation:`, error);
    return withTimeout(
      insecureGet(url, { headers: requestHeaders, timeoutMs, maxBytes }),
      timeoutMs,
    );
  }
}

/** GET + JSON.parse. Resolves null on 404, throws on any other non-2xx status. */
async function getJson(url, options = {}) {
  const response = await httpGet(url, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return JSON.parse(response.text);
}

/* -------------------------------------------------------------------------- */
/* Caching (ctx.useCache with an in-memory fallback)                          */
/* -------------------------------------------------------------------------- */

function createMemoryCache(defaultTtlMs, limit = CACHE_ENTRY_LIMIT) {
  const entries = new Map();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    async set(key, value, ttlMs = defaultTtlMs) {
      entries.delete(key);
      if (entries.size >= limit) entries.delete(entries.keys().next().value);
      entries.set(key, { value, expires: Date.now() + ttlMs });
    },
    async delete(key) {
      entries.delete(key);
    },
    async clear() {
      entries.clear();
    },
  };
}

const caches = new Map();
const inflight = new Map();

/** degoog's async TTL cache when available (shared across replicas with Valkey), else memory. */
function getCache(name) {
  let cache = caches.get(name);
  if (!cache) {
    cache = cacheFactory
      ? cacheFactory(`ext:${PLUGIN_ID}:${name}`, DAY_MS)
      : createMemoryCache(DAY_MS);
    caches.set(name, cache);
  }
  return cache;
}

const isEntry = (value) => value !== null && typeof value === "object" && "value" in value;

/**
 * Cache + de-duplicate one lookup. `load` resolves a value, or null for "not found";
 * a throw is cached briefly so a failing upstream is not hammered on every search.
 */
async function cached(name, key, load, policy) {
  const cache = getCache(name);
  const hit = await safely(() => cache.get(key));
  if (isEntry(hit)) return hit.value;

  const flightKey = `${name}:${key}`;
  const running = inflight.get(flightKey);
  if (running) return running;

  const task = (async () => {
    let value = null;
    let ttlMs = policy.error;
    try {
      value = (await load()) ?? null;
      ttlMs = value === null ? policy.miss : policy.hit;
    } catch (error) {
      debug(`${name} lookup failed for ${key}:`, error);
    }
    await safely(() => cache.set(key, { value }, ttlMs));
    return value;
  })().finally(() => inflight.delete(flightKey));

  inflight.set(flightKey, task);
  return task;
}

/**
 * A large remote dataset kept in memory for DB_TTL_MS. If a refresh fails, the previous
 * copy keeps being served and the next attempt is delayed by ERROR_TTL_MS.
 */
function createRemoteDb({ name, urls, parse, empty, shared = false }) {
  let data = null;
  let loadedAt = 0;
  let retryAt = 0;
  let pending = null;

  const isFresh = () => data !== null && Date.now() - loadedAt < DB_TTL_MS;

  async function refresh(fetcher) {
    if (shared && data === null) {
      const stored = await safely(() => getCache(`db-${name}`).get("data"));
      if (isEntry(stored)) {
        data = stored.value;
        loadedAt = stored.fetchedAt ?? Date.now();
        return data;
      }
    }
    for (const url of urls) {
      try {
        const response = await httpGet(url, {
          fetcher,
          timeoutMs: DB_TIMEOUT_MS,
          maxBytes: MAX_DB_BYTES,
          headers: { Accept: "*/*" },
        });
        if (!response.ok) {
          debug(`${name}: HTTP ${response.status} for ${url}`);
          continue;
        }
        data = parse(response.text);
        loadedAt = Date.now();
        if (shared) {
          const entry = { value: data, fetchedAt: loadedAt };
          await safely(() => getCache(`db-${name}`).set("data", entry, DB_TTL_MS));
        }
        return data;
      } catch (error) {
        debug(`${name}: could not load ${url}:`, error);
      }
    }
    retryAt = Date.now() + ERROR_TTL_MS;
    return data ?? empty();
  }

  return {
    async load(fetcher) {
      if (isFresh()) return data;
      if (Date.now() < retryAt) return data ?? empty();
      pending ??= refresh(fetcher).finally(() => {
        pending = null;
      });
      return pending;
    },
    reset() {
      data = null;
      loadedAt = 0;
      retryAt = 0;
      pending = null;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Query parsing                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Recognises a PS2 / PS3 / PS4 title ID ("BLUS-30443", "slus20001", "CUSA00419", ...).
 * @returns {{platform: "ps2"|"ps3"|"ps4", id: string} | null}
 */
function identify(query) {
  if (typeof query !== "string") return null;
  const text = query.trim().toUpperCase();
  if (text.length < 6 || text.length > 16) return null;
  for (const rule of ID_RULES) {
    const match = rule.pattern.exec(text);
    if (match && rule.prefixes.has(match[1])) {
      return { platform: rule.platform, id: rule.join(match[1], match[2]) };
    }
  }
  return null;
}

/** Splits a query into words, noting a platform keyword ("ps2") if one is present. */
function splitQuery(text) {
  let hint = null;
  const stripped = text.replace(PLATFORM_KEYWORD, (_, digit) => {
    hint ??= `ps${digit}`;
    return " ";
  });
  return { hint, words: stripped.split(/[\s,;]+/).filter(Boolean) };
}

const isNoise = (word) => QUERY_NOISE_WORDS.has(word.toLowerCase());

/** The title IDs of a query, or null unless every word (noise aside) is one. */
function idTargets(words) {
  const ids = words.filter((word) => !isNoise(word)).map(identify);
  return ids.length && ids.every(Boolean) ? uniqueTargets(ids) : null;
}

/** A name only loses trailing noise ("god of war patch"); "title fight" keeps both words. */
function nameWords(words) {
  let end = words.length;
  while (end > 1 && isNoise(words[end - 1])) end -= 1;
  return words.slice(0, end);
}

const uniqueTargets = (targets) =>
  [...new Map(targets.map((target) => [target.id, target])).values()].slice(0, MAX_TARGETS);

/**
 * Decides whether the slot should run: only when every word of the search is a title ID
 * ("BLUS30443", "BLUS30443 BLES00123 patch"). Names are handled by the bang commands.
 *
 * @returns {{kind: "ids", targets: {platform: string, id: string}[]} | null}
 */
function analyzeQuery(query) {
  if (typeof query !== "string") return null;
  const text = query.trim();
  if (text.length < 6 || text.length > 100) return null;
  const targets = idTargets(splitQuery(text).words);
  return targets ? { kind: "ids", targets } : null;
}

/**
 * Arguments of `!emu`: title IDs, or a game name. A "ps2" / "ps3" / "ps4" keyword narrows a
 * name search to that platform; without one, all three platforms are searched.
 *
 * @returns {{kind: "ids", targets: {platform: string, id: string}[]}
 *   | {kind: "name", platforms: string[], title: string, key: string}
 *   | null}
 */
function parseBangArgs(args) {
  const text = String(args ?? "").trim().slice(0, 100);
  const { hint, words } = splitQuery(text);
  if (!words.length) return null;

  const targets = idTargets(words);
  if (targets) return { kind: "ids", targets };

  const title = nameWords(words).join(" ");
  const key = normalizeName(title);
  if (key.length < NAME_MIN_LENGTH) return null;
  const platforms = hint ? [hint] : [...ALL_PLATFORMS];
  return { kind: "name", platforms, title, key };
}

/* -------------------------------------------------------------------------- */
/* Provider: Sony patch metadata (PS3)                                        */
/* -------------------------------------------------------------------------- */

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXmlEntities(text) {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (match, dec, hex, name) => {
    if (dec || hex) {
      try {
        return String.fromCodePoint(dec ? Number(dec) : parseInt(hex, 16));
      } catch {
        return match;
      }
    }
    return XML_ENTITIES[name.toLowerCase()] ?? match;
  });
}

const xmlAttribute = (text, name) =>
  new RegExp(`(?<![\\w-])${name}\\s*=\\s*"([^"]*)"`, "i").exec(text)?.[1] ?? "";

function parseXmlTitle(xml) {
  const match = /<TITLE(?:\s[^>]*)?>([\s\S]*?)<\/TITLE>/i.exec(xml);
  if (!match) return "";
  const raw = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/i.exec(raw);
  return cdata ? cdata[1].trim() : decodeXmlEntities(raw);
}

function parseByteCount(value) {
  const text = String(value ?? "").trim();
  const bytes = /^\d{1,20}$/.test(text) ? Number(text) : NaN;
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
}

function parsePackages(xml) {
  const packages = [];
  const pattern = /<package\b([^>]*?)(?:\/>|>([\s\S]*?)<\/package>)/gi;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const attributes = match[1] || "";
    const inner = (match[2] || "").trim();
    const pkg = {
      version: xmlAttribute(attributes, "version"),
      size: parseByteCount(xmlAttribute(attributes, "size")),
    };
    const title = parseXmlTitle(inner || xml);
    if (title) pkg.title = title;
    packages.push(pkg);
  }
  return packages;
}

/**
 * Parses Sony's `<ID>-ver.xml`. Returns null when the title has no usable patch and throws
 * when the payload is not a response at all.
 */
function parseLookup(id, xml) {
  if (typeof xml !== "string" || !xml) throw new Error("bad response");
  const status = xmlAttribute(xml, "status");
  if (status && status !== "alive") return null;
  const titleId = xmlAttribute(xml, "titleid");
  if (titleId && titleId.toUpperCase() !== id) return null;

  const latest = parsePackages(xml).at(-1);
  if (!latest?.version || !latest.size) return null;
  return { id, name: latest.title || parseXmlTitle(xml) || id, version: latest.version };
}

const lookupPs3 = (id, fetcher) =>
  cached(
    "patch",
    id,
    async () => {
      const response = await httpGet(sonyPatchUrl(id), {
        fetcher,
        headers: { Accept: "application/xml, text/xml, */*" },
      });
      if (response.status === 404 || response.status === 403) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseLookup(id, response.text);
    },
    TTL.patch,
  );

/* -------------------------------------------------------------------------- */
/* Provider: PCSX2 GameIndex (PS2)                                            */
/* -------------------------------------------------------------------------- */

/** A double-quoted value (a trailing "# comment" is ignored) or a plain value minus its comment. */
function parseYamlScalar(raw) {
  const text = raw.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(text);
  if (quoted) return quoted[1].replace(/\\(["\\])/g, "$1");
  return text.replace(/\s+#.*$/, "").trim();
}

/** Reads only the four top-level fields we need from PCSX2's GameIndex.yaml. */
function parseGameIndex(text) {
  const db = new Map();
  let entry = null;
  let hasEnglishName = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const header = /^([A-Z][A-Z0-9-]+):\s*$/.exec(line);
    if (header) {
      entry = { id: header[1], name: header[1], region: "", compat: 0 };
      hasEnglishName = false;
      db.set(entry.id, entry);
      continue;
    }
    if (!entry) continue;
    const field = /^ {2}([\w-]+):\s*(.*?)\s*$/.exec(line);
    if (!field) continue;
    const value = parseYamlScalar(field[2]);
    switch (field[1]) {
      case "name-en":
        entry.name = value;
        hasEnglishName = true;
        break;
      case "name":
        if (!hasEnglishName) entry.name = value;
        break;
      case "region":
        entry.region = value;
        break;
      case "compat":
        if (/^\d+$/.test(value)) entry.compat = Number(value);
        break;
      default:
    }
  }
  return db;
}

const ps2Db = createRemoteDb({
  name: "pcsx2",
  urls: [PCSX2_INDEX_URL],
  parse: parseGameIndex,
  empty: () => new Map(),
});

const lookupPs2 = async (id, fetcher) => (await ps2Db.load(fetcher)).get(id) ?? null;

/* -------------------------------------------------------------------------- */
/* Provider: ShadPS4 compatibility (PS4)                                      */
/* -------------------------------------------------------------------------- */

const shadStatusRank = (status) =>
  Math.max(0, SHAD_STATUS_ORDER.indexOf(String(status ?? "").replace(/^status-/, "")));

/** Picks the best-rated report across operating systems, newest first on a tie. */
function bestShadEntry(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const entries = Object.entries(record)
    .filter(([, value]) => value && typeof value === "object")
    .map(([os, value]) => ({ os, ...value }));
  if (!entries.length) return null;
  return entries.reduce((best, current) => {
    const rankDiff = shadStatusRank(current.status) - shadStatusRank(best.status);
    if (rankDiff !== 0) return rankDiff > 0 ? current : best;
    const currentTime = Date.parse(current.last_tested || "") || 0;
    const bestTime = Date.parse(best.last_tested || "") || 0;
    return currentTime > bestTime ? current : best;
  });
}

function parseShadDb(text) {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("unexpected ShadPS4 database shape");
  }
  return data;
}

const shadDb = createRemoteDb({
  name: "shadps4",
  urls: SHAD_DB_URLS,
  parse: parseShadDb,
  empty: () => ({}),
  shared: true,
});

async function lookupPs4(id, fetcher) {
  const db = await shadDb.load(fetcher);
  const best = bestShadEntry(db[id]);
  if (!best) return null;
  return {
    id,
    name: String(best.name || id).trim() || id,
    status: String(best.status || "status-unknown").trim(),
    version: String(best.version || "").trim(),
    issueNumber: String(best.issue_number || "").trim(),
    lastTested: String(best.last_tested || "").trim(),
    os: String(best.os || "").trim(),
  };
}

/* -------------------------------------------------------------------------- */
/* Provider: RPCS3 compatibility (PS3)                                        */
/* -------------------------------------------------------------------------- */

const fetchRpcs3Compatibility = (id, fetcher) =>
  cached(
    "rpcs3",
    id,
    async () => {
      const data = await getJson(
        `https://rpcs3.net/compatibility?api=v1&g=${encodeURIComponent(id)}`,
        { fetcher },
      );
      // The search falls back to the closest title when the ID is unknown, so only an
      // entry keyed by this exact ID counts as a match.
      const results = data?.results ?? {};
      const key = Object.keys(results).find((candidate) => candidate.toUpperCase() === id);
      return key ? results[key] : null;
    },
    TTL.rpcs3,
  );

/* -------------------------------------------------------------------------- */
/* Provider: Wikipedia summary                                                */
/* -------------------------------------------------------------------------- */

const WIKI_URL = "https://en.wikipedia.org";
const wikiSlug = (title) => encodeURIComponent(title).replace(/%20/g, "_");

async function searchWikipediaTitles(title, hint, fetcher) {
  const query = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: `${title} ${hint} video game`,
    srlimit: "5",
    format: "json",
  });
  try {
    const data = await getJson(`${WIKI_URL}/w/api.php?${query}`, { fetcher });
    const titles = (data?.query?.search ?? []).map((item) => item.title).filter(Boolean);
    const needle = title.toLowerCase();
    const exact = titles.filter(
      (candidate) => candidate.toLowerCase().replace(/\s*\(.*\)$/, "").trim() === needle,
    );
    return exact.length ? exact : titles.slice(0, 3);
  } catch (error) {
    debug("wikipedia search failed:", error);
    return [title];
  }
}

async function getWikipediaSummary(title, fetcher) {
  const data = await getJson(`${WIKI_URL}/api/rest_v1/page/summary/${wikiSlug(title)}`, {
    fetcher,
  });
  if (!data?.extract || data.type === "disambiguation") return null;
  return {
    extract: String(data.extract),
    url: safeUrl(data.content_urls?.desktop?.page) || `${WIKI_URL}/wiki/${wikiSlug(title)}`,
  };
}

/** Prefers a summary that mentions video games / PlayStation, else the first one found. */
async function loadWikipediaSummary(title, hint, fetcher) {
  let fallback = null;
  for (const candidate of await searchWikipediaTitles(title, hint, fetcher)) {
    const summary = await getWikipediaSummary(candidate, fetcher);
    if (!summary) continue;
    if (/video game|PlayStation/i.test(summary.extract)) return summary;
    fallback ??= summary;
  }
  return fallback;
}

function fetchWikiSummary(title, fetcher, hint = "PS3") {
  const name = String(title ?? "").trim();
  if (!name) return Promise.resolve(null);
  return cached(
    "wiki",
    `${hint}:${name.toLowerCase()}`,
    () => loadWikipediaSummary(name, hint, fetcher),
    TTL.wiki,
  );
}

/* -------------------------------------------------------------------------- */
/* Provider: SteamGridDB artwork                                              */
/* -------------------------------------------------------------------------- */

const sgdbRequest = (fetcher) => ({
  fetcher,
  headers: { Authorization: `Bearer ${settings.steamGridDbApiKey}` },
});

const isArtworkUrl = (value) => safeUrl(value, SGDB_DOMAIN).startsWith("https://");

function expandAbbreviations(title) {
  const tokens = String(title ?? "").match(/[A-Za-z]+|\d+/g) ?? [];
  return tokens
    .map((token) => ARTWORK_ABBREVIATIONS[token.toLowerCase()] ?? token)
    .join(" ")
    .trim();
}

function artworkSearchTerms(title) {
  const raw = String(title ?? "").trim();
  const terms = [raw, raw.replace(ARTWORK_EDITION_SUFFIX, "").trim(), expandAbbreviations(raw)];
  return [...new Set(terms.filter(Boolean))];
}

function pickArtworkGame(entries, term) {
  const wanted = normalizeName(term);
  if (!wanted || !Array.isArray(entries)) return null;
  // Exact names only: a "contains" match put "Persona 3 Reload" on the PS2 "Persona 3" card.
  return entries.find((game) => game?.id && normalizeName(game.name) === wanted) ?? null;
}

/** @returns {Promise<{title: string, url: string} | null>} */
async function findArtwork(title, fetcher) {
  for (const term of artworkSearchTerms(title)) {
    const search = await getJson(
      `${SGDB_API_URL}/search/autocomplete/${encodeURIComponent(term)}`,
      sgdbRequest(fetcher),
    );
    const game = pickArtworkGame(search?.data, term);
    if (!game) continue;

    const grids = await getJson(
      `${SGDB_API_URL}/grids/game/${game.id}?dimensions=${SGDB_GRID_DIMENSIONS}`,
      sgdbRequest(fetcher),
    );
    const grid = (grids?.data ?? []).find((item) => isArtworkUrl(item?.url));
    if (grid) return { title: String(game.name), url: grid.url };
  }
  return null;
}

function resolveArtwork(title, fetcher) {
  const name = String(title ?? "").trim();
  if (!settings.steamGridDbApiKey || !name) return Promise.resolve(null);
  return cached("artwork", name.toLowerCase(), () => findArtwork(name, fetcher), TTL.artwork);
}

/* -------------------------------------------------------------------------- */
/* Platforms: turn a title ID into a platform-neutral card model              */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} Card
 * @property {string} id
 * @property {"ps2"|"ps3"|"ps4"} platform
 * @property {string} name
 * @property {string} version
 * @property {string | null} region
 * @property {{labelKey: string, tone: string, url: string} | null} compat
 * @property {(wiki: {extract: string, url: string} | null, emuWiki: string | null) =>
 *   {page: string, more: string}} links
 */

const toTone = (raw) => {
  const tone = String(raw ?? "")
    .toLowerCase()
    .replace(/^status-/, "")
    .replace(/[^a-z]/g, "");
  return COMPAT_TONES.has(tone) ? tone : "unknown";
};

/**
 * Release region of a title as a locale key (region.<key>), or null when unknown.
 * PS3 codes carry it in the third letter; PS2 reads PCSX2's region field; PS4 has no marker.
 */
function regionOf(platform, id, rawRegion = "") {
  if (platform === "ps3") return PS3_REGION_BY_LETTER[String(id)[2]] ?? null;
  if (platform === "ps2") {
    const region = String(rawRegion).trim().toUpperCase();
    if (!region.endsWith("UNK")) {
      if (region.startsWith("PAL")) return "eu";
      if (region.startsWith("NTSC-U")) return "us";
      if (region.startsWith("NTSC-J")) return "jp";
      if (region.startsWith("NTSC-K")) return "kr";
      if (/^NTSC-(?:C|HK|T)/.test(region)) return "asia";
    }
    return PS2_REGION_BY_PREFIX[String(id).slice(0, 4).toUpperCase()] ?? null;
  }
  return null;
}

/** @returns {Promise<Card | null>} */
async function resolvePs3Card(id, fetcher) {
  // Sony is only asked while its answer (the version) is shown: that request skips certificate
  // validation and, on the fallback path, the outgoing proxy.
  const wantsVersion = settings.showDetails && settings.showVersion;
  const [patch, compat] = await Promise.all([
    wantsVersion ? lookupPs3(id, fetcher) : null,
    settings.showCompatibility ? fetchRpcs3Compatibility(id, fetcher) : null,
  ]);
  if (!patch && !compat) return null;

  const compatPage = `https://rpcs3.net/compatibility?g=${encodeURIComponent(id)}`;
  const wikiPage = compat?.title
    ? `https://wiki.rpcs3.net/index.php?title=${wikiSlug(String(compat.title).trim())}`
    : "";
  return {
    id,
    platform: "ps3",
    region: regionOf("ps3", id),
    name: String(compat?.title || patch?.name || id),
    version: patch?.version ?? "",
    compat: compat?.status
      ? { labelKey: "compatibilityRpcs3", tone: toTone(compat.status), url: wikiPage }
      : null,
    // Never link Sony's XML: its certificate fails in the visitor's browser too.
    links: (wiki) => ({
      page: wiki?.url || compatPage,
      more: wiki?.url || (compat ? compatPage : ""),
    }),
  };
}

/** @returns {Promise<Card | null>} */
async function resolvePs2Card(id, fetcher) {
  const info = await lookupPs2(id, fetcher);
  if (!info) return null;
  return {
    id,
    platform: "ps2",
    region: regionOf("ps2", id, info.region),
    name: info.name || id,
    version: "",
    compat: settings.showCompat
      ? {
          labelKey: "compatibilityPcsx2",
          tone: PCSX2_TONES[Number(info.compat)] ?? "unknown",
          url: "",
        }
      : null,
    links: (wiki, emuWiki) => {
      const page = emuWiki || wiki?.url || PCSX2_COMPAT_URL;
      return { page, more: page };
    },
  };
}

/** @returns {Promise<Card | null>} */
async function resolvePs4Card(id, fetcher) {
  const info = await lookupPs4(id, fetcher);
  if (!info) return null;
  const issueUrl = info.issueNumber
    ? `${SHAD_REPO_URL}/issues/${encodeURIComponent(info.issueNumber)}`
    : SHAD_REPO_URL;
  return {
    id,
    platform: "ps4",
    region: null,
    name: info.name,
    version: "",
    compat: settings.showCompatibility
      ? { labelKey: "compatibilityShadps4", tone: toTone(info.status), url: "" }
      : null,
    links: (wiki, emuWiki) => ({ page: emuWiki || wiki?.url || issueUrl, more: issueUrl }),
  };
}

const PLATFORMS = Object.freeze({
  ps2: { wikiHint: "PS2", adoptArtworkTitle: true, resolve: resolvePs2Card },
  ps3: { wikiHint: "PS3", adoptArtworkTitle: false, resolve: resolvePs3Card },
  ps4: { wikiHint: "PS4", adoptArtworkTitle: true, resolve: resolvePs4Card },
});

/* -------------------------------------------------------------------------- */
/* Emulator wikis (PCSX2, ShadPS4)                                            */
/* -------------------------------------------------------------------------- */

/** Wiki page titles have no trademark signs and no doubled spaces. */
const wikiTitle = (name) =>
  String(name ?? "")
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * URL of the game's page on the emulator's wiki, or null when the wiki has no such page.
 * A HEAD request confirms the page exists, so a dead link is never shown.
 *
 * @returns {Promise<string | null>}
 */
function findEmulatorWikiPage(platform, name, fetcher) {
  const buildUrl = EMULATOR_WIKIS[platform];
  const title = wikiTitle(name);
  if (!buildUrl || !title) return Promise.resolve(null);
  return cached(
    "emulator-wiki",
    `${platform}:${title}`,
    async () => {
      const url = buildUrl(title);
      const response = await httpGet(url, { fetcher, method: "HEAD" });
      if (response.ok) return url;
      if (response.status === 404) return null;
      throw new Error(`HTTP ${response.status} for ${url}`);
    },
    TTL.emuWiki,
  );
}

/* -------------------------------------------------------------------------- */
/* Name search: game name -> list of title IDs                                */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} TitleRow
 * @property {string} id
 * @property {"ps2"|"ps3"|"ps4"} platform
 * @property {string} name
 * @property {string | null} region
 * @property {string} tone
 * @property {string} url        link of the game name
 * @property {string} compatUrl  link of the compatibility badge
 */

/** @returns {Promise<TitleRow[]>} */
async function searchPs2(_title, key, fetcher) {
  const db = await ps2Db.load(fetcher);
  const rows = [];
  for (const entry of db.values()) {
    if (!normalizeName(entry.name).includes(key)) continue;
    rows.push({
      id: entry.id,
      platform: "ps2",
      name: entry.name,
      region: regionOf("ps2", entry.id, entry.region),
      tone: PCSX2_TONES[entry.compat] ?? "unknown",
      url: "",
      compatUrl: "",
    });
  }
  return rows;
}

/** @returns {Promise<TitleRow[]>} */
async function searchPs4(_title, key, fetcher) {
  const db = await shadDb.load(fetcher);
  const rows = [];
  for (const id of Object.keys(db)) {
    if (!/^CUSA\d{5}$/.test(id)) continue;
    const best = bestShadEntry(db[id]);
    if (!best?.name || !normalizeName(best.name).includes(key)) continue;
    const issue = String(best.issue_number || "").trim();
    rows.push({
      id,
      platform: "ps4",
      name: String(best.name).trim(),
      region: null,
      tone: toTone(best.status),
      url: "",
      compatUrl: issue ? `${SHAD_REPO_URL}/issues/${encodeURIComponent(issue)}` : "",
    });
  }
  return rows;
}

/**
 * PS3 has no local name database, so this asks RPCS3's search API (the same `g` term as its
 * website). The site falls back to the closest title when nothing matches, so results are
 * filtered again by name here. Only reached through an explicit bang command.
 *
 * @returns {Promise<TitleRow[]>}
 */
async function searchPs3(title, key, fetcher) {
  const rows = await cached(
    "rpcs3-search",
    key,
    async () => {
      const data = await getJson(
        `https://rpcs3.net/compatibility?api=v1&g=${encodeURIComponent(title)}&r=${RPCS3_SEARCH_LIMIT}`,
        { fetcher },
      );
      const found = Object.entries(data?.results ?? {})
        .filter(([id, entry]) => /^[A-Z]{4}\d{5}$/.test(id) && entry?.title)
        .filter(([, entry]) => normalizeName(entry.title).includes(key))
        .map(([id, entry]) => ({
          id,
          platform: "ps3",
          name: String(entry.title).trim(),
          region: regionOf("ps3", id),
          tone: toTone(entry.status),
          url: `https://rpcs3.net/compatibility?g=${encodeURIComponent(id)}`,
          compatUrl: "",
        }));
      return found.length ? found : null;
    },
    TTL.rpcs3,
  );
  return rows ?? [];
}

const NAME_SEARCHERS = Object.freeze({ ps2: searchPs2, ps3: searchPs3, ps4: searchPs4 });

/** Exact name first, then names that start with the query, then the rest alphabetically. */
function rankRows(rows, key) {
  const score = (row) => {
    const name = normalizeName(row.name);
    if (name === key) return 0;
    return name.startsWith(key) ? 1 : 2;
  };
  return rows
    .map((row) => ({ row, score: score(row) }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.row.name.localeCompare(b.row.name) ||
        a.row.id.localeCompare(b.row.id),
    )
    .map(({ row }) => row);
}

/** @returns {Promise<TitleRow[]>} */
async function searchTitles(platform, title, key, fetcher) {
  const rows = await NAME_SEARCHERS[platform](title, key, fetcher);
  return rankRows(rows, key).slice(0, MAX_NAME_RESULTS);
}

/** Points each row's name at the emulator wiki page when the wiki has one. */
async function addWikiLinks(rows, fetcher) {
  await Promise.all(
    rows.map(async (row) => {
      const page = await findEmulatorWikiPage(row.platform, row.name, fetcher);
      if (page) row.url = page;
    }),
  );
  return rows;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** Server-side translation tag; degoog resolves it against locales/<lang>.json. */
const t = (key) => `{{ t:${I18N_NAMESPACE}.${key} }}`;

const renderTemplate = (values) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");

const detailRow = (labelKey, valueHtml) =>
  `<div class="ps3-detail"><dt class="ps3-label">${t(`labels.${labelKey}`)}</dt>` +
  `<dd class="ps3-value">${valueHtml}</dd></div>`;

function compatBadge({ tone, url }) {
  const className = `ps3-compat ps3-compat--${tone}`;
  const label = t(`compat.${tone}`);
  return url
    ? `<a class="${className}" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : `<span class="${className}">${label}</span>`;
}

const renderCompat = ({ labelKey, tone, url }) => detailRow(labelKey, compatBadge({ tone, url }));

/** Region badge, reusing degoog's generic `.degoog-badge` class. */
const renderRegion = (region) =>
  settings.showRegion && region
    ? `<span class="degoog-badge ps3-region ps3-region--${region}">${t(`region.${region}`)}</span>`
    : "";

const compatEnabled = (platform) =>
  settings.showDetails && (platform === "ps2" ? settings.showCompat : settings.showCompatibility);

/** @param {TitleRow} row */
function renderTitleRow(row) {
  const name = row.url
    ? `<a class="ps3-row-name" href="${escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.name)}</a>`
    : `<span class="ps3-row-name">${escapeHtml(row.name)}</span>`;
  const compat =
    compatEnabled(row.platform) && row.tone !== "unknown"
      ? compatBadge({ tone: row.tone, url: row.compatUrl })
      : "";
  return (
    `<li class="ps3-row">${renderRegion(row.region)}` +
    `<span class="ps3-id">${escapeHtml(row.id)}</span>${name}${compat}</li>`
  );
}

/** @param {TitleRow[]} rows */
const renderNameResults = (platform, rows) =>
  `<div class="ps3-card ps3-results">` +
  `<div class="ps3-kicker"><span class="ps3-platform">${t(`platform.${platform}`)}</span>` +
  `<span>${t("nameSearch.heading")}</span></div>` +
  `<ul class="ps3-list">${rows.map(renderTitleRow).join("")}</ul>` +
  `<p class="ps3-hint">${t("nameSearch.hint")}</p></div>`;

/** Usage hint for `!emu` without arguments. */
const renderUsage = () =>
  `<div class="ps3-card">` +
  `<p class="ps3-hint">${t("nameSearch.usage")} <code>!emu god of war</code></p>` +
  `<p class="ps3-hint">${t("nameSearch.narrow")} <code>!emu god of war ps2</code></p></div>`;

/** A one-line message in the card style (usage hint, "nothing found"). */
const renderNotice = (messageKey, detailHtml = "") =>
  `<div class="ps3-card"><p class="ps3-hint">${t(messageKey)} ${detailHtml}</p></div>`;

const stack = (blocks) => (blocks.length === 1 ? blocks[0] : `<div class="ps3-stack">${blocks.join("")}</div>`);

/**
 * @param {Card} card
 * @param {{wiki: {extract: string, url: string} | null, emuWiki: string | null, coverUrl: string}} extras
 */
function renderCard(card, { wiki, emuWiki, coverUrl }) {
  const links = card.links(wiki, emuWiki);

  const rows = [];
  if (settings.showDetails) {
    if (card.compat) rows.push(renderCompat(card.compat));
    if (settings.showVersion && card.version) {
      rows.push(detailRow("version", escapeHtml(card.version)));
    }
  }

  return renderTemplate({
    id: escapeHtml(card.id),
    name: escapeHtml(card.name),
    url: escapeHtml(links.page),
    platform: t(`platform.${card.platform}`),
    region: renderRegion(card.region),
    cover: coverUrl
      ? `<img class="ps3-cover" src="${escapeHtml(coverUrl)}" alt="" width="120" height="170" loading="eager" decoding="async">`
      : "",
    details: rows.length ? `<dl class="ps3-details">${rows.join("")}</dl>` : "",
    description:
      settings.showDescription && wiki?.extract
        ? `<p class="ps3-description">${escapeHtml(wiki.extract)}</p>`
        : "",
    linkBlock: links.more
      ? `<a class="ps3-more" href="${escapeHtml(links.more)}" rel="noopener noreferrer">${t("viewPage")} ${EXTERNAL_ICON}</a>`
      : "",
  });
}

/* -------------------------------------------------------------------------- */
/* Pipeline: query -> HTML                                                    */
/* -------------------------------------------------------------------------- */

/** Renders one title ID as a card. Resolves "" when nothing is known about it. */
async function renderTarget({ platform: key, id }, fetcher, context) {
  const platform = PLATFORMS[key];
  try {
    const card = await platform.resolve(id, fetcher);
    if (!card) return "";

    const wantsCover = settings.showCover && Boolean(settings.steamGridDbApiKey);
    const artworkTask = wantsCover ? resolveArtwork(card.name, fetcher) : Promise.resolve(null);
    if (platform.adoptArtworkTitle) {
      // PS2 / PS4 database names are rough; SteamGridDB's title is nicer and a better wiki query.
      const artwork = await artworkTask;
      if (artwork?.title) card.name = artwork.title;
    }
    const [artwork, wiki, emuWiki] = await Promise.all([
      artworkTask,
      settings.showDescription ? fetchWikiSummary(card.name, fetcher, platform.wikiHint) : null,
      findEmulatorWikiPage(key, card.name, fetcher),
    ]);

    const coverUrl =
      artwork?.url && typeof context?.signProxyUrl === "function"
        ? context.signProxyUrl(artwork.url)
        : "";
    return renderCard(card, { wiki, emuWiki, coverUrl });
  } catch (error) {
    debug(`could not render ${id}:`, error);
    return "";
  }
}

/** One card per ID; several are stacked. A failing ID never hides the others. */
async function renderTargets(targets, fetcher, context) {
  const cards = (
    await Promise.all(
      targets.map((target) =>
        withTimeout(renderTarget(target, fetcher, context), CARD_TIMEOUT_MS).catch(() => ""),
      ),
    )
  ).filter(Boolean);
  return cards.length ? stack(cards) : "";
}

/** One result list per platform; a platform whose lookup fails is simply left out. */
async function renderNameSearch({ platforms, title, key }, fetcher) {
  const sections = await Promise.all(
    platforms.map(async (platform) => {
      try {
        const rows = await searchTitles(platform, title, key, fetcher);
        return rows.length ? renderNameResults(platform, await addWikiLinks(rows, fetcher)) : "";
      } catch (error) {
        debug(`${platform} name search failed for "${title}":`, error);
        return "";
      }
    }),
  );
  const blocks = sections.filter(Boolean);
  return blocks.length
    ? stack(blocks)
    : renderNotice("nameSearch.empty", `<strong>${escapeHtml(title)}</strong>`);
}

/**
 * Runs `!emu`: a game name (all platforms, or the one named by a ps2 / ps3 / ps4 keyword)
 * or one or more title IDs.
 */
async function runBang(args, context = {}) {
  const text = String(args ?? "").trim();
  let title = `PlayStation${text ? `: ${text}` : ""}`;
  let html;
  try {
    const parsed = parseBangArgs(text);
    if (!parsed) {
      html = renderUsage();
    } else if (parsed.kind === "ids") {
      html =
        (await renderTargets(parsed.targets, pluginFetch, context)) ||
        renderNotice("nameSearch.empty", `<strong>${escapeHtml(text)}</strong>`);
    } else {
      const label = parsed.platforms.length === 1 ? PLATFORM_LABELS[parsed.platforms[0]] : "PlayStation";
      title = `${label}: ${parsed.title}`;
      html = await renderNameSearch(parsed, pluginFetch);
    }
  } catch (error) {
    debug(`!emu ${text} failed:`, error);
    html = renderNotice("nameSearch.empty", `<strong>${escapeHtml(text)}</strong>`);
  }
  return { title, html };
}

/* -------------------------------------------------------------------------- */
/* Plugin entry points                                                        */
/* -------------------------------------------------------------------------- */

async function clearCaches() {
  await Promise.all([...caches.values()].map((cache) => safely(() => cache.clear())));
  caches.clear();
  inflight.clear();
  ps2Db.reset();
  shadDb.reset();
}

/** Both the slot and the `!emu` command are initialised by degoog; they share this state. */
function setup(ctx) {
  template = typeof ctx?.template === "string" ? ctx.template : "";
  pluginFetch = typeof ctx?.fetch === "function" ? ctx.fetch : null;
  cacheFactory = typeof ctx?.useCache === "function" ? ctx.useCache : null;
  caches.clear();
}

function configure(next) {
  const previousKey = settings.steamGridDbApiKey;
  const values = next ?? {};
  settings = Object.fromEntries(
    settingsSchema.map((field) => [
      field.key,
      field.type === "toggle"
        ? parseToggle(values[field.key], DEFAULT_SETTINGS[field.key])
        : String(values[field.key] ?? DEFAULT_SETTINGS[field.key]).trim(),
    ]),
  );
  // A replaced key may turn earlier "no artwork" answers into hits. Nothing is cached while
  // there is no key, so the first key (every boot) has nothing to clear.
  if (previousKey && settings.steamGridDbApiKey !== previousKey) {
    void safely(() => getCache("artwork").clear());
  }
}

export const slot = {
  id: PLUGIN_ID,
  name: "EmuCompat",
  description:
    "Looks up PlayStation 2, 3 and 4 title IDs and shows the game name, emulator compatibility (PCSX2, RPCS3, ShadPS4), the latest PS3 patch version and SteamGridDB cover art.",
  // Images are served through context.signProxyUrl and every other request is made
  // server-side, so the browser never contacts an external service directly.
  isClientExposed: false,
  // The rendered HTML contains no <script> tag and no inline event handler.
  supportsNojs: true,
  position: "at-a-glance",
  slotPositions: ["at-a-glance", "above-results", "above-sidebar", "below-sidebar"],
  settingsSchema,

  init: setup,
  configure,

  trigger(query) {
    return analyzeQuery(query) !== null;
  },

  async execute(query, context) {
    const analysis = analyzeQuery(query);
    if (!analysis || !template) return EMPTY_RESULT;
    const html = await renderTargets(analysis.targets, context?.fetch ?? pluginFetch, context);
    return html ? { title: "", html } : EMPTY_RESULT;
  },
};

/**
 * `!emu <game name or title ID>` searches PS2, PS3 and PS4; add "ps2", "ps3" or "ps4" to narrow
 * it down. Degoog loads one command per folder and never tells a command which trigger was
 * typed, so separate `!ps2`-style bangs are not possible; the keyword does that job.
 */
const emuCommand = {
  name: "PlayStation Emulation Lookup",
  description:
    "Search PS2, PS3 and PS4 games by name or title ID. Add ps2, ps3 or ps4 to narrow it down.",
  trigger: "emu",
  supportsNojs: true,
  // Name searches fan out to several upstream services.
  respectRateLimiting: true,
  init: setup,
  // No configure here: degoog (1.1.1) configures a command with the command's own settings
  // bucket, not the slot's, which reset the shared settings and dropped the API key.
  execute: (args, context) => runBang(args, context),
};

/** Test hooks. Not part of the degoog plugin contract. */
export const _internals = {
  identify,
  parseBangArgs,
  parseLookup,
  parseGameIndex,
  bestShadEntry,
  regionOf,
  clearCaches,
};

export default emuCommand;
