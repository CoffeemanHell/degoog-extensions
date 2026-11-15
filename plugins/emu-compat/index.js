/**
 * EmuCompat: PlayStation title IDs and PC games for degoog.
 * Substantially inspired by https://github.com/EthanC/degoog-extensions (AGPL-3.0).
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { readFileSync } from "node:fs";
import { get as httpsGet } from "node:https";

const PLUGIN_ID = "emu-compat";
const I18N_NAMESPACE = `plugin-${PLUGIN_ID}`;
const USER_AGENT = "degoog-emu-compat";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const HTTP_TIMEOUT_MS = 5 * 1000;
const DB_TIMEOUT_MS = 30 * 1000;
const CARD_TIMEOUT_MS = 8 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DB_BYTES = 64 * 1024 * 1024;
const CACHE_ENTRY_LIMIT = 500;
const DB_TTL_MS = DAY_MS;
const ERROR_TTL_MS = 5 * MINUTE_MS;

const _ttl = (hit, miss = HOUR_MS) => ({ hit, miss, error: ERROR_TTL_MS });
const TTL = Object.freeze({
  patch: _ttl(6 * HOUR_MS),
  rpcs3: _ttl(DAY_MS),
  wiki: _ttl(DAY_MS, 6 * HOUR_MS),
  emuWiki: _ttl(DAY_MS, 6 * HOUR_MS),
  artwork: _ttl(DAY_MS),
  steam: _ttl(DAY_MS),
  proton: _ttl(DAY_MS),
  gog: _ttl(DAY_MS),
});

const SONY_PATCH_HOST = "a0.ww.np.dl.playstation.net";
const _sonyPatchUrl = (id) => `https://${SONY_PATCH_HOST}/tpl/np/${id}/${id}-ver.xml`;
const INSECURE_TLS_HOSTS = new Set([SONY_PATCH_HOST]);

const PCSX2_INDEX_URL =
  "https://raw.githubusercontent.com/PCSX2/pcsx2/master/bin/resources/GameIndex.yaml";
const PCSX2_COMPAT_URL = "https://pcsx2.net/compatibility-list.html";

const SHAD_REPO_URL = "https://github.com/shadps4-compatibility/shadps4-game-compatibility";
const SHAD_DB_URLS = [`${SHAD_REPO_URL}/releases/latest/download/compatibility_data.json`];
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

const ID_RULES = [
  { platform: "ps2", prefixes: PS2_PREFIXES, pattern: /^([A-Z]{3,4})-?(\d{4,5})$/, join: (p, n) => `${p}-${n}` },
  { platform: "ps4", prefixes: PS4_PREFIXES, pattern: /^([A-Z]{4})-?(\d{5})$/, join: (p, n) => `${p}${n}` },
  { platform: "ps3", prefixes: PS3_PREFIXES, pattern: /^([A-Z]{4})-?(\d{5})$/, join: (p, n) => `${p}${n}` },
];

const COMPAT_TONES = new Set([
  "unknown", "nothing", "loadable", "intro", "boots", "menus", "ingame", "playable", "perfect",
]);
const PCSX2_TONES = ["unknown", "nothing", "intro", "menus", "ingame", "playable", "perfect"];

const MAX_TARGETS = 4;
const MAX_NAME_RESULTS = 8;
const MAX_TABS = 5;
const RPCS3_SEARCH_LIMIT = 25;
const NAME_MIN_LENGTH = 2;
const PC_QUERY_MAX_LENGTH = 60;
const PC_MIN_SIMILARITY = 0.7;
const PC_PREFIX_SIMILARITY = 0.9;
const PC_PREFIX_REVIEW_FACTOR = 3;
const PC_OVERLAP_REVIEW_FACTOR = 8;
const NON_GAME_PATTERN =
  /^(how\s|what\s(is|are|does|do)\s(a|an|the)?\s?(best\s)?(way|method|difference|meaning|purpose|reason)|why\s|where\s(can|do|is)|when\s(did|does|is|was)|can\si|should\si|how\sto|define\s|weather|recipe|price\sof|buy\s|download\s|install\s|code\s|error\s|fix\s|debug\s|www\.|https?:)/i;
const GAME_QUERY_SUFFIX = /\s+(?:video\s?games?|games?|(?:video\s)?oyun(?:u|lar[ıi])?)$/i;

const PLATFORM_KEYWORD = /\b(?:ps|playstation)\s?([234])\b/gi;
const QUERY_NOISE_WORDS = new Set([
  "patch", "patches", "update", "updates", "id", "ids", "serial", "title", "compat", "compatibility",
]);

const ALL_PLATFORMS = Object.freeze(["pc", "ps2", "ps3", "ps4"]);
const PLATFORM_LABELS = Object.freeze({
  pc: "PC",
  ps2: "PlayStation 2",
  ps3: "PlayStation 3",
  ps4: "PlayStation 4",
});

const EMULATOR_WIKIS = Object.freeze({
  ps2: (title) => `https://wiki.pcsx2.net/${_wikiSlug(title)}`,
  ps4: (title) => `https://wiki.shadps4.net/index.php?title=${_wikiSlug(title)}`,
});

const PS2_REGION_BY_PREFIX = Object.freeze({
  SLUS: "us", SCUS: "us",
  SLES: "eu", SCES: "eu", SCED: "eu", SLED: "eu", TCES: "eu", TLES: "eu",
  SLPS: "jp", SLPM: "jp", SCPS: "jp", SCPM: "jp", SCPN: "jp",
  SLAJ: "asia", SCAJ: "asia",
  SLKA: "kr", SCKA: "kr",
});

const PS3_REGION_BY_LETTER = Object.freeze({ U: "us", E: "eu", J: "jp", A: "asia", H: "asia", K: "kr" });

const EMPTY_RESULT = Object.freeze({ title: "", html: "" });
const EXTERNAL_ICON =
  '<i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i>';

const SETTINGS_SCHEMA = [
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
    key: "browserLanguage",
    label: "Use browser language",
    type: "toggle",
    default: "true",
    fieldset: "Content",
    description:
      "Show descriptions in the visitor's browser language when available (Steam's for PC games, Wikipedia's for PlayStation games), and the card's own text in degoog's language. Off: everything in English.",
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
  {
    key: "pcPlainSearch",
    label: "PC games on plain searches",
    type: "toggle",
    default: "true",
    fieldset: "PC",
    description:
      "Show a PC game card when a search is exactly a popular Steam game's name. Every such search asks Steam; turn off to keep plain searches local.",
  },
  {
    key: "pcLooseMatches",
    label: "Similar names on plain searches",
    type: "toggle",
    default: "true",
    fieldset: "PC",
    description:
      "Also show popular games whose name only starts with or shares words with the search (\"dark souls\" → Dark Souls III). Off: the exact name only.",
    visibleWhen: { key: "pcPlainSearch", equals: "true" },
  },
  {
    key: "pcMinReviews",
    label: "Minimum Steam reviews",
    type: "number",
    min: "0",
    default: "1000",
    fieldset: "PC",
    description: "A plain search only shows games with at least this many Steam reviews.",
    visibleWhen: { key: "pcPlainSearch", equals: "true" },
  },
];

const DEFAULT_SETTINGS = Object.freeze(
  Object.fromEntries(
    SETTINGS_SCHEMA.map((field) => [
      field.key,
      field.type === "toggle" ? field.default === "true" : (field.default ?? ""),
    ]),
  ),
);

let template = "";
let pluginFetch = null;
let cacheFactory = null;
let settings = { ...DEFAULT_SETTINGS };

const _isDebug = () => String(globalThis.process?.env?.LOG_LEVEL ?? "").toLowerCase() === "debug";
function _debug(...args) {
  if (_isDebug()) console.debug(`[${PLUGIN_ID}]`, ...args);
}

const _safely = async (task) => {
  try {
    return await task();
  } catch (error) {
    _debug("non-fatal error:", error);
    return undefined;
  }
};

const _withTimeout = (promise, ms) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const _escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\{\{/g, "&#123;&#123;");

const _hostMatches = (hostname, domain) => hostname === domain || hostname.endsWith(`.${domain}`);

const _safeUrl = (value, domain) => {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (domain && !_hostMatches(url.hostname, domain)) return "";
    return url.href;
  } catch {
    return "";
  }
};

const _normalizeName = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const _parseToggle = (value, fallback) => {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "true") return true;
  if (text === "false") return false;
  return fallback;
};

const _readResponse = async (response, maxBytes, headOnly = false) => {
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
};

const _insecureGet = (url, { headers, timeoutMs, maxBytes }) => {
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
};

const _allowsInsecureTls = (url) => {
  try {
    return INSECURE_TLS_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
};

const _httpGet = async (url, options = {}) => {
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
    return await _withTimeout(
      (async () =>
        _readResponse(
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
    if (!_allowsInsecureTls(url)) throw error;
    _debug(`retrying ${url} without certificate validation:`, error);
    return _withTimeout(
      _insecureGet(url, { headers: requestHeaders, timeoutMs, maxBytes }),
      timeoutMs,
    );
  }
};

const _getJson = async (url, options = {}) => {
  const response = await _httpGet(url, {
    ...options,
    headers: { Accept: "application/json", ...options.headers },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return JSON.parse(response.text);
};

const _createMemoryCache = (defaultTtlMs, limit = CACHE_ENTRY_LIMIT) => {
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
};

const caches = new Map();
const inflight = new Map();

const _getCache = (name) => {
  let cache = caches.get(name);
  if (!cache) {
    cache = cacheFactory
      ? cacheFactory(`ext:${PLUGIN_ID}:${name}`, DAY_MS)
      : _createMemoryCache(DAY_MS);
    caches.set(name, cache);
  }
  return cache;
};

const _isEntry = (value) => value !== null && typeof value === "object" && "value" in value;

const _cached = async (name, key, load, policy) => {
  const cache = _getCache(name);
  const hit = await _safely(() => cache.get(key));
  if (_isEntry(hit)) return hit.value;

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
      _debug(`${name} lookup failed for ${key}:`, error);
    }
    await _safely(() => cache.set(key, { value }, ttlMs));
    return value;
  })().finally(() => inflight.delete(flightKey));

  inflight.set(flightKey, task);
  return task;
};

const _createRemoteDb = ({ name, urls, parse, empty, shared = false }) => {
  let data = null;
  let loadedAt = 0;
  let retryAt = 0;
  let pending = null;

  const isFresh = () => data !== null && Date.now() - loadedAt < DB_TTL_MS;

  const refresh = async (fetcher) => {
    if (shared && data === null) {
      const stored = await _safely(() => _getCache(`db-${name}`).get("data"));
      if (_isEntry(stored)) {
        data = stored.value;
        loadedAt = stored.fetchedAt ?? Date.now();
        return data;
      }
    }
    for (const url of urls) {
      try {
        const response = await _httpGet(url, {
          fetcher,
          timeoutMs: DB_TIMEOUT_MS,
          maxBytes: MAX_DB_BYTES,
          headers: { Accept: "*/*" },
        });
        if (!response.ok) {
          _debug(`${name}: HTTP ${response.status} for ${url}`);
          continue;
        }
        data = parse(response.text);
        loadedAt = Date.now();
        if (shared) {
          const entry = { value: data, fetchedAt: loadedAt };
          await _safely(() => _getCache(`db-${name}`).set("data", entry, DB_TTL_MS));
        }
        return data;
      } catch (error) {
        _debug(`${name}: could not load ${url}:`, error);
      }
    }
    retryAt = Date.now() + ERROR_TTL_MS;
    return data ?? empty();
  };

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
};

const _identify = (query) => {
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
};

const _splitQuery = (text) => {
  let hint = null;
  const stripped = text.replace(PLATFORM_KEYWORD, (_, digit) => {
    hint ??= `ps${digit}`;
    return " ";
  });
  return { hint, words: stripped.split(/[\s,;]+/).filter(Boolean) };
};

const _isNoise = (word) => QUERY_NOISE_WORDS.has(word.toLowerCase());

const _idTargets = (words) => {
  const ids = words.filter((word) => !_isNoise(word)).map(_identify);
  return ids.length && ids.every(Boolean) ? _uniqueTargets(ids) : null;
};

const _nameWords = (words) => {
  let end = words.length;
  while (end > 1 && _isNoise(words[end - 1])) end -= 1;
  return words.slice(0, end);
};

const _uniqueTargets = (targets) =>
  [...new Map(targets.map((target) => [target.id, target])).values()].slice(0, MAX_TARGETS);

const _analyzeQuery = (query) => {
  if (typeof query !== "string") return null;
  const text = query.trim();
  const { hint, words } = _splitQuery(text);
  const targets = text.length >= 6 && text.length <= 100 ? _idTargets(words) : null;
  if (targets) return { kind: "ids", targets };
  if (!settings.pcPlainSearch || hint || text.length > PC_QUERY_MAX_LENGTH || NON_GAME_PATTERN.test(text)) {
    return null;
  }
  const withoutGameWord = text.replace(GAME_QUERY_SUFFIX, "").trim();
  const names = [
    { title: text, intent: false },
    ...(withoutGameWord === text ? [] : [{ title: withoutGameWord, intent: true }]),
  ]
    .map((name) => ({ ...name, key: _normalizeName(name.title) }))
    .filter(({ key }) => key.length >= NAME_MIN_LENGTH);
  return names.length ? { kind: "pc", names } : null;
};

const _pcMinReviews = () => {
  const value = Number.parseInt(settings.pcMinReviews, 10);
  return Number.isInteger(value) && value >= 0 ? value : Number(DEFAULT_SETTINGS.pcMinReviews);
};

const _parseBangArgs = (args) => {
  const text = String(args ?? "").trim().slice(0, 100);
  const split = _splitQuery(text);
  let { hint } = split;
  const words = [...split.words];
  if (!hint && words.length > 1 && words.at(-1).toLowerCase() === "pc") {
    hint = "pc";
    words.pop();
  }
  if (!words.length) return null;

  const targets = _idTargets(words);
  if (targets) return { kind: "ids", targets };

  const title = _nameWords(words).join(" ");
  const key = _normalizeName(title);
  if (key.length < NAME_MIN_LENGTH) return null;
  const platforms = hint ? [hint] : [...ALL_PLATFORMS];
  return { kind: "name", platforms, title, key };
};

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

const _decodeXmlEntities = (text) => {
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
};

const _xmlAttribute = (text, name) =>
  new RegExp(`(?<![\\w-])${name}\\s*=\\s*"([^"]*)"`, "i").exec(text)?.[1] ?? "";

const _parseXmlTitle = (xml) => {
  const match = /<TITLE(?:\s[^>]*)?>([\s\S]*?)<\/TITLE>/i.exec(xml);
  if (!match) return "";
  const raw = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/i.exec(raw);
  return cdata ? cdata[1].trim() : _decodeXmlEntities(raw);
};

const _parseByteCount = (value) => {
  const text = String(value ?? "").trim();
  const bytes = /^\d{1,20}$/.test(text) ? Number(text) : NaN;
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
};

const _parsePackages = (xml) => {
  const packages = [];
  const pattern = /<package\b([^>]*?)(?:\/>|>([\s\S]*?)<\/package>)/gi;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const attributes = match[1] || "";
    const inner = (match[2] || "").trim();
    const pkg = {
      version: _xmlAttribute(attributes, "version"),
      size: _parseByteCount(_xmlAttribute(attributes, "size")),
    };
    const title = _parseXmlTitle(inner || xml);
    if (title) pkg.title = title;
    packages.push(pkg);
  }
  return packages;
};

const _parseLookup = (id, xml) => {
  if (typeof xml !== "string" || !xml) throw new Error("bad response");
  const status = _xmlAttribute(xml, "status");
  if (status && status !== "alive") return null;
  const titleId = _xmlAttribute(xml, "titleid");
  if (titleId && titleId.toUpperCase() !== id) return null;

  const latest = _parsePackages(xml).at(-1);
  if (!latest?.version || !latest.size) return null;
  return { id, name: latest.title || _parseXmlTitle(xml) || id, version: latest.version };
};

const _lookupPs3 = (id, fetcher) =>
  _cached(
    "patch",
    id,
    async () => {
      const response = await _httpGet(_sonyPatchUrl(id), {
        fetcher,
        headers: { Accept: "application/xml, text/xml, */*" },
      });
      if (response.status === 404 || response.status === 403) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return _parseLookup(id, response.text);
    },
    TTL.patch,
  );

const _parseYamlScalar = (raw) => {
  const text = raw.trim();
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(text);
  if (quoted) return quoted[1].replace(/\\(["\\])/g, "$1");
  return text.replace(/\s+#.*$/, "").trim();
};

const _parseGameIndex = (text) => {
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
    const value = _parseYamlScalar(field[2]);
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
};

const ps2Db = _createRemoteDb({
  name: "pcsx2",
  urls: [PCSX2_INDEX_URL],
  parse: _parseGameIndex,
  empty: () => new Map(),
});

const _lookupPs2 = async (id, fetcher) => (await ps2Db.load(fetcher)).get(id) ?? null;

const _shadStatusRank = (status) =>
  Math.max(0, SHAD_STATUS_ORDER.indexOf(String(status ?? "").replace(/^status-/, "")));

const _bestShadEntry = (record) => {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const entries = Object.entries(record)
    .filter(([, value]) => value && typeof value === "object")
    .map(([os, value]) => ({ os, ...value }));
  if (!entries.length) return null;
  return entries.reduce((best, current) => {
    const rankDiff = _shadStatusRank(current.status) - _shadStatusRank(best.status);
    if (rankDiff !== 0) return rankDiff > 0 ? current : best;
    const currentTime = Date.parse(current.last_tested || "") || 0;
    const bestTime = Date.parse(best.last_tested || "") || 0;
    return currentTime > bestTime ? current : best;
  });
};

const _parseShadDb = (text) => {
  const data = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("unexpected ShadPS4 database shape");
  }
  return data;
};

const shadDb = _createRemoteDb({
  name: "shadps4",
  urls: SHAD_DB_URLS,
  parse: _parseShadDb,
  empty: () => ({}),
  shared: true,
});

const _lookupPs4 = async (id, fetcher) => {
  const db = await shadDb.load(fetcher);
  const best = _bestShadEntry(db[id]);
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
};

const _fetchRpcs3Compatibility = (id, fetcher) =>
  _cached(
    "rpcs3",
    id,
    async () => {
      const data = await _getJson(
        `https://rpcs3.net/compatibility?api=v1&g=${encodeURIComponent(id)}`,
        { fetcher },
      );
      const results = data?.results ?? {};
      const key = Object.keys(results).find((candidate) => candidate.toUpperCase() === id);
      return key ? results[key] : null;
    },
    TTL.rpcs3,
  );

const STEAM_API_URL = "https://api.steampowered.com";
const PC_EDITION_SUFFIX =
  /[\s:–-]+(?:(?:Game of the Year|GOTY|Definitive|Enhanced|Complete|Deluxe|Ultimate|Anniversary|Special|Gold)\s+Edition|Remastered|Remaster|GOTY)\b.*$/i;

const _pcMatchKey = (name) =>
  _normalizeName(String(name ?? "").replace(/[™®©]/g, "").replace(PC_EDITION_SUFFIX, ""));

const _steamGet = (path, input, fetcher) =>
  _getJson(`${STEAM_API_URL}/${path}?input_json=${encodeURIComponent(JSON.stringify(input))}`, { fetcher });

const _steamTagNames = (fetcher) =>
  _cached(
    "steam-tags",
    "en",
    async () => {
      const data = await _getJson(`${STEAM_API_URL}/IStoreService/GetTagList/v1/?language=english`, { fetcher });
      const tags = data?.response?.tags ?? [];
      return tags.length ? Object.fromEntries(tags.map((tag) => [tag.tagid, String(tag.name)])) : null;
    },
    TTL.steam,
  );

const _steamSearch = (title, fetcher) =>
  _cached(
    "steam-search",
    _normalizeName(title),
    async () => {
      const data = await _getJson(
        `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(title)}&cc=us&l=en`,
        { fetcher },
      );
      const apps = (data?.items ?? [])
        .filter((item) => item?.type === "app" && Number.isInteger(item.id) && item.name)
        .map((item) => ({ appid: item.id, name: String(item.name) }));
      return apps.length ? apps : null;
    },
    TTL.steam,
  );

const STEAM_LANGUAGES = Object.freeze({
  ar: "arabic", bg: "bulgarian", cs: "czech", da: "danish", de: "german", el: "greek",
  en: "english", es: "spanish", fi: "finnish", fr: "french", hu: "hungarian", id: "indonesian",
  it: "italian", ja: "japanese", ko: "koreana", nb: "norwegian", nl: "dutch", no: "norwegian",
  pl: "polish", pt: "portuguese", ro: "romanian", ru: "russian", sv: "swedish", th: "thai",
  tr: "turkish", uk: "ukrainian", vi: "vietnamese", zh: "schinese",
});

const _steamLanguage = (locale) => {
  const match = /^([a-z]{2})(?:[-_]([a-z0-9]{2,3}))?$/i.exec(String(locale ?? "").trim());
  if (!match) return "english";
  const [language, region = ""] = [match[1].toLowerCase(), match[2]?.toUpperCase()];
  if (language === "pt" && region === "BR") return "brazilian";
  if (language === "zh" && ["TW", "HK", "MO"].includes(region)) return "tchinese";
  if (language === "es" && region && region !== "ES") return "latam";
  return STEAM_LANGUAGES[language] ?? "english";
};

const _steamItems = async (appids, fetcher, language = "english") => {
  const [items, tagNames] = await Promise.all([
    _cached(
      "steam-items",
      `${language}:${appids.join(",")}`,
      async () => {
        const data = await _steamGet(
          "IStoreBrowseService/GetItems/v1/",
          {
            ids: appids.map((appid) => ({ appid })),
            context: { language, country_code: "US" },
            data_request: {
              include_basic_info: true,
              include_tag_count: 3,
              include_reviews: true,
              include_platforms: true,
              include_release: true,
            },
          },
          fetcher,
        );
        const found = data?.response?.store_items ?? [];
        return found.length ? found : null;
      },
      TTL.steam,
    ),
    _steamTagNames(fetcher),
  ]);
  return (items ?? [])
    .filter((item) => Number.isInteger(item?.appid) && item.name)
    .map((item) => {
      const released = Number(item.release?.steam_release_date);
      const platforms = item.platforms ?? {};
      return {
        appid: item.appid,
        name: String(item.name),
        year: released > 0 ? String(new Date(released * 1000).getUTCFullYear()) : "",
        tags: (item.tagids ?? []).map((id) => tagNames?.[id]).filter(Boolean).slice(0, 3),
        platforms: {
          linux: Boolean(platforms.steamos_linux),
          mac: Boolean(platforms.mac),
          windows: Boolean(platforms.windows),
        },
        deck: [1, 2, 3].includes(platforms.steam_deck_compat_category) ? platforms.steam_deck_compat_category : 0,
        reviews: Number(item.reviews?.summary_filtered?.review_count) || 0,
        description: String(item.basic_info?.short_description ?? "").replace(/\s+/g, " ").trim(),
      };
    });
};

const _pcWords = (name) =>
  String(name ?? "")
    .replace(/[™®©]/g, "")
    .replace(PC_EDITION_SUFFIX, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

const _pcSimilarity = (query, name) => {
  if (_pcMatchKey(query) && _pcMatchKey(query) === _pcMatchKey(name)) return 1;
  const [q, t] = [_pcWords(query), _pcWords(name)];
  if (!q.length || !t.length) return 0;
  const _startsWith = (words, prefix) => prefix.every((word, i) => words[i] === word);
  if (_startsWith(t, q) || _startsWith(q, t)) return PC_PREFIX_SIMILARITY;
  return q.filter((word) => t.includes(word)).length / Math.max(q.length, t.length);
};

const _isConfidentPcMatch = (similarity, reviews, { minReviews, intent }) =>
  (similarity >= 1 && reviews >= minReviews) ||
  (similarity >= PC_PREFIX_SIMILARITY && reviews >= minReviews * PC_PREFIX_REVIEW_FACTOR) ||
  (similarity >= PC_MIN_SIMILARITY && reviews >= minReviews * PC_OVERLAP_REVIEW_FACTOR) ||
  (intent && similarity >= PC_PREFIX_SIMILARITY) ||
  (intent && similarity >= PC_MIN_SIMILARITY && reviews >= minReviews);

const _searchPc = async (title, key, fetcher, { plain = null, language = "english" } = {}) => {
  const found = (await _steamSearch(title, fetcher)) ?? [];
  const candidates = plain
    ? found
        .map((app) => ({ ...app, similarity: _pcSimilarity(title, app.name) }))
        .filter((app) => app.similarity >= (settings.pcLooseMatches ? PC_MIN_SIMILARITY : 1))
        .sort((a, b) => b.similarity - a.similarity)
    : _rankRows(found.filter((app) => _normalizeName(app.name).includes(key)), key);
  const ranked = candidates.slice(0, MAX_TABS);
  if (!ranked.length) return [];
  const items = await _steamItems(ranked.map((app) => app.appid), fetcher, language);
  const byId = new Map(items.map((game) => [game.appid, game]));
  return ranked
    .filter((app) => byId.has(app.appid))
    .map((app) => ({ game: { ...byId.get(app.appid), name: app.name }, similarity: app.similarity }))
    .filter(({ game, similarity }) => !plain || _isConfidentPcMatch(similarity, game.reviews, plain))
    .sort((a, b) => (plain ? b.similarity - a.similarity || b.game.reviews - a.game.reviews : 0))
    .map(({ game }) => game);
};

const _protonTier = (appid, fetcher) =>
  _cached(
    "proton",
    String(appid),
    async () => {
      const data = await _getJson(`https://www.protondb.com/api/v1/reports/summaries/${appid}.json`, { fetcher });
      const tier = String(data?.tier ?? "").toLowerCase();
      return /^[a-z]+$/.test(tier) ? tier : null;
    },
    TTL.proton,
  );

const _gogUrl = (name, fetcher) =>
  _cached(
    "gog",
    _pcMatchKey(name),
    async () => {
      const data = await _getJson(
        `https://catalog.gog.com/v1/catalog?limit=20&query=${encodeURIComponent(`like:${name}`)}&productType=in:game`,
        { fetcher },
      );
      const wanted = _pcMatchKey(name);
      const product = (data?.products ?? []).find(
        (item) => item?.slug && _pcMatchKey(item.title) === wanted && /^[a-z0-9_-]+$/i.test(item.slug),
      );
      return product ? `https://www.gog.com/en/game/${product.slug}` : null;
    },
    TTL.gog,
  );

const WIKI_URL = "https://en.wikipedia.org";
const _wikiSlug = (title) => encodeURIComponent(title).replace(/%20/g, "_");

const _searchWikipediaTitles = async (title, hint, fetcher) => {
  const query = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: `${title} ${hint} video game`,
    srlimit: "5",
    format: "json",
  });
  try {
    const data = await _getJson(`${WIKI_URL}/w/api.php?${query}`, { fetcher });
    const titles = (data?.query?.search ?? []).map((item) => item.title).filter(Boolean);
    const needle = title.toLowerCase();
    const exact = titles.filter(
      (candidate) => candidate.toLowerCase().replace(/\s*\(.*\)$/, "").trim() === needle,
    );
    return exact.length ? exact : titles.slice(0, 3);
  } catch (error) {
    _debug("wikipedia search failed:", error);
    return [title];
  }
};

const _wikiLanguage = (locale) => {
  const match = /^([a-z]{2,3})(?:[-_][a-z0-9]+)?$/i.exec(String(locale ?? "").trim());
  return match ? match[1].toLowerCase() : "en";
};

const _wikiBase = (language) => `https://${language}.wikipedia.org`;

const _getWikipediaSummary = async (title, fetcher, language = "en") => {
  const base = _wikiBase(language);
  const data = await _getJson(`${base}/api/rest_v1/page/summary/${_wikiSlug(title)}`, { fetcher });
  if (!data?.extract || data.type === "disambiguation") return null;
  return {
    extract: String(data.extract),
    url: _safeUrl(data.content_urls?.desktop?.page, `${language}.wikipedia.org`) || `${base}/wiki/${_wikiSlug(title)}`,
  };
};

const _wikiTranslationTitle = async (title, language, fetcher) => {
  const query = new URLSearchParams({
    action: "query",
    titles: title,
    prop: "langlinks",
    lllang: language,
    redirects: "1",
    format: "json",
  });
  const data = await _getJson(`${WIKI_URL}/w/api.php?${query}`, { fetcher });
  const page = Object.values(data?.query?.pages ?? {})[0];
  const translated = page?.langlinks?.[0]?.["*"];
  return translated ? String(translated) : null;
};

const _loadWikipediaSummary = async (title, hint, fetcher, language = "en") => {
  let found = null;
  for (const candidate of await _searchWikipediaTitles(title, hint, fetcher)) {
    const summary = await _getWikipediaSummary(candidate, fetcher);
    if (!summary) continue;
    const isGame = /video game|PlayStation/i.test(summary.extract);
    if (isGame || !found) found = { candidate, summary };
    if (isGame) break;
  }
  if (!found || language === "en") return found?.summary ?? null;
  try {
    const translated = await _wikiTranslationTitle(found.candidate, language, fetcher);
    const local = translated ? await _getWikipediaSummary(translated, fetcher, language) : null;
    return local ?? found.summary;
  } catch (error) {
    _debug(`no ${language} Wikipedia summary for "${found.candidate}":`, error);
    return found.summary;
  }
};

const _fetchWikiSummary = (title, fetcher, hint = "PS3", language = "en") => {
  const name = String(title ?? "").trim();
  if (!name) return Promise.resolve(null);
  return _cached(
    "wiki",
    `${language}:${hint}:${name.toLowerCase()}`,
    () => _loadWikipediaSummary(name, hint, fetcher, language),
    TTL.wiki,
  );
};

const _sgdbRequest = (fetcher) => ({
  fetcher,
  headers: { Authorization: `Bearer ${settings.steamGridDbApiKey}` },
});

const _isArtworkUrl = (value) => _safeUrl(value, SGDB_DOMAIN).startsWith("https://");

const _expandAbbreviations = (title) => {
  const tokens = String(title ?? "").match(/[A-Za-z]+|\d+/g) ?? [];
  return tokens
    .map((token) => ARTWORK_ABBREVIATIONS[token.toLowerCase()] ?? token)
    .join(" ")
    .trim();
};

const _artworkSearchTerms = (title) => {
  const raw = String(title ?? "").trim();
  const terms = [raw, raw.replace(ARTWORK_EDITION_SUFFIX, "").trim(), _expandAbbreviations(raw)];
  return [...new Set(terms.filter(Boolean))];
};

const _pickArtworkGame = (entries, term) => {
  const wanted = _normalizeName(term);
  if (!wanted || !Array.isArray(entries)) return null;
  return entries.find((game) => game?.id && _normalizeName(game.name) === wanted) ?? null;
};

const _findArtwork = async (title, fetcher) => {
  for (const term of _artworkSearchTerms(title)) {
    const search = await _getJson(
      `${SGDB_API_URL}/search/autocomplete/${encodeURIComponent(term)}`,
      _sgdbRequest(fetcher),
    );
    const game = _pickArtworkGame(search?.data, term);
    if (!game) continue;

    const grids = await _getJson(
      `${SGDB_API_URL}/grids/game/${game.id}?dimensions=${SGDB_GRID_DIMENSIONS}`,
      _sgdbRequest(fetcher),
    );
    const grid = (grids?.data ?? []).find((item) => _isArtworkUrl(item?.url));
    if (grid) return { title: String(game.name), url: grid.url };
  }
  return null;
};

const _resolveSteamArtwork = (appid, fetcher) => {
  if (!settings.steamGridDbApiKey || !Number.isInteger(appid)) return Promise.resolve(null);
  return _cached(
    "artwork",
    `steam:${appid}`,
    async () => {
      const grids = await _getJson(
        `${SGDB_API_URL}/grids/steam/${appid}?dimensions=${SGDB_GRID_DIMENSIONS}`,
        _sgdbRequest(fetcher),
      );
      const grid = (grids?.data ?? []).find((item) => _isArtworkUrl(item?.url));
      return grid ? { url: grid.url } : null;
    },
    TTL.artwork,
  );
};

const _resolveArtwork = (title, fetcher) => {
  const name = String(title ?? "").trim();
  if (!settings.steamGridDbApiKey || !name) return Promise.resolve(null);
  return _cached("artwork", name.toLowerCase(), () => _findArtwork(name, fetcher), TTL.artwork);
};

const _toTone = (raw) => {
  const tone = String(raw ?? "")
    .toLowerCase()
    .replace(/^status-/, "")
    .replace(/[^a-z]/g, "");
  return COMPAT_TONES.has(tone) ? tone : "unknown";
};

const _regionOf = (platform, id, rawRegion = "") => {
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
};

const _resolvePs3Card = async (id, fetcher) => {
  const wantsVersion = settings.showDetails && settings.showVersion;
  const [patch, compat] = await Promise.all([
    wantsVersion ? _lookupPs3(id, fetcher) : null,
    settings.showCompatibility ? _fetchRpcs3Compatibility(id, fetcher) : null,
  ]);
  if (!patch && !compat) return null;

  const compatPage = `https://rpcs3.net/compatibility?g=${encodeURIComponent(id)}`;
  const wikiPage = compat?.title
    ? `https://wiki.rpcs3.net/index.php?title=${_wikiSlug(String(compat.title).trim())}`
    : "";
  return {
    id,
    platform: "ps3",
    region: _regionOf("ps3", id),
    name: String(compat?.title || patch?.name || id),
    version: patch?.version ?? "",
    compat: compat?.status
      ? { labelKey: "compatibilityRpcs3", tone: _toTone(compat.status), url: wikiPage }
      : null,
    links: (wiki) => ({
      page: wiki?.url || compatPage,
      more: wiki?.url || (compat ? compatPage : ""),
    }),
  };
};

const _resolvePs2Card = async (id, fetcher) => {
  const info = await _lookupPs2(id, fetcher);
  if (!info) return null;
  return {
    id,
    platform: "ps2",
    region: _regionOf("ps2", id, info.region),
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
};

const _resolvePs4Card = async (id, fetcher) => {
  const info = await _lookupPs4(id, fetcher);
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
      ? { labelKey: "compatibilityShadps4", tone: _toTone(info.status), url: "" }
      : null,
    links: (wiki, emuWiki) => ({ page: emuWiki || wiki?.url || issueUrl, more: issueUrl }),
  };
};

const PLATFORMS = Object.freeze({
  ps2: { wikiHint: "PS2", adoptArtworkTitle: true, resolve: _resolvePs2Card },
  ps3: { wikiHint: "PS3", adoptArtworkTitle: false, resolve: _resolvePs3Card },
  ps4: { wikiHint: "PS4", adoptArtworkTitle: true, resolve: _resolvePs4Card },
});

const _wikiTitle = (name) =>
  String(name ?? "")
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const _findEmulatorWikiPage = (platform, name, fetcher) => {
  const buildUrl = EMULATOR_WIKIS[platform];
  const title = _wikiTitle(name);
  if (!buildUrl || !title) return Promise.resolve(null);
  return _cached(
    "emulator-wiki",
    `${platform}:${title}`,
    async () => {
      const url = buildUrl(title);
      const response = await _httpGet(url, { fetcher, method: "HEAD" });
      if (response.ok) return url;
      if (response.status === 404) return null;
      throw new Error(`HTTP ${response.status} for ${url}`);
    },
    TTL.emuWiki,
  );
};

const _searchPs2 = async (_title, key, fetcher) => {
  const db = await ps2Db.load(fetcher);
  const rows = [];
  for (const entry of db.values()) {
    if (!_normalizeName(entry.name).includes(key)) continue;
    rows.push({
      id: entry.id,
      platform: "ps2",
      name: entry.name,
      region: _regionOf("ps2", entry.id, entry.region),
      tone: PCSX2_TONES[entry.compat] ?? "unknown",
      url: "",
      compatUrl: "",
    });
  }
  return rows;
};

const _searchPs4 = async (_title, key, fetcher) => {
  const db = await shadDb.load(fetcher);
  const rows = [];
  for (const id of Object.keys(db)) {
    if (!/^CUSA\d{5}$/.test(id)) continue;
    const best = _bestShadEntry(db[id]);
    if (!best?.name || !_normalizeName(best.name).includes(key)) continue;
    const issue = String(best.issue_number || "").trim();
    rows.push({
      id,
      platform: "ps4",
      name: String(best.name).trim(),
      region: null,
      tone: _toTone(best.status),
      url: "",
      compatUrl: issue ? `${SHAD_REPO_URL}/issues/${encodeURIComponent(issue)}` : "",
    });
  }
  return rows;
};

const _searchPs3 = async (title, key, fetcher) => {
  const rows = await _cached(
    "rpcs3-search",
    key,
    async () => {
      const data = await _getJson(
        `https://rpcs3.net/compatibility?api=v1&g=${encodeURIComponent(title)}&r=${RPCS3_SEARCH_LIMIT}`,
        { fetcher },
      );
      const found = Object.entries(data?.results ?? {})
        .filter(([id, entry]) => /^[A-Z]{4}\d{5}$/.test(id) && entry?.title)
        .filter(([, entry]) => _normalizeName(entry.title).includes(key))
        .map(([id, entry]) => ({
          id,
          platform: "ps3",
          name: String(entry.title).trim(),
          region: _regionOf("ps3", id),
          tone: _toTone(entry.status),
          url: `https://rpcs3.net/compatibility?g=${encodeURIComponent(id)}`,
          compatUrl: "",
        }));
      return found.length ? found : null;
    },
    TTL.rpcs3,
  );
  return rows ?? [];
};

const NAME_SEARCHERS = Object.freeze({ ps2: _searchPs2, ps3: _searchPs3, ps4: _searchPs4 });

const _rankRows = (rows, key) => {
  const score = (row) => {
    const name = _normalizeName(row.name);
    if (name === key) return 0;
    return name.startsWith(key) ? 1 : 2;
  };
  return rows
    .map((row) => ({ row, score: score(row) }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.row.name.localeCompare(b.row.name) ||
        String(a.row.id ?? a.row.appid).localeCompare(String(b.row.id ?? b.row.appid)),
    )
    .map(({ row }) => row);
};

const _searchTitles = async (platform, title, key, fetcher) => {
  const rows = await NAME_SEARCHERS[platform](title, key, fetcher);
  return _rankRows(rows, key).slice(0, MAX_NAME_RESULTS);
};

const _addWikiLinks = async (rows, fetcher) => {
  await Promise.all(
    rows.map(async (row) => {
      const page = await _findEmulatorWikiPage(row.platform, row.name, fetcher);
      if (page) row.url = page;
    }),
  );
  return rows;
};

const ENGLISH = (() => {
  try {
    const file = new URL("./locales/en.json", import.meta.url);
    return JSON.parse(readFileSync(file, "utf8"))[I18N_NAMESPACE] ?? null;
  } catch (error) {
    _debug("could not read locales/en.json:", error);
    return null;
  }
})();

const _t = (key) => {
  const english = settings.browserLanguage ? null : key.split(".").reduce((node, part) => node?.[part], ENGLISH);
  return typeof english === "string" ? _escapeHtml(english) : `{{ t:${I18N_NAMESPACE}.${key} }}`;
};

const _renderTemplate = (values) =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? "");

const _detailRow = (labelKey, valueHtml) =>
  `<div class="ps3-detail"><dt class="ps3-label">${_t(`labels.${labelKey}`)}</dt>` +
  `<dd class="ps3-value">${valueHtml}</dd></div>`;

const _compatBadge = ({ tone, url }) => {
  const className = `ps3-compat ps3-compat--${tone}`;
  const label = _t(`compat.${tone}`);
  return url
    ? `<a class="${className}" href="${_escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : `<span class="${className}">${label}</span>`;
};

const _renderCompat = ({ labelKey, tone, url }) => _detailRow(labelKey, _compatBadge({ tone, url }));

const _renderRegion = (region) =>
  settings.showRegion && region
    ? `<span class="degoog-badge ps3-region ps3-region--${region}">${_t(`region.${region}`)}</span>`
    : "";

const _compatEnabled = (platform) =>
  settings.showDetails && (platform === "ps2" ? settings.showCompat : settings.showCompatibility);

const _renderTitleRow = (row) => {
  const name = row.url
    ? `<a class="ps3-row-name" href="${_escapeHtml(row.url)}" target="_blank" rel="noopener noreferrer">${_escapeHtml(row.name)}</a>`
    : `<span class="ps3-row-name">${_escapeHtml(row.name)}</span>`;
  const compat =
    _compatEnabled(row.platform) && row.tone !== "unknown"
      ? _compatBadge({ tone: row.tone, url: row.compatUrl })
      : "";
  return (
    `<li class="ps3-row">${_renderRegion(row.region)}` +
    `<span class="ps3-id">${_escapeHtml(row.id)}</span>${name}${compat}</li>`
  );
};

const TONE_RANK = ["unknown", "nothing", "loadable", "intro", "boots", "menus", "ingame", "playable", "perfect"];
const REGION_RANK = ["jp", "eu", "us"];

const _bestRow = (rows) => {
  const score = (row) => [TONE_RANK.indexOf(row.tone), REGION_RANK.indexOf(row.region)];
  return rows.reduce((best, row) => {
    const [a, b] = [score(row), score(best)];
    return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? row : best;
  });
};

const _renderOtherIds = (rows) =>
  `<details class="ps3-card ps3-others">` +
  `<summary class="ps3-others-toggle">${_t("nameSearch.showOtherIds")} (${rows.length})</summary>` +
  `<ul class="ps3-list">${rows.map(_renderTitleRow).join("")}</ul></details>`;

const _renderPsResult = async (platform, rows, fetcher, context) => {
  const topName = _normalizeName(rows[0].name);
  const best = _bestRow(rows.filter((row) => _normalizeName(row.name) === topName));
  const card = await _withTimeout(_renderTarget({ platform, id: best.id }, fetcher, context), CARD_TIMEOUT_MS).catch(
    () => "",
  );
  if (!card) return _renderNameResults(platform, rows);
  const others = rows.filter((row) => row !== best);
  return others.length ? `${card}${_renderOtherIds(others)}` : card;
};

const _renderNameResults = (platform, rows) =>
  `<div class="ps3-card ps3-results">` +
  `<div class="ps3-kicker"><span class="ps3-platform">${_t(`platform.${platform}`)}</span>` +
  `<span>${_t("nameSearch.heading")}</span></div>` +
  `<ul class="ps3-list">${rows.map(_renderTitleRow).join("")}</ul>` +
  `<p class="ps3-hint">${_t("nameSearch.hint")}</p></div>`;

const _renderUsage = () =>
  `<div class="ps3-card">` +
  `<p class="ps3-hint">${_t("nameSearch.usage")} <code>!game god of war</code></p>` +
  `<p class="ps3-hint">${_t("nameSearch.narrow")} <code>!game god of war ps2</code></p></div>`;

const _renderNotice = (messageKey, detailHtml = "") =>
  `<div class="ps3-card"><p class="ps3-hint">${_t(messageKey)} ${detailHtml}</p></div>`;

const _stack = (blocks) => (blocks.length === 1 ? blocks[0] : `<div class="ps3-stack">${blocks.join("")}</div>`);

const _coverImg = (url) =>
  url
    ? `<img class="ps3-cover" src="${_escapeHtml(url)}" alt="" width="120" height="170" loading="eager" decoding="async">`
    : "";

const _externalLink = (url, labelHtml) =>
  `<a class="ps3-more" href="${_escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${labelHtml} ${EXTERNAL_ICON}</a>`;

const DECK_STATUS = Object.freeze({ 0: "unknown", 1: "unsupported", 2: "playable", 3: "verified" });

const DECK_ICON_SHAPES = Object.freeze({
  verified:
    '<circle cx="12" cy="12" r="11" fill="#59BF40"/>' +
    '<path d="M7 12.5l3.3 3.3L17.2 9" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  playable:
    '<circle cx="12" cy="12" r="11" fill="#FFC82C"/>' +
    '<circle cx="12" cy="7.3" r="1.6" fill="#1B2838"/><rect x="10.6" y="10.2" width="2.8" height="7.6" rx="1.4" fill="#1B2838"/>',
  unsupported:
    '<circle cx="12" cy="12" r="11" fill="#8B929A"/>' +
    '<circle cx="12" cy="12" r="5.6" fill="none" stroke="#fff" stroke-width="2.2"/><path d="M8.2 15.8l7.6-7.6" stroke="#fff" stroke-width="2.2"/>',
  unknown:
    '<circle cx="12" cy="12" r="11" fill="#8B929A"/>' +
    '<path d="M9.4 9.4a2.6 2.6 0 1 1 3.8 2.3c-.8.4-1.2 1-1.2 1.8v.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>' +
    '<circle cx="12" cy="17.3" r="1.3" fill="#fff"/>',
});

const _renderDeckStatus = (deck) => {
  const status = DECK_STATUS[deck] ?? "unknown";
  return (
    `<span class="ps3-deck" tabindex="0">` +
    `<svg class="ps3-deck-icon ps3-deck-icon--${status}" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">` +
    `${DECK_ICON_SHAPES[status]}</svg><span class="ps3-deck-label">${_t(`deck.${status}`)}</span></span>`
  );
};

const _renderOsList = ({ appid, platforms }, proton) => {
  const os = (label, ok) => `<span class="ps3-os">${label} ${ok ? "✓" : "✗"}</span>`;
  const linux =
    !platforms.linux && proton
      ? `<a class="ps3-os" href="https://www.protondb.com/app/${appid}" target="_blank" rel="noopener noreferrer">` +
        `Linux (Proton ${_escapeHtml(proton[0].toUpperCase() + proton.slice(1))})</a>`
      : os("Linux", platforms.linux);
  return `${linux} ${os("macOS", platforms.mac)} ${os("Windows", platforms.windows)}`;
};

const _renderPcCard = async (game, fetcher, context) => {
  const steamUrl = `https://store.steampowered.com/app/${game.appid}/`;
  const [artwork, proton, gog] = await Promise.all([
    settings.showCover ? _resolveSteamArtwork(game.appid, fetcher) : null,
    settings.showDetails && !game.platforms.linux ? _protonTier(game.appid, fetcher) : null,
    _gogUrl(game.name, fetcher),
  ]);

  const rows = [];
  if (settings.showDetails) {
    if (game.tags.length) rows.push(_detailRow("genre", _escapeHtml(game.tags.join(" · "))));
    rows.push(_detailRow("platforms", _renderOsList(game, proton)));
    rows.push(_detailRow("steamDeck", _renderDeckStatus(game.deck)));
  }

  return _renderTemplate({
    id: _escapeHtml(game.year),
    name: _escapeHtml(game.name),
    url: _escapeHtml(steamUrl),
    platform: _t("platform.pc"),
    region: "",
    cover: _coverImg(
      artwork?.url && typeof context?.signProxyUrl === "function" ? context.signProxyUrl(artwork.url) : "",
    ),
    details: rows.length ? `<dl class="ps3-details">${rows.join("")}</dl>` : "",
    description:
      settings.showDescription && game.description
        ? `<p class="ps3-description">${_escapeHtml(game.description)}</p>`
        : "",
    linkBlock:
      `<div class="ps3-links">${_externalLink(steamUrl, _t("viewSteam"))}` +
      `${gog ? _externalLink(gog, _t("viewGog")) : ""}</div>`,
  });
};

let tabGroupSeq = 0;

const _renderTabs = (tabs) => {
  if (tabs.length === 1) return tabs[0].panel;
  const group = `ps3-tabs-${++tabGroupSeq}`;
  const id = (i) => `${group}-${i}`;
  const inputs = tabs
    .map((_, i) => `<input type="radio" class="ps3-tab-input" name="${group}" id="${id(i)}"${i === 0 ? " checked" : ""}>`)
    .join("");
  const labels = tabs
    .map((tab, i) => `<label class="ps3-tab-label" for="${id(i)}">${_escapeHtml(tab.label)}</label>`)
    .join("");
  const panels = tabs.map((tab) => `<div class="ps3-tab-panel">${tab.panel}</div>`).join("");
  return `<div class="ps3-tabs">${inputs}<div class="ps3-tab-bar">${labels}</div><div class="ps3-tab-panels">${panels}</div></div>`;
};

const _pcTabs = async (games, fetcher, context) => {
  const panels = await Promise.all(
    games.map((game) =>
      _withTimeout(_renderPcCard(game, fetcher, context), CARD_TIMEOUT_MS).catch((error) => {
        _debug(`could not render PC game ${game.appid}:`, error);
        return "";
      }),
    ),
  );
  return games
    .map((game, i) => ({ label: `${game.name} (PC${game.year ? `, ${game.year}` : ""})`, panel: panels[i] }))
    .filter((tab) => tab.panel);
};

const _renderCard = (card, { wiki, emuWiki, coverUrl }) => {
  const links = card.links(wiki, emuWiki);

  const rows = [];
  if (settings.showDetails) {
    if (card.compat) rows.push(_renderCompat(card.compat));
    if (settings.showVersion && card.version) {
      rows.push(_detailRow("version", _escapeHtml(card.version)));
    }
  }

  return _renderTemplate({
    id: _escapeHtml(card.id),
    name: _escapeHtml(card.name),
    url: _escapeHtml(links.page),
    platform: _t(`platform.${card.platform}`),
    region: _renderRegion(card.region),
    cover: _coverImg(coverUrl),
    details: rows.length ? `<dl class="ps3-details">${rows.join("")}</dl>` : "",
    description:
      settings.showDescription && wiki?.extract
        ? `<p class="ps3-description">${_escapeHtml(wiki.extract)}</p>`
        : "",
    linkBlock: links.more
      ? `<a class="ps3-more" href="${_escapeHtml(links.more)}" rel="noopener noreferrer">${_t("viewPage")} ${EXTERNAL_ICON}</a>`
      : "",
  });
};

const _renderTarget = async ({ platform: key, id }, fetcher, context) => {
  const platform = PLATFORMS[key];
  try {
    const card = await platform.resolve(id, fetcher);
    if (!card) return "";

    const wantsCover = settings.showCover && Boolean(settings.steamGridDbApiKey);
    const artworkTask = wantsCover ? _resolveArtwork(card.name, fetcher) : Promise.resolve(null);
    if (platform.adoptArtworkTitle) {
      const artwork = await artworkTask;
      if (artwork?.title) card.name = artwork.title;
    }
    const [artwork, wiki, emuWiki] = await Promise.all([
      artworkTask,
      settings.showDescription
        ? _fetchWikiSummary(card.name, fetcher, platform.wikiHint, settings.browserLanguage ? _wikiLanguage(context?.locale) : "en")
        : null,
      _findEmulatorWikiPage(key, card.name, fetcher),
    ]);

    const coverUrl =
      artwork?.url && typeof context?.signProxyUrl === "function"
        ? context.signProxyUrl(artwork.url)
        : "";
    return _renderCard(card, { wiki, emuWiki, coverUrl });
  } catch (error) {
    _debug(`could not render ${id}:`, error);
    return "";
  }
};

const _renderTargets = async (targets, fetcher, context) => {
  const cards = (
    await Promise.all(
      targets.map((target) =>
        _withTimeout(_renderTarget(target, fetcher, context), CARD_TIMEOUT_MS).catch(() => ""),
      ),
    )
  ).filter(Boolean);
  return cards.length ? _stack(cards) : "";
};

const _renderNameSearch = async ({ platforms, title, key }, fetcher, context, plain = null) => {
  const failed = (platform) => (error) => {
    _debug(`${platform} name search failed for "${title}":`, error);
    return [];
  };
  const pcSearch = platforms.includes("pc")
    ? _searchPc(title, key, fetcher, {
        plain,
        language: settings.browserLanguage ? _steamLanguage(context?.locale) : "english",
      }).catch(failed("pc"))
    : Promise.resolve([]);
  if (plain && !(await pcSearch).length) return "";
  const exact = _pcMatchKey(title);
  const psTabs = (
    await Promise.all(
      platforms
        .filter((platform) => platform !== "pc")
        .map((platform) =>
          _searchTitles(platform, title, key, fetcher)
            .then((rows) => (plain ? rows.filter((row) => _pcMatchKey(row.name) === exact) : rows))
            .then(async (rows) =>
              rows.length
                ? [{
                    label: `${rows[0].name} (${platform.toUpperCase()})`,
                    panel: await _renderPsResult(platform, await _addWikiLinks(rows, fetcher), fetcher, context),
                  }]
                : [],
            )
            .catch(failed(platform)),
        ),
    )
  ).flat();
  const pcRoom = MAX_TABS - psTabs.length;
  const pc = pcRoom > 0 ? await _pcTabs((await pcSearch).slice(0, pcRoom), fetcher, context) : [];
  const tabs = [...pc, ...psTabs].slice(0, MAX_TABS);
  if (tabs.length) return _renderTabs(tabs);
  return plain ? "" : _renderNotice("nameSearch.empty", `<strong>${_escapeHtml(title)}</strong>`);
};

const _runBang = async (args, context = {}) => {
  const text = String(args ?? "").trim();
  let title = `Games${text ? `: ${text}` : ""}`;
  let html;
  try {
    const parsed = _parseBangArgs(text);
    if (!parsed) {
      html = _renderUsage();
    } else if (parsed.kind === "ids") {
      html =
        (await _renderTargets(parsed.targets, pluginFetch, context)) ||
        _renderNotice("nameSearch.empty", `<strong>${_escapeHtml(text)}</strong>`);
    } else {
      const label = parsed.platforms.length === 1 ? PLATFORM_LABELS[parsed.platforms[0]] : "Games";
      title = `${label}: ${parsed.title}`;
      html = await _renderNameSearch(parsed, pluginFetch, context);
    }
  } catch (error) {
    _debug(`!game ${text} failed:`, error);
    html = _renderNotice("nameSearch.empty", `<strong>${_escapeHtml(text)}</strong>`);
  }
  return { title, html };
};

async function _clearCaches() {
  await Promise.all([...caches.values()].map((cache) => _safely(() => cache.clear())));
  caches.clear();
  inflight.clear();
  ps2Db.reset();
  shadDb.reset();
}

function _setup(ctx) {
  template = typeof ctx?.template === "string" ? ctx.template : "";
  pluginFetch = typeof ctx?.fetch === "function" ? ctx.fetch : null;
  cacheFactory = typeof ctx?.useCache === "function" ? ctx.useCache : null;
  caches.clear();
}

function _configure(next) {
  const previousKey = settings.steamGridDbApiKey;
  const values = next ?? {};
  settings = Object.fromEntries(
    SETTINGS_SCHEMA.map((field) => [
      field.key,
      field.type === "toggle"
        ? _parseToggle(values[field.key], DEFAULT_SETTINGS[field.key])
        : String(values[field.key] ?? DEFAULT_SETTINGS[field.key]).trim(),
    ]),
  );
  if (previousKey && settings.steamGridDbApiKey !== previousKey) {
    void _safely(() => _getCache("artwork").clear());
  }
}

export const slot = {
  id: PLUGIN_ID,
  name: "EmuCompat",
  description:
    "Looks up PlayStation 2, 3 and 4 title IDs and PC game names: emulator compatibility (PCSX2, RPCS3, ShadPS4), the latest PS3 patch version, Steam and ProtonDB details and SteamGridDB cover art.",
  isClientExposed: false,
  supportsNojs: true,
  position: "at-a-glance",
  slotPositions: ["at-a-glance", "above-results", "above-sidebar", "below-sidebar"],
  settingsSchema: SETTINGS_SCHEMA,

  init: _setup,
  configure: _configure,

  trigger(query) {
    return _analyzeQuery(query) !== null;
  },

  async execute(query, context) {
    const analysis = _analyzeQuery(query);
    if (!analysis || !template) return EMPTY_RESULT;
    const fetcher = context?.fetch ?? pluginFetch;
    if (analysis.kind === "ids") {
      const html = await _renderTargets(analysis.targets, fetcher, context);
      return html ? { title: "", html } : EMPTY_RESULT;
    }
    const minReviews = _pcMinReviews();
    const _firstMatch = async () => {
      for (const name of analysis.names) {
        const plain = { minReviews, intent: name.intent };
        const html = await _renderNameSearch({ ...name, platforms: ALL_PLATFORMS }, fetcher, context, plain);
        if (html) return html;
      }
      return "";
    };
    try {
      const html = await _withTimeout(_firstMatch(), CARD_TIMEOUT_MS);
      return html ? { title: "", html } : EMPTY_RESULT;
    } catch (error) {
      _debug(`plain search failed for "${analysis.names[0].title}":`, error);
      return EMPTY_RESULT;
    }
  },
};

const gameCommand = {
  name: "Game Lookup",
  description:
    "Search PC, PS2, PS3 and PS4 games by name or title ID. Add pc, ps2, ps3 or ps4 to narrow it down.",
  trigger: "game",
  supportsNojs: true,
  respectRateLimiting: true,
  init: _setup,
  execute: (args, context) => _runBang(args, context),
};

export const _internals = {
  identify: _identify,
  parseBangArgs: _parseBangArgs,
  parseLookup: _parseLookup,
  parseGameIndex: _parseGameIndex,
  bestShadEntry: _bestShadEntry,
  regionOf: _regionOf,
  clearCaches: _clearCaches,
  pcMatchKey: _pcMatchKey,
  bestRow: _bestRow,
  steamLanguage: _steamLanguage,
  wikiLanguage: _wikiLanguage,
  searchPc: _searchPc,
  protonTier: _protonTier,
  gogUrl: _gogUrl,
};

export default gameCommand;
