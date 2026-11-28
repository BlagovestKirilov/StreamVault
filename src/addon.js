/**
 * addon.js — Main Stremio IPTV addon entry point.
 *
 * Configuration is done entirely within Stremio's UI.
 * No browser needed — just add the manifest URL in Stremio and configure there.
 */

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { ROOT, safeError, userAgent, parseExtra, maskPath, trimPathSpaces, withinMs } = require("./util");
const alerts = require("./alerts");
const {
  encryptConfig, decryptConfig, configFromSettings, settingsFromEncrypted, settingsFromBase64,
  configFromQueryString, normalizeXtreamLogin, MAX_HOME_ROWS,
} = require("./configlink");
const {
  STATS_DIR, stats, userKey, setupKey, knownUser, uniqueCounts, addDailyUser, noteBareUser, noteSetupStep, noteSetupDone, countToday,
  countCode, countKey, primaryLanguage, noteRecent, saveStats, saveStatsSync, recentErrors, recentUnknownPaths,
  recentEmptyStreams, recentUnconfigured, recentPlayRejects, recentBadLinks, recentTestFailures,
} = require("./stats");
const {
  m3uCache, M3U_CACHE_MAX, xtreamCache, XTREAM_CACHE_MAX, EPG_CACHE_MAX, epgCache, accountCache,
  setCapped, touch, inflight, MAX_PARALLEL_DOWNLOADS, downloadsRunningNow, downloadQueue,
  failCache, handleProviderError, HEAP_WARN_MB, HEAP_CRIT_MB, memStats, checkMemory, m3uCacheKey,
} = require("./cache");
const {
  NOTICES, classifyError, SETUP_PLAY_STREAM, noticeMeta, ACCOUNT_WAIT_MS, accountNotice,
  accountProblem,
} = require("./notices");
const {
  xtreamCategoryIds, getXtreamCatalog, epgTimeRange, getXtreamAccount, getXtreamMeta, incompleteMetas,
  getXtreamStreams, xtreamCacheKey,
} = require("./xtream-addon");
const { getM3UCatalog, getM3UMeta, getM3UStreams } = require("./m3u-addon");
const { registerApiRoutes, formatAccountInfo } = require("./api");
const prometheus = require("./prometheus");
const xtream = require("./xtream");
const {
  makePosterUrl, cleanName, keepsTags, catalogView, catalogMeta, searchKey, channelSearchKey,
} = require("./catalog");
const STATS_SECRET = process.env.STATS_SECRET || "";

const {
  isPrivateIp, validateExternalUrl, isExternalUrlSyntax, trimTrailingSlashes, preferredUrl,
} = require("./urlguard");

const compression = require("compression");

const app = express();
app.disable("x-powered-by"); // don't advertise the framework/version
const PORT = process.env.PORT || 7000;
// Internal Prometheus endpoint for Fly's metrics (fly.toml [metrics]); not public
const METRICS_PORT = Number(process.env.METRICS_PORT) || 9091;
const metrics = require("./metrics");
app.set("trust proxy", true);

// --- Gzip compression (shrinks catalog/meta JSON egress) ---
app.use(compression());

// --- CORS headers (required for Stremio) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Count every error response StreamVault sends, per day, endpoint and status ---
// (400 bad config, 404, 429 rate-limited, ...) — saved with the stats history.
// The endpoint is the route pattern ("GET /:config/catalog/:type/:id.json"), never
// the raw URL: that keeps the list short and users' install links out of stats.
// Route pattern for the error counts (never the raw URL — install links hold settings)
function errorEndpoint(req) {
  if (req.route) return `${req.method} ${req.route.path}`;
  // A body refused before routing (too large / not JSON) still names its API route
  if (req.method === "POST" && /^\/api\/[a-z0-9-]+$/.test(req.path)) return `POST ${req.path}`;
  return "unknown path";
}

app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    // Every response: count + duration for the metrics, by route pattern
    const route = req.route ? `${req.method} ${req.route.path}` : `${req.method} unmatched`;
    metrics.observeRequest(route, res.statusCode, Number(process.hrtime.bigint() - started) / 1e9);
    if (res.statusCode < 400 || req.path === "/health" || res.locals.skipErrorCount) return;
    countCode("responseErrors", errorEndpoint(req), String(res.statusCode));
  });
  next();
});

// --- JSON body parser (with size limit) ---
app.use(express.json({ limit: "16kb" }));
// A refused body gets a short JSON answer the configure page can show — not
// Express's default HTML page plus a stack trace in the logs. Real form data is
// far below 16 KB; the usual cause is playlist text pasted instead of its link.
app.use((err, _req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ ok: false, error: "Too much text sent — paste the playlist link (http://…), not the playlist itself." });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid request" });
  }
  next(err);
});

// An install link pasted with a stray space ("/<link>/%20manifest.json"): apps then
// ask for "/<link>/%20/catalog/…" too, so it's cleaned on every request. Install
// links never contain spaces; a space inside a part (a search) is left alone.
app.use((req, _res, next) => {
  const clean = trimPathSpaces(req.path);
  if (clean !== req.path) req.url = clean + req.url.slice(req.path.length);
  next();
});

// Some apps build resource URLs from the full manifest URL instead of its folder:
// "/<config>/manifest.json/meta/tv/x.json". Treat it as "/<config>/meta/tv/x.json".
app.use((req, _res, next) => {
  if (req.url.includes("/manifest.json/")) req.url = req.url.replace("/manifest.json/", "/");
  next();
});

// --- Health check for Fly.io (must be unauthenticated for Fly's built-in checks) ---
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// --- Client IP + per-IP limits (see ratelimit.js) ---
const {
  getIp, maskIp, rateLimit,
} = require("./ratelimit");
const MINUTE = 60 * 1000;
const limitProviderChecks = rateLimit("provider-check", 10, MINUTE); // each downloads from the provider
const limitConfig = rateLimit("config", 30, MINUTE);
const limitStats = rateLimit("stats", 5, MINUTE);                    // slows guessing STATS_SECRET
// Stremio requests are cheap (served from cache) but bursty: some apps preload the
// channel page of every channel in a catalog page. 300/min blocked real users.
const limitAddon = rateLimit("addon", 1500, MINUTE);
// The configure/setup pages, their files, icons, robots.txt, the Ko-fi link and
// unknown paths: cheap, but were open to anyone. A page visit is ~6 files.
const limitPages = rateLimit("pages", 120, MINUTE);

// --- SSRF protection: see urlguard.js (also enforced inside m3u.js / xtream.js) ---

// --- Serve static files (logo, images) ---
// The configure page (html/css/js) is checked on every visit ("no-cache") with an
// ETag made from the file's CONTENT: any deploy that changes a file gives it a new
// ETag, so browsers fetch it at once — whatever the file dates in the image are
// (a size+mtime ETag could call a same-size change "unchanged"). Unchanged files
// cost a tiny 304. With the 7-day cache below, a deploy could pair the new page
// with yesterday's script and break it.
const PAGE_FILES = new Set(["html/configure.html", "css/configure.css", "js/configure.js"]);
// On Fly the files only change with a deploy (a new process): read and fingerprint
// each once. Locally they are read every time, so editing the page needs no restart.
const KEEP_PAGE_FILES = !!process.env.FLY_APP_NAME;
const pageFiles = new Map(); // file -> { body, tag }
function pageFile(file) {
  const kept = pageFiles.get(file);
  if (kept) return kept;
  const body = fs.readFileSync(path.join(ROOT, "public", file)); // a few KB
  const loaded = { body, tag: `"${crypto.createHash("sha256").update(body).digest("base64url").slice(0, 22)}"` };
  if (KEEP_PAGE_FILES) pageFiles.set(file, loaded);
  return loaded;
}
function sendPageFile(req, res, file) {
  const { body, tag } = pageFile(file);
  res.set({ "Cache-Control": "no-cache", ETag: tag });
  const known = String(req.get("if-none-match") || "").split(",").map(t => t.trim().replace(/^W\//, ""));
  if (known.includes(tag)) return res.status(304).end();
  res.type(path.extname(file)).send(body);
}
app.use("/public", limitPages);
app.use("/public", (req, res, next) => {
  const file = req.path.slice(1);
  if (PAGE_FILES.has(file)) return sendPageFile(req, res, file);
  next();
});
// Cached by browsers/Stremio for a week so repeat visits don't re-download images
app.use("/public", express.static(path.join(ROOT, "public"), { maxAge: "7d" }));

// Browsers ask for these icons on their own. Without them the "unknown page →
// /configure" fallback sent them the configure page, so every visit downloaded
// (and counted) the page twice.
const ICON_FILE = path.join(ROOT, "public", "img", "logo.png");
// (iPhones also try sized names like /apple-touch-icon-240x240-precomposed.png;
// Nuvio asks for /favicon.png)
app.get(["/favicon.ico", "/favicon.png", /^\/apple-touch-icon[\w-]*\.png$/], limitPages, (_req, res) => {
  res.sendFile(ICON_FILE, { maxAge: "7d" });
});

// --- Analytics: stats.js (saved in STATS_DIR — the /data volume on Fly.io) ---
// Stable install links ("s-<id>"): settings saved next to the stats, edited in place
const linkStore = require("./links").createStore(STATS_DIR);
const PROCESS_START = new Date().toISOString();

// A normal stop (deploy, Fly restart) is marked "clean"; the next start alerts if
// the previous run ended any other way (crash, out-of-memory kill) — alerts.js
process.on("SIGTERM", () => { saveStatsSync(); linkStore.saveSync(); alerts.markClean(STATS_DIR); process.exit(0); });
process.on("SIGINT", () => { saveStatsSync(); linkStore.saveSync(); alerts.markClean(STATS_DIR); process.exit(0); });
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err);
  alerts.alert("fatal", `Unhandled error (server kept running): ${safeError(err)}`);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  alerts.markCrashed(STATS_DIR, err); // reported by the next start (no time to send now)
  saveStatsSync();
  linkStore.saveSync();
  process.exit(1);
});

// --- Caches, shared loads, download slots, memory watchdog: cache.js ---

// --- Base manifest (unconfigured) — Stremio shows the config form ---
const BASE_MANIFEST = {
  id: "community.streamvault.addon",
  version: "1.2.0",
  name: "StreamVault IPTV",
  // The empty install (no settings) says so, so it's easy to tell apart from a
  // connected one in an app's addon list (configuredManifest replaces this)
  description: "Not connected yet. Open Configure to add your Xtream Codes account or M3U playlist. Already have a connected StreamVault? Delete this one.",
  logo: "https://streamvault.fly.dev/public/img/logo.png",
  resources: ["catalog", "meta", "stream"],
  types: ["tv"],
  idPrefixes: ["iptv_"],
  catalogs: [
    { type: "tv", id: "iptv_live", name: "StreamVault Live", extra: [{ name: "search" }, { name: "skip" }] },
  ],
  // Stremio will show these fields in its own Settings UI
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
  },
  // Proves ownership of the listing on stremio-addons.net (public token, not a secret)
  stremioAddonsConfig: {
    issuer: "https://stremio-addons.net",
    signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..RH4wxJhhF9TWtF1ar0wTHA.r6YLG5IVhPFj8RrJNZITbeeCSDB7IHYlghk3FzU8Q2HukRlyfbdMNrrn87J59FCnUNOtKse3QGOh4gxkRTgGZTz8PG8DjZMATuXGBWfSaIqIrVZNPzT4yxFW6A5w7znU.B6Yym2fnPMr3nelyaNeXWw",
  },
  config: [
    {
      key: "sourceType",
      type: "select",
      title: "Source Type",
      options: ["xtream", "m3u"],
      required: true,
    },
    {
      key: "server",
      type: "text",
      title: "Server URL (Xtream Codes only)",
      default: "",
    },
    {
      key: "username",
      type: "text",
      title: "Username (Xtream Codes only)",
      default: "",
    },
    {
      key: "password",
      type: "password",
      title: "Password (Xtream Codes only)",
      default: "",
    },
    {
      key: "m3uUrl",
      type: "text",
      title: "M3U Playlist URL (M3U only)",
      default: "",
    },
  ],
};

// --- Parse config from URL path segment (formats: configlink.js; saved settings: links.js) ---
// A link whose settings are saved on the server: a stable "s-" link, or an older
// link edited in place. Returns the "e-" form of the saved settings, the link
// unchanged when nothing is saved for it, or null for an unknown "s-" link.
function resolveSavedSettings(configStr) {
  if (linkStore.isId(configStr)) {
    const saved = linkStore.get(configStr);
    return saved ? "e-" + saved.encrypted : null;
  }
  const override = linkStore.getOverride(configStr);
  return override ? "e-" + override.encrypted : configStr;
}

function parseConfigPath(configStr) {
  const resolved = resolveSavedSettings(configStr);
  if (resolved === null) return { type: null, missing: true };
  return configFromSettings(settingsFromEncrypted(resolved))
    || configFromSettings(settingsFromBase64(resolved))
    || configFromQueryString(resolved);
}

// --- Middleware: extract config from URL path ---
function extractConfig(req, res, next) {
  // Refused install links are listed in /stats (recentBadLinks; /play has its own list)
  const refuse = (reason, error) => {
    res.locals.rejectReason = reason;
    if (!req.path.startsWith("/play/")) {
      noteRecent(recentBadLinks, { route: req.route ? req.route.path : maskPath(req.path), reason, userAgent: userAgent(req) });
    }
    const setupAnswer = brokenLinkAnswer(req);
    if (setupAnswer) return res.json(setupAnswer);
    res.status(400).json({ error });
  };
  // Only reading the link may fail on purpose (bad base64/JSON, tampered or foreign
  // encryption). Everything after it is our own code: a bug there must not turn
  // every request into "Set up StreamVault first" silently — it goes to the error
  // handler ([ERROR] log + alert) instead.
  let config;
  try {
    config = parseConfigPath(req.params.config);
  } catch {
    // Not a link StreamVault can read: refused like any other bad link (listed in recentBadLinks)
    return refuse("install link can't be read", "Invalid configuration.");
  }
  if (config.missing) {
    return refuse("stable install link not found (saved settings missing)", "This StreamVault link no longer exists. Set it up again.");
  }
  // Cache key for things built from the settings (category list): a stable
  // link's settings can change, so its key includes the revision
  const saved = linkStore.get(req.params.config) || linkStore.getOverride(req.params.config);
  req.configKey = saved ? `${req.params.config}@${saved.revision}` : req.params.config;
  req.configRevision = saved ? saved.revision : 0;
  if (config.type === "xtream") Object.assign(config, normalizeXtreamLogin(config.server, config.username, config.password));
  // A server that answered on the other scheme (http ↔ https, urlguard.js): use that
  // one for everything built from the settings, play links included — and the
  // configure page shows it, so Save changes fixes the saved link for good
  if (config.type === "xtream") config.server = preferredUrl(config.server);
  if (config.type === "m3u") config.url = preferredUrl(config.url);
  if (config.type === "xtream" && (!config.server || !config.username || !config.password)) {
    return refuse("install link has no Xtream server/login", "Missing Xtream credentials.");
  }
  if (config.type === "m3u" && !config.url) {
    return refuse("install link has no playlist URL (not a valid StreamVault link)", "Missing M3U URL.");
  }
  req.userConfig = config;
  next();
}

// The "Set up StreamVault first" tile for an install that can't show channels: only
// on the first page of the StreamVault row — not on later pages, and not in search
// results (apps like Nuvio send their global film search to every addon, so the tile
// kept appearing on every keystroke among people's film results).
function setupTileCatalog(extra, type) {
  const later = /(^|&)skip=[1-9]/.test(extra || "");
  const search = /(^|&)search=/.test(extra || "");
  return { metas: later || search ? [] : [noticeMeta("setup", type)] };
}

// A broken install link opened by an app (manifest/catalog/meta/stream): answered
// like an install without settings — the "Set up StreamVault first" tile says what
// to do, instead of an error the app retries silently (one Nuvio retried hourly).
// The configure page (/api/config) and /play keep their error responses.
function brokenLinkAnswer(req) {
  const route = req.route?.path || "";
  const { type, id } = req.params;
  if (route.endsWith("/manifest.json")) return BASE_MANIFEST;
  if (route.includes("/catalog/")) return setupTileCatalog(req.params.extra, type);
  if (route.includes("/meta/")) {
    return isBareForeign(type, id) ? { meta: { id, type, name: "Unknown" } } : { meta: noticeMeta("setup", type) };
  }
  if (route.includes("/stream/")) return { streams: id === "iptv_notice_setup" ? [SETUP_PLAY_STREAM] : [] };
  return null;
}

// --- Serve configuration page for Stremio ---
// Almost every visit used to show up twice (the browser's /favicon.ico request
// was redirected here — fixed by serving the icon). As a safety net, count real
// page loads only: no HEAD, and one per IP per CONFIGURE_DEDUPE_MS.
const CONFIGURE_DEDUPE_MS = 10 * 1000;
const lastConfigureAt = new Map(); // ip -> time of the last counted visit

function serveConfigure(req, res) {
  const ip = getIp(req);
  const now = Date.now();
  const counted = req.method === "GET" && now - (lastConfigureAt.get(ip) || 0) >= CONFIGURE_DEDUPE_MS;
  if (counted) {
    stats.configures++;
    countToday("configures");
    // Which language the visitor's browser prefers (first Accept-Language, primary
    // subtag only, e.g. "fr"): decides whether translating the page is worth it.
    // Only the per-day count is kept — history "configureLanguages".
    countKey("configureLanguages", primaryLanguage(req.get("accept-language")));
    // Opened from an installed addon's Configure button (/<link>/configure)
    if (req.params.config) {
      stats.reconfigures++;
      countToday("reconfigures");
    }
    setCapped(lastConfigureAt, ip, now, 10000);
  }
  console.log(`[CONFIGURE] ${req.method} ${maskIp(ip)} opened configure page${counted ? "" : " (repeat, not counted)"}`);
  sendPageFile(req, res, "html/configure.html");
}
// Crawlers may index the configure page (people find the addon) but nothing
// else — install links carry users' (encrypted) settings
app.get("/robots.txt", limitPages, (_req, res) => {
  res.type("text/plain").set("Cache-Control", "public, max-age=86400")
    .send("User-agent: *\nAllow: /configure\nAllow: /public/\nDisallow: /\n");
});

app.get("/configure", limitPages, serveConfigure);
// Target of the QR code on the "Set up StreamVault first" tile (a short link keeps
// the code coarse enough to scan off a TV). Counted per day as setupScans.
// "?via=play|link" = tapped on a phone (Play button / link chip) rather than
// scanned: counted as setupTaps.
app.get("/setup", limitPages, (req, res) => {
  countToday(req.query.via ? "setupTaps" : "setupScans");
  res.redirect(302, "/configure?from=tile");
});
app.get("/:config/configure", limitPages, serveConfigure);

// Live installs badge for the README (shields.io "endpoint" format). Only this one
// total is public — /stats stays behind STATS_SECRET. Rounded down with a "+", so the
// badge never shows more than the real number (2747 → "2.7k+"). Shields caches it.
function installsBadgeText(n) {
  if (n < 1000) return String(n);
  const k = Math.floor(n / 100) / 10;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k+`;
}
app.get("/badge/installs.json", limitConfig, (_req, res) => {
  res.json({ schemaVersion: 1, label: "installs", message: installsBadgeText(stats.installs), color: "7C5CFC", cacheSeconds: 3600 });
});

// The configure page's Ko-fi links go through here: every click is counted (all
// time + per day, by where it was: the result dialog or the footer), then the
// browser goes on to Ko-fi. Only numbers — nothing about who clicked.
const KOFI_URL = "https://ko-fi.com/streamvaultaddon";
app.get("/go/kofi", limitPages, (req, res) => {
  if (req.method === "GET") { // not link previews (HEAD)
    const from = ["dialog", "footer"].includes(req.query.from) ? req.query.from : "other";
    stats.kofiClicks[from] = (stats.kofiClicks[from] || 0) + 1;
    countToday(`kofiClicks${from[0].toUpperCase()}${from.slice(1)}`);
  }
  res.redirect(302, KOFI_URL);
});

// --- Configure page API: api.js ---
registerApiRoutes(app, { linkStore, parseConfigPath, extractConfig, limitProviderChecks, limitConfig });

// --- Routes ---

// Root manifest (no config yet) — Stremio reads this to show config UI
app.get("/manifest.json", limitAddon, (_req, res) => {
  res.json(BASE_MANIFEST);
});

// Configured manifest (user completed install)
// Install links that reach us slightly wrong, all answered as the install link:
// - the configure page's link pasted into an app, which adds /manifest.json
//   ("…/<link>/configure/manifest.json")
// - Nuvio 1.1.0-beta.13 adds an extra "/manifest" ("…/<link>/manifest/manifest.json")
// - a link cut off while copying ("…/<link>/manifest.jso", "manifest.", …): opened
//   as it is, or with the app's own /manifest.json after it
// MANIFEST_PART = "manifest" plus any cut-off start of ".json" (or all of it)
const MANIFEST_PART = String.raw`manifest(?:\.(?:j(?:s(?:on?)?)?)?)?`;
const WRONG_MANIFEST = new RegExp(String.raw`^/([^/]+)/(?:configure|${MANIFEST_PART})/manifest\.json$`);
const CUT_MANIFEST = /^\/([^/]+)\/manifest\.(?:j(?:so?)?)?$/;
app.get([WRONG_MANIFEST, CUT_MANIFEST], (req, _res, next) => {
  const [, config] = WRONG_MANIFEST.exec(req.path) || CUT_MANIFEST.exec(req.path);
  req.url = `/${config}/manifest.json`;
  next();
});
// …and apps build every other request from that link too ("…/<link>/manifest/
// catalog/tv/…json", whole category bursts, all 404 before): drop the extra part
const EXTRA_BEFORE_ROUTE = new RegExp(`^(/[^/]+)/${MANIFEST_PART}/(?=(?:catalog|meta|stream)/)`);
app.get(EXTRA_BEFORE_ROUTE, (req, _res, next) => {
  req.url = req.url.replace(EXTRA_BEFORE_ROUTE, "$1/");
  next();
});
// The install link pasted twice into an app ("…/manifest.jsonhttps://<this
// server>/<link>/manifest.json"): use the second copy. Apps build every request
// from that doubled link, so the channel list, channel pages and streams arrive
// as "…/manifest.jsonhttps://<this server>/<link>/catalog/tv/…json" too (okhttp,
// ~20 a day, all 404 before): any path after the second copy is used. Only a
// link to this server; anything else stays a 404.
const PASTED_TWICE = "/manifest.jsonhttp";
app.use((req, _res, next) => {
  const at = req.path.indexOf(PASTED_TWICE);
  if (at > 0) {
    try {
      const second = new URL(req.path.slice(at + "/manifest.json".length));
      if (second.host === req.get("host")) req.url = second.pathname + second.search;
    } catch {
      // not a link after all: the normal 404
    }
  }
  next();
});

app.get("/:config/manifest.json", limitAddon, extractConfig, async (req, res) => {
  const ip = getIp(req);
  const user = knownUser(ip);
  const isNew = !stats.users.has(user);
  if (isNew) {
    stats.users.add(user);
    stats.installs++;
    countToday("installs");
    noteSetupDone(user);
  }
  // Track config type and daily active
  const cType = req.userConfig.type;
  if (stats.configType[cType] !== undefined) stats.configType[cType]++;
  if (isNew && stats.installsByType[cType] !== undefined) stats.installsByType[cType]++;
  countToday("launches"); // Stremio fetches the manifest each time the app starts
  addDailyUser(stats.dailyActive, user);
  addDailyUser(stats.dailySetups, setupKey(req.params.config));
  // Returning users aren't logged (apps re-read the manifest constantly — it was
  // most of the log); they're counted in /stats as launches / dau
  if (isNew) console.log(`[INSTALL] ${maskIp(ip)} NEW install — type: ${cType}`);
  let { names: genres, picks } = await manifestCategories(req.userConfig, req.configKey);
  // Channel list not ready in time (e.g. right after Save changes added a category):
  // the picked categories still go into the manifest — apps keep it until restart
  if (genres.length === 0) {
    genres = await withinMs(pickedCategoryNames(req.userConfig), PICKED_NAMES_TIMEOUT_MS, []);
    picks = genres.slice(0, MAX_HOME_ROWS);
  }
  if (req.userConfig.homeRows < MAX_HOME_ROWS) addDailyUser(stats.dailyFewerRows, setupKey(req.params.config));
  res.json({ ...configuredManifest(genres, cType, req.userConfig, picks), version: manifestVersion(req.configRevision) });
});

// --- Category filter: the user's own groups become the catalog's "genre" options ---
const PICKED_NAMES_TIMEOUT_MS = 3000;
// Picked categories by name in pick order, without the channel list: M3U group
// names are in the settings; Xtream ids → names via the (small) category list
// (an Xtream setup with no categories picked: all of them, A–Z like the channel list)
const BY_NAME = new Intl.Collator("en", { sensitivity: "base", numeric: true });
async function pickedCategoryNames(config) {
  if (config.type === "m3u") return (config.groups || []).slice(0, MAX_GENRE_OPTIONS);
  const ids = xtreamCategoryIds(config);
  const categories = await xtream.getLiveCategories(config);
  const list = Array.isArray(categories) ? categories : [];
  if (ids.length === 0) {
    return list.map(c => c.category_name).filter(Boolean).toSorted(BY_NAME.compare).slice(0, MAX_GENRE_OPTIONS);
  }
  const names = new Map(list.map(c => [String(c.category_id), c.category_name]));
  return ids.map(id => names.get(id)).filter(Boolean).slice(0, MAX_GENRE_OPTIONS);
}

// Category names for the manifest (app start). When neither they nor the channel
// list are in memory (after a restart, or every 6 h), the whole list had to be
// downloaded first: app start took 2+ s for those users. Now the full list and the
// small category list (Xtream: one quick call; M3U: the picked groups are in the
// settings) are asked for together. The full list is still preferred — only it
// knows which picks have channels (a pick without any gets no row) — if it comes
// within QUICK_MANIFEST_WAIT_MS; otherwise the quick names answer and the list
// keeps loading for the channel list the app asks for next. An M3U playlist with
// all groups has no quick names: the full list, as before. Counted as quickManifests.
const QUICK_MANIFEST_WAIT_MS = 1500;
const STILL_LOADING = Symbol("still loading");
function categoriesInMemory(config, cacheKey) {
  const genres = genresCache.get(cacheKey);
  if (genres && Date.now() - genres.ts < GENRES_CACHE_TTL) return true;
  return config.type === "xtream"
    ? xtreamCache.has(xtreamCacheKey(config, "tv", xtreamCategoryIds(config)))
    : m3uCache.has(m3uCacheKey(config));
}
async function manifestCategories(config, cacheKey) {
  if (categoriesInMemory(config, cacheKey)) return getGenresWithin(config, cacheKey, GENRES_TIMEOUT_MS);
  const full = getGenres(config, cacheKey);
  const quick = withinMs(pickedCategoryNames(config), PICKED_NAMES_TIMEOUT_MS, []);
  const early = await withinMs(full, QUICK_MANIFEST_WAIT_MS, STILL_LOADING);
  if (early !== STILL_LOADING && early.names.length > 0) return early;
  const names = await quick;
  if (names.length === 0) return getGenresWithin(config, cacheKey, GENRES_TIMEOUT_MS);
  countToday("quickManifests");
  full.catch(() => null); // keeps loading for the channel list; a failure shows there
  return { names, picks: names.slice(0, MAX_HOME_ROWS) };
}

const GENRES_TIMEOUT_MS = 8000;      // manifest must stay fast; fall back to no filter
const GENRES_CACHE_TTL = 6 * 60 * 60 * 1000;
const GENRES_CACHE_MAX = 500;
const MAX_GENRE_OPTIONS = 300;
const genresCache = new Map();       // config path -> { data: [names], ts }

// One extra home-screen row per category the user picked (pick order), after the
// main row: the first N picks (N = the user's home rows, 0–8, chosen on the
// configure page) that have channels — a pick with none gets no row and does NOT
// pull a later pick up. Ids come from the name, so an app's row settings survive edits.
const MAIN_CATALOG_ID = "iptv_live";
function categoryCatalogId(name) {
  return `iptv_cat_${crypto.createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

function categoryRows(genres, config, picks) {
  const picked = config.type === "xtream" ? xtreamCategoryIds(config).length : (config.groups || []).length;
  if (picked < 2 || genres.length < 2) return [];
  // The user's own number of rows (0–8, configure page); older links: 8
  const present = new Set(genres);
  const rows = picks.slice(0, config.homeRows ?? MAX_HOME_ROWS).filter(name => present.has(name));
  // A tag is kept where hiding it would make two rows look the same ("IT: SPORT"
  // and "UK: SPORT" both "SPORT")
  const shown = rows.map(name => cleanName(name));
  const clash = (title) => shown.filter(s => s === title).length > 1;
  return rows.map((name, i) => ({
    type: "tv", id: categoryCatalogId(name), name: clash(shown[i]) ? name.trim() : shown[i], extra: [{ name: "skip" }],
  }));
}

// Apps keep the manifest they installed and replace it when its version changes:
// each Save changes of a saved link (revision) gives "1.2.<revision>", so the new
// category list / rows reach the app. Links never saved stay on the base version.
function manifestVersion(revision) {
  return revision ? BASE_MANIFEST.version.replace(/\.\d+$/, `.${revision}`) : BASE_MANIFEST.version;
}

function configuredManifest(genres, type, config, picks) {
  const extra = [{ name: "search" }];
  // A single group (e.g. everything "Uncategorized") makes a useless dropdown
  if (genres.length > 1) extra.push({ name: "genre", options: genres, isRequired: false });
  extra.push({ name: "skip" });
  return {
    ...BASE_MANIFEST,
    // Says which other install to delete. Points at the live "Set up StreamVault
    // first" tile, not the empty install's description: apps keep the description
    // from install time, so older empty installs never show the new wording.
    // One line each (apps that ignore line breaks show a space): what to do after
    // Save changes differs per app — Stremio keeps its copy until reinstalled
    description: `✓ Connected to your ${type === "xtream" ? "Xtream account" : "M3U playlist"}.\n${type === "xtream" ? "Your live channels, TV guide and catch-up." : "Your live channels, sorted and searchable."}\nTo change categories or rows, tap Configure.\n\nChanged your setup?\nStremio: press Uninstall, then Install.\nNuvio: close and reopen the app.\nOther apps: reinstall or restart the app.\nIf another StreamVault only shows “Set up StreamVault first”, delete that one.`,
    catalogs: [...BASE_MANIFEST.catalogs.map(c => ({ ...c, extra })), ...categoryRows(genres, config, picks)],
    behaviorHints: { configurable: true },
  };
}

async function getGenres(config, cacheKey) {
  const cached = touch(genresCache, cacheKey);
  if (cached && Date.now() - cached.ts < GENRES_CACHE_TTL) return cached.data;

  // Catalog items carry their group in `genres` (already in channel order); dedupe
  const metas = config.type === "xtream"
    ? await getXtreamCatalog(config, "tv")
    : await getM3UCatalog(config, "tv");
  const names = [...new Set(metas.map(m => m.genres?.[0]).filter(Boolean))]
    .slice(0, MAX_GENRE_OPTIONS);
  const picked = config.type === "xtream" ? metas.pickedCategories || [] : config.groups || [];
  // The first 8 picks in pick order (home rows are the first N of them that have channels)
  const picks = picked.slice(0, MAX_HOME_ROWS);

  const data = { names, picks };
  setCapped(genresCache, cacheKey, { data, ts: Date.now() }, GENRES_CACHE_MAX);
  return data;
}

// Slow/broken provider must not block the manifest — return [] (no filter) instead
function getGenresWithin(config, cacheKey, ms) {
  return withinMs(getGenres(config, cacheKey), ms, { names: [], picks: [] });
}

// --- Stats dashboard (protected by STATS_SECRET env var) ---
app.get("/stats", limitStats, (req, res) => {
  if (STATS_SECRET && req.query.key !== STATS_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const uptime = process.uptime();
  const d = Math.floor(uptime / 86400);
  const h = Math.floor((uptime % 86400) / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  // Daily active users and viewers (last 7 days)
  const last7 = {};
  const viewers7 = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    last7[key] = stats.dailyActive[key] ? stats.dailyActive[key].size : 0;
    viewers7[key] = stats.dailyViewers[key] ? stats.dailyViewers[key].size : 0;
  }
  const mem = process.memoryUsage();
  const avgStreamsPerUser = stats.users.size > 0 ? +(stats.streams / stats.users.size).toFixed(1) : 0;
  res.json({
    addon: "StreamVault IPTV",
    installs: stats.installs,
    uniqueUsers: stats.users.size,
    configures: stats.configures,
    reconfiguresTotal: stats.reconfigures,
    reinstallsTotal: stats.reinstalls,
    kofiClicksTotal: stats.kofiClicks,
    catchupPlaysTotal: stats.catchupPlays,
    streamsPlayed: stats.streams,
    streamsByType: stats.streamsByType,
    searches: stats.searches,
    configType: stats.configType,
    installsByType: stats.installsByType,
    avgStreamsPerUser,
    dailyActiveUsers: last7,
    // Unique users per day who opened a channel and got something to play
    dailyViewers: viewers7,
    // Seen without settings ("Set up StreamVault first") and not set up since
    bareUsersWaiting: stats.bareUsers.size,
    uptime: d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`,
    lastRestarted: PROCESS_START,
    startedAt: stats.startedAt,
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      rssMB: Math.round(mem.rss / 1024 / 1024),
      ...memStats,
      warnAtMB: HEAP_WARN_MB,
      critAtMB: HEAP_CRIT_MB,
    },
    caches: {
      m3u: `${m3uCache.size}/${M3U_CACHE_MAX}`,
      xtream: `${xtreamCache.size}/${XTREAM_CACHE_MAX}`,
      accounts: `${accountCache.size}/${XTREAM_CACHE_MAX}`,
      epg: `${epgCache.size}/${EPG_CACHE_MAX}`,
      genres: `${genresCache.size}/${GENRES_CACHE_MAX}`,
      // stable install links saved on the volume (links.json)
      links: linkStore.size(),
      inflightDownloads: inflight.size,
      downloadsRunning: `${downloadsRunningNow()}/${MAX_PARALLEL_DOWNLOADS}`,
      downloadsWaiting: downloadQueue.length,
      // providers that failed in the last 2 min and are not being retried yet
      failedProviders: [...failCache.values()].filter(f => f.until > Date.now()).length,
    },
    // Newest first; dau/viewers are live for recent days, frozen in the row for older ones
    history: Object.keys(stats.history).toSorted((a, b) => b.localeCompare(a)).map(date => (
      { date, dau: 0, ...stats.history[date], ...uniqueCounts(date) }
    )),
    // Since last restart (newest first, max 20 each; no URLs or credentials)
    recentErrors,
    recentUnknownPaths,
    recentEmptyStreams,
    recentUnconfigured,
    recentPlayRejects,
    recentBadLinks,
    recentTestFailures,
  });
});

// --- Addon installed without configuring (bare /manifest.json) ---
// Some apps/tools ignore configurationRequired and install the bare manifest, then
// ask /catalog/... with no settings in the path. Instead of a 404 (an empty
// catalog with no hint), answer with one tile telling the user to configure.
// Logged with the User-Agent to learn which apps do this.
function serveUnconfigured(req, res, body) {
  countToday("unconfigured");
  noteBareUser(knownUser(getIp(req)), userAgent(req));
  noteRecent(recentUnconfigured, { path: maskPath(req.path), userAgent: userAgent(req) });
  res.json(body);
}
app.get(["/catalog/:type/:id.json", "/catalog/:type/:id/:extra.json"], limitAddon, (req, res) => {
  serveUnconfigured(req, res, setupTileCatalog(req.params.extra, req.params.type));
});
// Apps also ask an empty install about films/series (tt… ids, "anime" type):
// not ours — counted as foreignRequests, not as an install without settings
const isBareForeign = (type, id) => type !== "tv" || !id.startsWith("iptv_");
app.get("/meta/:type/:id.json", limitAddon, (req, res) => {
  const { type, id } = req.params;
  if (isBareForeign(type, id)) return answerForeign(res, { meta: { id, type, name: "Unknown" } });
  if (id === "iptv_notice_setup") noteSetupStep(knownUser(getIp(req)), "meta");
  serveUnconfigured(req, res, { meta: noticeMeta("setup", type) });
});
app.get("/stream/:type/:id.json", limitAddon, (req, res) => {
  if (isBareForeign(req.params.type, req.params.id)) return answerForeign(res, { streams: [] });
  const isSetupTile = req.params.id === "iptv_notice_setup";
  if (isSetupTile) noteSetupStep(knownUser(getIp(req)), "stream");
  serveUnconfigured(req, res, { streams: isSetupTile ? [SETUP_PLAY_STREAM] : [] });
});

// --- Catalog (channel lists, names, search matching: catalog.js) ---
// Catalog handler (with extra params like search=X)
app.get("/:config/catalog/:type/:id/:extra.json", limitAddon, extractConfig, catalogHandler);
// Catalog handler (no extra params)
app.get("/:config/catalog/:type/:id.json", limitAddon, extractConfig, catalogHandler);

async function catalogHandler(req, res) {
  try {
    const config = req.userConfig;
    const { type } = req.params;
    // Parse the raw (still-encoded) segment: req.params is already decoded, so a
    // "&" inside a group name or search ("Sports & News") would split wrongly
    const extra = req.params.extra ? parseExtra(req.path.split("/").pop()) : {};
    const PAGE_SIZE = 100;
    // A first page with a notice tile has 101 items; apps that send "items so far"
    // as the next skip ask for 101, 201… — map those back so no channel is missed
    const askedSkip = Number.parseInt(extra.skip, 10) || 0;
    const skip = askedSkip % PAGE_SIZE === 1 ? askedSkip - 1 : askedSkip;

    const mainRow = req.params.id === MAIN_CATALOG_ID;
    let metas = [];
    let notice = null; // tile shown first (account problem / expiry) — main row only

    if (config.type === "xtream") {
      ({ metas, notice } = await xtreamCatalogAndNotice(config, type, skip, Boolean(extra.search?.trim()) || !mainRow));
    } else if (config.type === "m3u") {
      metas = await getM3UCatalog(config, type);
    }
    const mixedCountries = keepsTags(metas);
    metas = catalogView(metas).display;
    if (!mainRow) extra.genre = categoryForRow(req.params.id, metas);
    // Tags only on tiles where countries meet: the main row and search. One category
    // (a home row, or the category filter) is one country; the channel page and its
    // streams show the category, so they never need the tag either
    const keepTags = mixedCountries && !extra.genre;
    const stale = staleCategoryAnswer(extra, metas, skip, type);
    if (stale) return res.json(stale);

    // Filter, paginate; channels carry the raw logo — posters built for this page only
    metas = filterCatalog(metas, extra).slice(skip, skip + PAGE_SIZE).map(m => catalogMeta(m, keepTags));
    if (notice) metas.unshift(notice);

    // A provider-problem tile (expired account) shows until it's fixed: not kept
    res.json(notice?.id === "iptv_notice_account" ? { metas } : reusable(res, { metas }, "catalog"));
  } catch (e) {
    handleProviderError("catalog", req, e);
    // Instead of an empty catalog, show one tile explaining what went wrong
    // (first page only, so scrolling doesn't repeat it)
    const firstPage = !/(^|&)skip=[1-9]/.test(req.path.split("/").pop() || "");
    res.json({ metas: firstPage ? [noticeMeta(classifyError(e), req.params.type)] : [] });
  }
}

// A category with nothing to show — usually one the app still offers from an older
// setup (apps keep the category list / rows they loaded at start), sometimes a
// picked one the provider emptied: an explaining tile on the first page instead of
// an empty screen. Counted per day as staleCategories.
function staleCategoryAnswer(extra, metas, skip, type) {
  if (!extra.genre || metas.length === 0 || metas.some(m => m.genres?.[0] === extra.genre)) return null;
  if (skip > 0) return { metas: [] };
  countToday("staleCategories");
  return { metas: [noticeMeta("category_gone", type)] };
}

// The category behind a category row's id ("\u0000" = none: an empty row)
function categoryForRow(id, metas) {
  const names = new Set(metas.map(m => m.genres?.[0]).filter(Boolean));
  for (const name of names) if (categoryCatalogId(name) === id) return name;
  return "\u0000";
}

// Xtream channels plus the tile to show first (account problem / expiry), if any
async function xtreamCatalogAndNotice(config, type, skip, noExpiryTile) {
  // First page of the main row (no search): account read alongside the channels
  // for the expiry notice; never waits more than a few seconds
  const accountPromise = skip === 0 && !noExpiryTile
    ? withinMs(getXtreamAccount(config), ACCOUNT_WAIT_MS, null)
    : null;
  const metas = await getXtreamCatalog(config, type);
  // Expired/disabled accounts often return an empty list rather than an
  // error — say so instead of showing an empty catalog
  if (metas.length === 0 && skip === 0 && type === "tv") {
    const problem = accountProblem(await getXtreamAccount(config));
    if (problem) return { metas, notice: noticeMeta("account", type, problem) };
  }
  return { metas, notice: accountNotice(await accountPromise, type) };
}

// Stremio's genre dropdown, then search: all words must appear in the name (any
// order), ignoring case, accents, punctuation and Cyrillic vs Latin spelling
function filterCatalog(metas, extra) {
  let result = metas;
  if (extra.genre) result = result.filter(m => m.genres?.[0] === extra.genre);
  if (extra.search?.trim()) {
    stats.searches++;
    countToday("searches");
    const words = searchKey(extra.search).split(" ").filter(w => w.length > 0);
    result = result.filter(m => {
      const name = channelSearchKey(m);
      return words.every(word => name.includes(word));
    });
  }
  return result;
}

// --- Notice tiles (texts and builders: notices.js) ---
// Opening an error tile shows its full explanation (it has no streams).
// The account tile re-reads the (cached) account to name the exact problem.
async function noticeMetaForAccount(config, id, type) {
  const kind = id.slice("iptv_notice_".length);
  if (kind === "account") {
    const problem = config.type === "xtream" ? accountProblem(await getXtreamAccount(config)) : null;
    return noticeMeta("account", type, problem);
  }
  if (kind === "expiring") {
    const info = config.type === "xtream" ? await getXtreamAccount(config) : null;
    // Renewed since the tile was shown: say so instead of an old warning
    return accountNotice(info, type) || {
      id, type: type || "tv", name: "✅ Subscription renewed", posterShape: "square",
      description: "Your subscription is active. This notice disappears from the list within 30 minutes.",
    };
  }
  return noticeMeta(NOTICES[kind] ? kind : "unknown", type);
}

// Some apps ask every installed addon about whatever the user opens (IMDb movies
// and series like "tt33539520:1:1"), ignoring the manifest's types/idPrefixes.
// Those aren't StreamVault channels: answer at once instead of downloading the
// user's whole playlist to find nothing. Counted per day as foreignRequests.
// Also foreign: other addons' ids that merely start with "iptv_" (e.g.
// "iptv_a02ed40f856b05bd"), and — on an Xtream install — ids that can't be an
// Xtream stream id ("iptv_tv_examplemagic.za" from the same user's M3U install).
// Answering those with play buttons gave links /play refuses: pressing play
// did nothing.
const XTREAM_STREAM_ID = /^[A-Za-z0-9_-]{1,40}$/;
function isForeignItem(type, id, config) {
  if (type !== "tv" || !id.startsWith("iptv_tv_")) return true;
  return config.type === "xtream" && !XTREAM_STREAM_ID.test(id.slice("iptv_tv_".length));
}

function answerForeign(res, body) {
  countToday("foreignRequests");
  res.json(body);
}

// Meta handler
// --- How long apps may reuse an answer (Stremio protocol: cacheMaxAge etc.) ---
// Without it apps asked again every time (Nuvio also loads channel pages for whole
// rows in the background). Only real answers carry it — never error tiles, notices
// about a provider problem, empty or partial answers — so a fixed problem shows at
// once. Kept short: a channel list can change after Save changes, a guide when the
// programme ends. staleRevalidate lets an app show the old answer while it asks
// again; staleError lets it keep one if StreamVault can't be reached.
const REUSE_SECONDS = { catalog: 300, meta: 120, stream: 600 };
const STALE_ERROR_SECONDS = 24 * 60 * 60;
function reusable(res, body, kind) {
  const maxAge = REUSE_SECONDS[kind];
  res.set("Cache-Control", `max-age=${maxAge}, stale-while-revalidate=${maxAge * 6}, stale-if-error=${STALE_ERROR_SECONDS}`);
  return { ...body, cacheMaxAge: maxAge, staleRevalidate: maxAge * 6, staleError: STALE_ERROR_SECONDS };
}

app.get("/:config/meta/:type/:id.json", limitAddon, extractConfig, async (req, res) => {
  try {
    const config = req.userConfig;
    const { type, id } = req.params;

    if (id.startsWith("iptv_notice_")) {
      return res.json({ meta: await noticeMetaForAccount(config, id, type) });
    }
    if (isForeignItem(type, id, config)) return answerForeign(res, { meta: { id, type, name: "Unknown" } });

    let meta = null;

    if (config.type === "xtream") {
      meta = await getXtreamMeta(config, type, id);
    } else if (config.type === "m3u") {
      meta = await getM3UMeta(config, type, id);
    }

    if (meta) {
      // Without the guide or account info (the provider was slow): not to be kept
      res.json(incompleteMetas.has(meta) ? { meta } : reusable(res, { meta }, "meta"));
    } else {
      res.json({ meta: { id, type, name: "Unknown" } });
    }
  } catch (e) {
    handleProviderError("meta", req, e);
    res.json({ meta: { id: req.params.id, type: req.params.type, name: "Unknown" } });
  }
});

// Stream handler
app.get("/:config/stream/:type/:id.json", limitAddon, extractConfig, async (req, res) => {
  try {
    const config = req.userConfig;
    const { type, id } = req.params;

    // Error tiles have nothing to play and aren't real stream requests
    if (id.startsWith("iptv_notice_")) return res.json({ streams: [] });
    if (isForeignItem(type, id, config)) return answerForeign(res, { streams: [] });

    let streams = [];

    if (config.type === "xtream") {
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      streams = await getXtreamStreams(config, type, id, { baseUrl, configPath: req.params.config });
    } else if (config.type === "m3u") {
      streams = await getM3UStreams(config, id);
    }

    // "streams" = channels that had something to play; empty answers are counted
    // on their own (emptyStreams), not in both
    if (streams.length > 0) {
      stats.streams++;
      countToday("streams");
      if (stats.streamsByType[type] !== undefined) stats.streamsByType[type]++;
      addDailyUser(stats.dailyViewers, userKey(getIp(req)));
    } else {
      countToday("emptyStreams");
      noteRecent(recentEmptyStreams, {
        source: config.type,
        type,
        id: id.slice(0, 80),
        reason: "channel is no longer in the user's playlist / category selection",
      });
    }
    res.json(streams.length > 0 ? reusable(res, { streams }, "stream") : { streams });
  } catch (e) {
    handleProviderError("stream", req, e);
    res.json({ streams: [] });
  }
});

// --- Stream redirect (gives VLC a readable title from the URL path) ---
// Only the exact shape getXtreamStreams generates is redirected, so the route
// can't be used as a general-purpose redirector to arbitrary paths/schemes
const PLAY_EXTS = new Set(["ts", "m3u8"]);
// A refused /play means a user pressed play and nothing happened — record why
// (no credentials: just which check failed and the stream id/format)
function notePlayRejects(req, res, next) {
  res.on("finish", () => {
    if (res.statusCode !== 400) return;
    noteRecent(recentPlayRejects, {
      reason: res.locals.rejectReason || "unknown",
      streamType: req.params.streamType || "timeshift",
      streamId: String(req.params.streamId).slice(0, 40),
      ext: req.params.ext,
      userAgent: userAgent(req),
    });
  });
  next();
}

// Why a /play redirect is refused, or null when it's a stream getXtreamStreams makes
function playRejectReason(config, streamType, streamId, ext) {
  if (config.type !== "xtream") return "not an Xtream install";
  if (streamType !== "live") return `stream type "${String(streamType).slice(0, 20)}" (only live)`;
  if (!XTREAM_STREAM_ID.test(streamId)) return "stream id has unexpected characters";
  if (!PLAY_EXTS.has(ext)) return `format "${String(ext).slice(0, 10)}" (only ts/m3u8)`;
  return null;
}

// Some providers answer the .ts link with an HLS playlist whose parts are relative
// ("tracks-v1a1/mono.m3u8", "seg-1.ts"). Some players (LG webOS Stremio) resolve
// those against the /play link they were given instead of the provider's address,
// so they land here: …/play/<link>/live/<id>/ts/tracks-v1a1/mono.m3u8. Send each
// to where a correct player would have gone — the same path next to the stream on
// the provider (<server>/live/<user>/<pass>/<part>). Only safe path characters
// (no part starts with a dot, so no ".."), and only parts that look like media files, so a channel name is never
// mistaken for one; the query string (provider tokens) is kept.
const RELATIVE_PART = /^\/play\/([^/]+)\/live\/[A-Za-z0-9_-]{1,40}\/(?:ts|m3u8)\/((?:[A-Za-z0-9_~-][A-Za-z0-9._~-]*\/)*[A-Za-z0-9_~-][A-Za-z0-9._~-]*\.(?:m3u8|ts|aac|m4s|mp4|vtt|key))$/;
app.get(RELATIVE_PART, limitAddon, (req, res, next) => {
  const [, configStr, part] = RELATIVE_PART.exec(req.path);
  let config;
  try {
    config = parseConfigPath(configStr);
  } catch {
    // Not a valid link: the normal /play checks or 404 answer it
    return next();
  }
  if (config?.type !== "xtream") return next();
  Object.assign(config, normalizeXtreamLogin(config.server, config.username, config.password));
  config.server = preferredUrl(config.server);
  if (!config.username || !config.password || !isExternalUrlSyntax(config.server)) return next();
  countToday("playRelativeParts");
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, `${trimTrailingSlashes(config.server)}/live/${config.username}/${config.password}/${part}${query}`);
});

app.get("/play/:config/:streamType/:streamId/:ext/:name", limitAddon, notePlayRejects, extractConfig, async (req, res) => {
  const config = req.userConfig;
  const { streamType, streamId, ext } = req.params;
  // Stream ids are usually numeric, but some panels use letters too; still no
  // dots/slashes, so the redirect can only point at a stream file
  const reason = playRejectReason(config, streamType, streamId, ext);
  if (reason) {
    res.locals.rejectReason = reason;
    return res.status(400).json({ error: "Invalid stream" });
  }
  // Address check only (no DNS): the player connects to the provider, not us
  if (!isExternalUrlSyntax(config.server)) {
    res.locals.rejectReason = "server address invalid or blocked";
    return res.status(400).json({ error: "Invalid or blocked server URL" });
  }
  const server = trimTrailingSlashes(config.server);
  const url = `${server}/${streamType}/${config.username}/${config.password}/${streamId}.${ext}`;
  res.redirect(302, url);
});

// Catch-up: /timeshift/<user>/<pass>/<minutes>/<YYYY-MM-DD:HH-MM>/<id>.<ext> on the
// provider (start in the provider's local time, as its guide gives it)
const TIMESHIFT_START = /^\d{4}-\d{2}-\d{2}:\d{2}-\d{2}$/;
app.get("/play/:config/timeshift/:streamId/:start/:minutes/:ext/:name", limitAddon, notePlayRejects, extractConfig, (req, res) => {
  const config = req.userConfig;
  const { streamId, start, minutes, ext } = req.params;
  const reject = (reason) => {
    res.locals.rejectReason = reason;
    return res.status(400).json({ error: "Invalid stream" });
  };
  const reason = playRejectReason(config, "live", streamId, ext);
  if (reason) return reject(reason);
  if (!TIMESHIFT_START.test(start)) return reject("catch-up start time has an unexpected format");
  const mins = Number(minutes);
  if (!Number.isInteger(mins) || mins < 1 || mins > 1440) return reject("catch-up length out of range");
  if (!isExternalUrlSyntax(config.server)) return reject("server address invalid or blocked");
  if (req.method === "GET") noteCatchupPlay(userKey(getIp(req)), streamId, start);
  const server = trimTrailingSlashes(config.server);
  res.redirect(302, `${server}/timeshift/${config.username}/${config.password}/${mins}/${start}/${streamId}.${ext}`);
});

// One catch-up play per person and programme per 10 min: players re-request the
// link when seeking or reconnecting, which isn't another play. Only TS passes
// here (HLS goes to the provider directly), so HLS-only accounts aren't counted.
const CATCHUP_PLAY_DEDUPE_MS = 10 * 60 * 1000;
const recentCatchupPlays = new Map(); // user|stream|start -> last counted (ms)
function noteCatchupPlay(user, streamId, start) {
  const key = `${user}|${streamId}|${start}`;
  const now = Date.now();
  const last = recentCatchupPlays.get(key);
  if (last && now - last < CATCHUP_PLAY_DEDUPE_MS) return;
  recentCatchupPlays.delete(key); // re-insert: Map order = oldest first, for the cap
  recentCatchupPlays.set(key, now);
  if (recentCatchupPlays.size > 5000) recentCatchupPlays.delete(recentCatchupPlays.keys().next().value);
  stats.catchupPlays++;
  countToday("catchupPlays");
  addDailyUser(stats.dailyCatchup, user);
}

// --- Channel lists, pages and streams: xtream-addon.js / m3u-addon.js ---

// Some apps (Nuvio on webOS) ask every addon for subtitles, although the
// manifest offers none — with or without settings, sometimes with a mangled
// tail. Answer "no subtitles" at once instead of a 404; counted as foreignRequests.
app.get(/^\/(?:[^/]+\/)?subtitles\//, limitAddon, (_req, res) => {
  countToday("foreignRequests");
  res.json({ subtitles: [] });
});

// A player given the install link (VLC for iOS) looks for subtitles next to it:
// HEAD /<link>/manifest.srt, .vtt, .ass … Answer 404 as before, but count it per
// day (subtitleProbes) instead of filling recentUnknownPaths.
const SUBTITLE_EXTS = new Set([
  "srt", "vtt", "ass", "ssa", "sub", "idx", "smi", "sami", "txt", "utf", "dks", "pjs", "mpl2", "mks",
  "ttml", "dfxp", "stl", "usf", "rt", "psb", "jss", "aqt", "smil", "lrc", "sbv", "scc",
]);
app.get(/^\/[^/]+\/manifest\.[a-z0-9]{2,5}$/i, (req, res, next) => {
  const ext = req.path.slice(req.path.lastIndexOf(".") + 1).toLowerCase();
  if (!SUBTITLE_EXTS.has(ext)) return next(); // other files: the normal 404 below
  countToday("subtitleProbes");
  res.locals.skipErrorCount = true;
  res.status(404).json({ error: "Not found" });
});

// Some client treats StreamVault as Stremio's streaming server and polls
// "/<infoHash>/<fileIdx>/stats.json" every second. Answer 404 as before, but
// count it per day (streamingServerProbes) instead of filling recentUnknownPaths
// and the "unknown path" 404 count.
app.get(/^\/[0-9a-f]{40}\/\d+\/stats\.json$/i, (_req, res) => {
  countToday("streamingServerProbes");
  res.locals.skipErrorCount = true;
  res.status(404).json({ error: "Not found" });
});

// --- Fallback: people opening the site in a browser land on the configure page ---
// ("/" or any unknown page). Unknown API/addon (.json) calls get a JSON 404 instead,
// so Stremio and the configure page still see a real error.
app.use(limitPages, (req, res) => {
  const isApiCall = req.path.startsWith("/api/") || req.path.startsWith("/public/") || req.path.endsWith(".json");
  // Only page-like paths redirect; a missing file (robots.txt, some-icon.png, ...)
  // is a plain 404 rather than a second download of the configure page
  const looksLikeFile = /\.[a-z0-9]{1,5}$/i.test(req.path);
  // HEAD too: uptime monitors check "/" with HEAD and would see a 404
  if ((req.method === "GET" || req.method === "HEAD") && !isApiCall && !looksLikeFile) {
    return res.redirect(302, "/configure");
  }
  noteRecent(recentUnknownPaths, { method: req.method, path: maskPath(req.path), userAgent: userAgent(req) });
  res.status(404).json({ error: "Not found" });
});

// --- Last resort for an unexpected error in a handler ---
// Express 5 passes errors from async handlers here (Express 4 left them unhandled,
// which stopped the process). Without this, Express's own page would show the
// error's stack trace (NODE_ENV isn't "production" on Fly). Logged without URLs or
// logins; the client gets a short JSON answer.
// (4 parameters: that is how Express tells an error handler apart)
app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${req.method} ${req.route?.path || "unmatched"}: ${safeError(err)}`);
  alerts.alert("error", `Unexpected error in ${req.method} ${req.route?.path || "unmatched"}: ${safeError(err)}`);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: "Something went wrong" });
});

// --- Metrics (Prometheus text) for Fly's built-in Grafana: prometheus.js ---
const buildMetricsText = () => prometheus.buildMetricsText({ linkStore, genresCache, GENRES_CACHE_MAX });

// --- Server time limits ---
// Node's defaults let one request take 5 minutes. No StreamVault answer needs more
// than a minute (provider downloads stop at 15–60 s, a queued download or a memory
// wait adds at most ~15 s more): a connection quiet for 60 s is closed, and the
// request itself (headers and the small JSON bodies) must arrive within 20 s.
const RESPONSE_LIMIT_MS = 60000;
const REQUEST_LIMIT_MS = 20000;
function applyServerLimits(server) {
  server.setTimeout(RESPONSE_LIMIT_MS);
  server.requestTimeout = REQUEST_LIMIT_MS;
  server.headersTimeout = REQUEST_LIMIT_MS;
  return server;
}

// --- Start server ---
if (require.main === module) {
  alerts.checkPreviousRun(STATS_DIR);
  applyServerLimits(app.listen(PORT, "0.0.0.0", () => {
    console.log(`StreamVault IPTV running on 0.0.0.0:${PORT}`);
  }));
  // Internal only: fly.toml exposes 7000 to the internet, this port just to Fly's scraper
  require("node:http").createServer((req, res) => {
    if (req.url !== "/metrics") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" }).end(buildMetricsText());
  }).on("error", (err) => {
    // Metrics are optional: never let them take the addon down
    console.error(`[METRICS] port ${METRICS_PORT} unavailable (${err.message}) — metrics off, addon keeps running`);
  }).listen(METRICS_PORT, "0.0.0.0", () => {
    console.log(`Metrics on :${METRICS_PORT}/metrics (internal)`);
  });
}

module.exports = { app, applyServerLimits, parseConfigPath, parseExtra, makePosterUrl, encryptConfig, decryptConfig, isPrivateIp, validateExternalUrl, safeError, formatAccountInfo, epgTimeRange, saveStats, buildMetricsText, checkMemory };
