/**
 * addon.js — Main Stremio IPTV addon entry point.
 *
 * Configuration is done entirely within Stremio's UI.
 * No browser needed — just add the manifest URL in Stremio and configure there.
 */

const express = require("express");
const path = require("node:path");
const crypto = require("node:crypto");
const { ROOT, safeError, userAgent, parseExtra, maskPath, withinMs } = require("./util");
const {
  encryptConfig, decryptConfig, configFromSettings, settingsFromEncrypted, settingsFromBase64,
  configFromQueryString, normalizeXtreamLogin,
} = require("./configlink");
const {
  STATS_DIR, stats, userKey, uniqueCounts, addDailyUser, todayKey, countToday, countCode,
  noteRecent, saveStats, saveStatsSync, recentErrors, recentUnknownPaths, recentEmptyStreams,
  recentUnconfigured, recentPlayRejects, recentBadLinks, recentTestFailures,
} = require("./stats");
const {
  m3uCache, M3U_CACHE_MAX, xtreamCache, XTREAM_CACHE_MAX, EPG_CACHE_MAX, epgCache, accountCache,
  setCapped, touch, inflight, MAX_PARALLEL_DOWNLOADS, downloadsRunningNow, downloadQueue,
  failCache, handleProviderError, HEAP_WARN_MB, HEAP_CRIT_MB, memStats, checkMemory,
} = require("./cache");
const {
  NOTICES, classifyError, SETUP_PLAY_STREAM, noticeMeta, ACCOUNT_WAIT_MS, accountNotice,
  accountProblem,
} = require("./notices");
const {
  xtreamCategoryIds, getXtreamCatalog, epgTimeRange, getXtreamAccount, getXtreamMeta,
  getXtreamStreams,
} = require("./xtream-addon");
const { getM3UCatalog, getM3UMeta, getM3UStreams } = require("./m3u-addon");
const { registerApiRoutes, formatAccountInfo } = require("./api");
const xtream = require("./xtream");
const {
  makePosterUrl, cleanName, catalogView, catalogMeta, normalizeForSearch,
} = require("./catalog");
const STATS_SECRET = process.env.STATS_SECRET || "";

const {
  isPrivateIp, validateExternalUrl, isExternalUrlSyntax, trimTrailingSlashes,
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
    return res.status(413).json({ ok: false, error: "Too much text sent — paste the playlist link (http://…), not the playlist itself" });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid request" });
  }
  next(err);
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

// --- SSRF protection: see urlguard.js (also enforced inside m3u.js / xtream.js) ---

// --- Serve static files (logo, images) ---
// Cached by browsers/Stremio for a week so repeat visits don't re-download images
app.use("/public", express.static(path.join(ROOT, "public"), { maxAge: "7d" }));

// Browsers ask for these icons on their own. Without them the "unknown page →
// /configure" fallback sent them the configure page, so every visit downloaded
// (and counted) the page twice.
const ICON_FILE = path.join(ROOT, "public", "img", "logo.png");
// (iPhones also try sized names like /apple-touch-icon-240x240-precomposed.png)
app.get(["/favicon.ico", /^\/apple-touch-icon[\w-]*\.png$/], (_req, res) => {
  res.sendFile(ICON_FILE, { maxAge: "7d" });
});

// --- Analytics: stats.js (saved in STATS_DIR — the /data volume on Fly.io) ---
// Stable install links ("s-<id>"): settings saved next to the stats, edited in place
const linkStore = require("./links").createStore(STATS_DIR);
const PROCESS_START = new Date().toISOString();

process.on("SIGTERM", () => { saveStatsSync(); linkStore.saveSync(); process.exit(0); });
process.on("SIGINT", () => { saveStatsSync(); linkStore.saveSync(); process.exit(0); });
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
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
  try {
    const config = parseConfigPath(req.params.config);
    if (config.missing) {
      return refuse("stable install link not found (saved settings missing)", "This StreamVault link no longer exists. Set it up again.");
    }
    // Cache key for things built from the settings (category list): a stable
    // link's settings can change, so its key includes the revision
    const saved = linkStore.get(req.params.config) || linkStore.getOverride(req.params.config);
    req.configKey = saved ? `${req.params.config}@${saved.revision}` : req.params.config;
    req.configRevision = saved ? saved.revision : 0;
    if (config.type === "xtream") Object.assign(config, normalizeXtreamLogin(config.server, config.username, config.password));
    if (config.type === "xtream" && (!config.server || !config.username || !config.password)) {
      return refuse("install link has no Xtream server/login", "Missing Xtream credentials.");
    }
    if (config.type === "m3u" && !config.url) {
      return refuse("install link has no playlist URL (not a valid StreamVault link)", "Missing M3U URL.");
    }
    req.userConfig = config;
    next();
  } catch (_) {
    refuse("install link can't be read", "Invalid configuration.");
  }
}

// A broken install link opened by an app (manifest/catalog/meta/stream): answered
// like an install without settings — the "Set up StreamVault first" tile says what
// to do, instead of an error the app retries silently (one Nuvio retried hourly).
// The configure page (/api/config) and /play keep their error responses.
function brokenLinkAnswer(req) {
  const route = req.route?.path || "";
  const { type, id } = req.params;
  if (route.endsWith("/manifest.json")) return BASE_MANIFEST;
  if (route.includes("/catalog/")) {
    return { metas: /(^|&)skip=[1-9]/.test(req.params.extra || "") ? [] : [noticeMeta("setup", type)] };
  }
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
    // Opened from an installed addon's Configure button (/<link>/configure)
    if (req.params.config) {
      stats.reconfigures++;
      countToday("reconfigures");
    }
    setCapped(lastConfigureAt, ip, now, 10000);
  }
  console.log(`[CONFIGURE] ${req.method} ${maskIp(ip)} opened configure page${counted ? "" : " (repeat, not counted)"}`);
  res.sendFile(path.join(ROOT, "public", "configure.html"));
}
// Crawlers may index the configure page (people find the addon) but nothing
// else — install links carry users' (encrypted) settings
app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").set("Cache-Control", "public, max-age=86400")
    .send("User-agent: *\nAllow: /configure\nAllow: /public/\nDisallow: /\n");
});

app.get("/configure", serveConfigure);
// Target of the QR code on the "Set up StreamVault first" tile (a short link keeps
// the code coarse enough to scan off a TV). Counted per day as setupScans.
// "?via=play|link" = tapped on a phone (Play button / link chip) rather than
// scanned: counted as setupTaps.
app.get("/setup", (req, res) => {
  countToday(req.query.via ? "setupTaps" : "setupScans");
  res.redirect(302, "/configure?from=tile");
});
app.get("/:config/configure", serveConfigure);

// --- Configure page API: api.js ---
registerApiRoutes(app, { linkStore, parseConfigPath, extractConfig, limitProviderChecks, limitConfig });

// --- Routes ---

// Root manifest (no config yet) — Stremio reads this to show config UI
app.get("/manifest.json", limitAddon, (_req, res) => {
  res.json(BASE_MANIFEST);
});

// Configured manifest (user completed install)
// Some users paste the configure page's link ("…/<link>/configure") into the app
// and it adds /manifest.json: answer it as the install link it was meant to be
app.get("/:config/configure/manifest.json", (req, _res, next) => {
  req.url = `/${req.params.config}/manifest.json`;
  next();
});

app.get("/:config/manifest.json", limitAddon, extractConfig, async (req, res) => {
  const ip = getIp(req);
  const user = userKey(ip);
  const isNew = !stats.users.has(user);
  if (isNew) {
    stats.users.add(user);
    stats.installs++;
    countToday("installs");
  }
  // Track config type and daily active
  const cType = req.userConfig.type;
  if (stats.configType[cType] !== undefined) stats.configType[cType]++;
  if (isNew && stats.installsByType[cType] !== undefined) stats.installsByType[cType]++;
  countToday("launches"); // Stremio fetches the manifest each time the app starts
  addDailyUser(stats.dailyActive, user);
  // Returning users aren't logged (apps re-read the manifest constantly — it was
  // most of the log); they're counted in /stats as launches / dau
  if (isNew) console.log(`[INSTALL] ${maskIp(ip)} NEW install — type: ${cType}`);
  let genres = await getGenresWithin(req.userConfig, req.configKey, GENRES_TIMEOUT_MS);
  // Channel list not ready in time (e.g. right after Save changes added a category):
  // the picked categories still go into the manifest — apps keep it until restart
  if (genres.length === 0) genres = await withinMs(pickedCategoryNames(req.userConfig), PICKED_NAMES_TIMEOUT_MS, []);
  res.json({ ...configuredManifest(genres, cType, req.userConfig), version: manifestVersion(req.configRevision) });
});

// --- Category filter: the user's own groups become the catalog's "genre" options ---
const PICKED_NAMES_TIMEOUT_MS = 3000;
// Picked categories by name in pick order, without the channel list: M3U group
// names are in the settings; Xtream ids → names via the (small) category list
async function pickedCategoryNames(config) {
  if (config.type === "m3u") return (config.groups || []).slice(0, MAX_GENRE_OPTIONS);
  const ids = xtreamCategoryIds(config);
  if (ids.length === 0) return [];
  const categories = await xtream.getLiveCategories(config);
  const names = new Map((Array.isArray(categories) ? categories : []).map(c => [String(c.category_id), c.category_name]));
  return ids.map(id => names.get(id)).filter(Boolean).slice(0, MAX_GENRE_OPTIONS);
}

const GENRES_TIMEOUT_MS = 8000;      // manifest must stay fast; fall back to no filter
const GENRES_CACHE_TTL = 6 * 60 * 60 * 1000;
const GENRES_CACHE_MAX = 500;
const MAX_GENRE_OPTIONS = 300;
const genresCache = new Map();       // config path -> { data: [names], ts }

// One extra home-screen row per category the user picked (pick order), after the
// main row. Ids come from the name, so an app's row settings survive edits.
const MAX_CATEGORY_ROWS = 8;
const MAIN_CATALOG_ID = "iptv_live";
function categoryCatalogId(name) {
  return `iptv_cat_${crypto.createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

function categoryRows(genres, config) {
  const picked = config.type === "xtream" ? xtreamCategoryIds(config).length : (config.groups || []).length;
  if (picked < 2 || genres.length < 2) return [];
  return genres.slice(0, MAX_CATEGORY_ROWS).map(name => ({
    type: "tv", id: categoryCatalogId(name), name: cleanName(name), extra: [{ name: "skip" }],
  }));
}

// Apps keep the manifest they installed and replace it when its version changes:
// each Save changes of a saved link (revision) gives "1.2.<revision>", so the new
// category list / rows reach the app. Links never saved stay on the base version.
function manifestVersion(revision) {
  return revision ? BASE_MANIFEST.version.replace(/\.\d+$/, `.${revision}`) : BASE_MANIFEST.version;
}

function configuredManifest(genres, type, config = {}) {
  const extra = [{ name: "search" }];
  // A single group (e.g. everything "Uncategorized") makes a useless dropdown
  if (genres.length > 1) extra.push({ name: "genre", options: genres, isRequired: false });
  extra.push({ name: "skip" });
  return {
    ...BASE_MANIFEST,
    // Says which other install to delete. Points at the live "Set up StreamVault
    // first" tile, not the empty install's description: apps keep the description
    // from install time, so older empty installs never show the new wording.
    description: `✓ Connected to your ${type === "xtream" ? "Xtream account" : "M3U playlist"}. If another StreamVault only shows “Set up StreamVault first”, delete that one.`,
    catalogs: [...BASE_MANIFEST.catalogs.map(c => ({ ...c, extra })), ...categoryRows(genres, config)],
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

  setCapped(genresCache, cacheKey, { data: names, ts: Date.now() }, GENRES_CACHE_MAX);
  return names;
}

// Slow/broken provider must not block the manifest — return [] (no filter) instead
function getGenresWithin(config, cacheKey, ms) {
  return withinMs(getGenres(config, cacheKey), ms, []);
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
    streamsPlayed: stats.streams,
    streamsByType: stats.streamsByType,
    searches: stats.searches,
    configType: stats.configType,
    installsByType: stats.installsByType,
    avgStreamsPerUser,
    dailyActiveUsers: last7,
    // Unique users per day who opened a channel and got something to play
    dailyViewers: viewers7,
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
  noteRecent(recentUnconfigured, { path: maskPath(req.path), userAgent: userAgent(req) });
  res.json(body);
}
app.get(["/catalog/:type/:id.json", "/catalog/:type/:id/:extra.json"], limitAddon, (req, res) => {
  const firstPage = !/(^|&)skip=[1-9]/.test(req.params.extra || "");
  serveUnconfigured(req, res, { metas: firstPage ? [noticeMeta("setup", req.params.type)] : [] });
});
// Apps also ask an empty install about films/series (tt… ids, "anime" type):
// not ours — counted as foreignRequests, not as an install without settings
const isBareForeign = (type, id) => type !== "tv" || !id.startsWith("iptv_");
app.get("/meta/:type/:id.json", limitAddon, (req, res) => {
  const { type, id } = req.params;
  if (isBareForeign(type, id)) return answerForeign(res, { meta: { id, type, name: "Unknown" } });
  serveUnconfigured(req, res, { meta: noticeMeta("setup", type) });
});
app.get("/stream/:type/:id.json", limitAddon, (req, res) => {
  if (isBareForeign(req.params.type, req.params.id)) return answerForeign(res, { streams: [] });
  const streams = req.params.id === "iptv_notice_setup" ? [SETUP_PLAY_STREAM] : [];
  serveUnconfigured(req, res, { streams });
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
    metas = catalogView(metas).display;
    if (!mainRow) extra.genre = categoryForRow(req.params.id, metas);
    const stale = staleCategoryAnswer(extra, metas, skip, type);
    if (stale) return res.json(stale);

    // Filter, paginate; channels carry the raw logo — posters built for this page only
    metas = filterCatalog(metas, extra).slice(skip, skip + PAGE_SIZE).map(catalogMeta);
    if (notice) metas.unshift(notice);

    res.json({ metas });
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
    const words = normalizeForSearch(extra.search).split(" ").filter(w => w.length > 0);
    result = result.filter(m => {
      const name = normalizeForSearch(m.name);
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
// Xtream stream id ("iptv_tv_mzansimagic.za" from the same user's M3U install).
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
      res.json({ meta });
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

    stats.streams++;
    countToday("streams");
    if (streams.length > 0) addDailyUser(stats.dailyViewers, userKey(getIp(req)));
    if (streams.length === 0) {
      countToday("emptyStreams");
      noteRecent(recentEmptyStreams, {
        source: config.type,
        type,
        id: id.slice(0, 80),
        reason: "channel is no longer in the user's playlist / category selection",
      });
    }
    if (stats.streamsByType[type] !== undefined) stats.streamsByType[type]++;
    res.json({ streams });
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
      streamType: req.params.streamType,
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
app.use((req, res) => {
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

// --- Metrics (Prometheus text) for Fly's built-in Grafana ---
// Same numbers as /stats, as gauges/counters Grafana can graph over time.
function buildMetricsText() {
  const w = metrics.createWriter();
  const g = (name, help, value, labels) => w.add(`streamvault_${name}`, "gauge", help, value, labels);
  const c = (name, help, value, labels) => w.add(`streamvault_${name}`, "counter", help, value, labels);

  // Process: memory, CPU, uptime, event loop
  const mem = process.memoryUsage();
  const heapLimit = require("node:v8").getHeapStatistics().heap_size_limit;
  g("memory_bytes", "Process memory", mem.rss, { kind: "rss" });
  g("memory_bytes", "Process memory", mem.heapUsed, { kind: "heap_used" });
  g("memory_bytes", "Process memory", mem.heapTotal, { kind: "heap_total" });
  g("memory_bytes", "Process memory", mem.external, { kind: "external" });
  g("memory_bytes", "Process memory", heapLimit, { kind: "heap_limit" });
  g("memory_threshold_bytes", "Heap watchdog thresholds", HEAP_WARN_MB * 1024 * 1024, { level: "warn" });
  g("memory_threshold_bytes", "Heap watchdog thresholds", HEAP_CRIT_MB * 1024 * 1024, { level: "crit" });
  c("memory_evictions_total", "Cache evictions by the heap watchdog", memStats.warnEvictions, { level: "warn" });
  c("memory_evictions_total", "Cache evictions by the heap watchdog", memStats.critEvictions, { level: "crit" });
  const cpu = process.cpuUsage();
  c("cpu_seconds_total", "CPU time used by the process", cpu.user / 1e6, { mode: "user" });
  c("cpu_seconds_total", "CPU time used by the process", cpu.system / 1e6, { mode: "system" });
  g("uptime_seconds", "Seconds since the process started", process.uptime());
  metrics.writeEventLoop(w);

  // Caches and downloads
  const cache = (name, size, max) => {
    g("cache_entries", "Entries in each in-memory cache", size, { cache: name });
    if (max) g("cache_capacity", "Maximum entries per cache", max, { cache: name });
  };
  cache("m3u", m3uCache.size, M3U_CACHE_MAX);
  cache("xtream", xtreamCache.size, XTREAM_CACHE_MAX);
  cache("accounts", accountCache.size, XTREAM_CACHE_MAX);
  cache("epg", epgCache.size, EPG_CACHE_MAX);
  cache("genres", genresCache.size, GENRES_CACHE_MAX);
  g("failed_providers", "Providers in the 2-minute failure cache", [...failCache.values()].filter(f => f.until > Date.now()).length);
  g("downloads_running", "Big provider downloads running now", downloadsRunningNow());
  g("downloads_capacity", "Big provider downloads allowed at once", MAX_PARALLEL_DOWNLOADS);
  g("downloads_waiting", "Big provider downloads waiting for a slot", downloadQueue.length);
  g("inflight_loads", "Shared in-flight loads (once())", inflight.size);
  g("stable_links", "Saved stable install links + edited old links (links.json)", linkStore.size());

  // All-time usage (from stats.json, survives restarts)
  c("installs_total", "Installs (new users) since the start", stats.installs);
  c("configures_total", "Configure page visits since the start", stats.configures);
  c("reconfigures_total", "Configure opened from an installed StreamVault (all time)", stats.reconfigures);
  c("reinstalls_total", "Save changes pressed on the configure page (all time)", stats.reinstalls);
  c("streams_total", "Stream requests since the start", stats.streams);
  c("searches_total", "Searches since the start", stats.searches);
  g("unique_users", "Unique users since the start", stats.users.size);
  for (const [type, n] of Object.entries(stats.streamsByType || {})) {
    c("streams_by_type_total", "Stream requests by type since the start", n, { type });
  }

  writeTodayMetrics(g);
  writeRecentMetrics(g);

  metrics.writeHttp(w);
  return w.text();
}

// Today (UTC) — every daily counter, the provider errors and our error responses
function writeTodayMetrics(g) {
  const today = todayKey();
  const row = stats.history[today] || {};
  g("today", "Today's (UTC) daily counters, as in /stats history", stats.dailyActive[today]?.size || 0, { counter: "dau" });
  g("today", "Today's (UTC) daily counters, as in /stats history", stats.dailyViewers[today]?.size || 0, { counter: "viewers" });
  for (const [counter, value] of Object.entries(row)) {
    if (typeof value === "number" && counter !== "dau" && counter !== "viewers") g("today", "Today's (UTC) daily counters, as in /stats history", value, { counter });
  }
  for (const [where, codes] of Object.entries(row.providerErrors || {})) {
    for (const [code, n] of Object.entries(codes)) {
      g("today_provider_errors", "Today's provider failures by where and status/kind", n, { where, code });
    }
  }
  for (const [endpoint, codes] of Object.entries(row.responseErrors || {})) {
    for (const [status, n] of Object.entries(codes)) {
      g("today_response_errors", "Today's error responses we sent, by endpoint and status", n, { endpoint, status });
    }
  }
}

// Recent events (same masked lists as /stats, newest 20 each): one series per
// entry, fields as labels, value = event time — Grafana shows them as tables
function writeRecentMetrics(g) {
  const recentLists = {
    recent_errors: recentErrors,
    recent_test_failures: recentTestFailures,
    recent_bad_links: recentBadLinks,
    recent_play_rejects: recentPlayRejects,
    recent_empty_streams: recentEmptyStreams,
    recent_unknown_paths: recentUnknownPaths,
    recent_unconfigured: recentUnconfigured,
  };
  for (const [name, list] of Object.entries(recentLists)) {
    const help = `Latest ${name.replaceAll("_", " ")} as in /stats (value = event time, unix seconds)`;
    for (const entry of list) g(name, help, Date.parse(entry.at) / 1000, entryLabels(entry));
  }
}

// { userAgent: "x", missing: null } → { user_agent: "x" } (values capped at 200 chars)
function entryLabels(entry) {
  const labels = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value != null) labels[key.replaceAll(/[A-Z]/g, (ch) => "_" + ch.toLowerCase())] = String(value).slice(0, 200);
  }
  return labels;
}

// --- Start server ---
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`StreamVault IPTV running on 0.0.0.0:${PORT}`);
  });
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

module.exports = { app, parseConfigPath, parseExtra, makePosterUrl, encryptConfig, decryptConfig, isPrivateIp, validateExternalUrl, safeError, formatAccountInfo, epgTimeRange, saveStats, buildMetricsText, checkMemory };
