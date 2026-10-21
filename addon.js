/**
 * addon.js — Main Stremio IPTV addon entry point.
 *
 * Configuration is done entirely within Stremio's UI.
 * No browser needed — just add the manifest URL in Stremio and configure there.
 */

const express = require("express");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const xtream = require("./xtream");
const m3u = require("./m3u");

// --- Encryption for config URLs ---
// The fallback is for local dev only: in production it would let anyone decrypt
// users' provider credentials from their install URLs. Fly sets FLY_APP_NAME.
const IS_PRODUCTION = !!process.env.FLY_APP_NAME || process.env.NODE_ENV === "production";
if (IS_PRODUCTION && !process.env.CONFIG_SECRET) {
  console.error("[FATAL] CONFIG_SECRET is not set — refusing to start in production");
  process.exit(1);
}
const CONFIG_SECRET = process.env.CONFIG_SECRET || "dev-secret";
const STATS_SECRET = process.env.STATS_SECRET || "";
const encryptionKey = crypto.scryptSync(CONFIG_SECRET, "streamvault-salt", 32);

function encryptConfig(configObj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  let encrypted = cipher.update(JSON.stringify(configObj), "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return iv.toString("hex") + authTag + encrypted;
}

function decryptConfig(encStr) {
  const iv = Buffer.from(encStr.slice(0, 24), "hex");
  const authTag = Buffer.from(encStr.slice(24, 56), "hex");
  const ciphertext = encStr.slice(56);
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

const { isPrivateIp, validateExternalUrl, isExternalUrlSyntax, trimTrailingSlashes } = require("./urlguard");

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
app.use((err, req, res, next) => {
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
app.use((req, res, next) => {
  if (req.url.includes("/manifest.json/")) req.url = req.url.replace("/manifest.json/", "/");
  next();
});

// --- Health check for Fly.io (must be unauthenticated for Fly's built-in checks) ---
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// --- Client IP + per-IP limits (see ratelimit.js) ---
const { getIp, maskIp, rateLimit } = require("./ratelimit");
const MINUTE = 60 * 1000;
const limitProviderChecks = rateLimit("provider-check", 10, MINUTE); // each downloads from the provider
const limitConfig = rateLimit("config", 30, MINUTE);
const limitStats = rateLimit("stats", 5, MINUTE);                    // slows guessing STATS_SECRET
// Stremio requests are cheap (served from cache) but bursty: some apps preload the
// channel page of every channel in a catalog page. 300/min blocked real users.
const limitAddon = rateLimit("addon", 1500, MINUTE);

// --- Helper: sanitize error messages (never leak URLs/credentials) ---
function safeError(e) {
  const msg = e.message || "Unknown error";
  if (msg.includes("://")) return "Connection failed";
  if (msg.length > 100) return msg.slice(0, 100);
  return msg;
}

// --- SSRF protection: see urlguard.js (also enforced inside m3u.js / xtream.js) ---

// --- Serve static files (logo, images) ---
// Cached by browsers/Stremio for a week so repeat visits don't re-download images
app.use("/public", express.static(path.join(__dirname, "public"), { maxAge: "7d" }));

// Browsers ask for these icons on their own. Without them the "unknown page →
// /configure" fallback sent them the configure page, so every visit downloaded
// (and counted) the page twice.
const ICON_FILE = path.join(__dirname, "public", "img", "logo.png");
// (iPhones also try sized names like /apple-touch-icon-240x240-precomposed.png)
app.get(["/favicon.ico", /^\/apple-touch-icon[\w-]*\.png$/], (req, res) => {
  res.sendFile(ICON_FILE, { maxAge: "7d" });
});

// --- Analytics (use /data volume on Fly.io for persistence across deploys) ---
// STATS_DIR env only for tests (a throwaway folder); production uses the /data volume
const STATS_DIR = process.env.STATS_DIR || (fs.existsSync("/data") ? "/data" : __dirname);
// Stable install links ("s-<id>"): settings saved next to the stats, edited in place
const linkStore = require("./links").createStore(STATS_DIR);
const STATS_FILE = path.join(STATS_DIR, "stats.json");
const PROCESS_START = new Date().toISOString();
let stats = {
  installs: 0, configures: 0, streams: 0, searches: 0,
  users: new Set(), startedAt: new Date().toISOString(),
  streamsByType: { tv: 0, movie: 0, series: 0 },
  configType: { xtream: 0, m3u: 0 },
  installsByType: { xtream: 0, m3u: 0 },
  dailyActive: {},  // { "2026-05-31": Set([user keys]) }
  history: {},      // { "2026-05-31": { launches, installs, ..., catalogErrors, dau } }
};

// Unique users are counted by a one-way code of the IP, never the IP itself, so
// stats.json holds no personal data. Keyed with a secret derived from
// CONFIG_SECRET: without it the codes can't be reversed by trying every IPv4.
const userKeySecret = crypto.createHash("sha256").update(`stats-users|${CONFIG_SECRET}`).digest();
const USER_KEY_RE = /^[0-9a-f]{16}$/;
function userKey(ip) {
  return crypto.createHmac("sha256", userKeySecret).update(String(ip)).digest("hex").slice(0, 16);
}
// Entries saved before this change are plain IPs — convert them on load
function toUserKeys(list) {
  return new Set((list || []).map(v => (USER_KEY_RE.test(v) ? v : userKey(v))));
}

try {
  const saved = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
  stats = { ...saved, users: toUserKeys(saved.users) };
  if (!stats.streamsByType) stats.streamsByType = { tv: 0, movie: 0, series: 0 };
  if (!stats.configType) stats.configType = { xtream: 0, m3u: 0 };
  if (!stats.installsByType) stats.installsByType = { xtream: 0, m3u: 0 };
  if (!stats.dailyActive) stats.dailyActive = {};
  if (!stats.history) stats.history = {};
  // Restore daily active Sets
  for (const day of Object.keys(stats.dailyActive)) {
    stats.dailyActive[day] = toUserKeys(stats.dailyActive[day]);
  }
} catch (_) {
  // No stats.json yet (first start) or unreadable: start counting from zero
}

const MAX_TRACKED_USERS = 10000;

function saveStatsData() {
  // Cap users Set to prevent unbounded growth
  if (stats.users.size > MAX_TRACKED_USERS) {
    const arr = [...stats.users];
    stats.users = new Set(arr.slice(arr.length - MAX_TRACKED_USERS));
  }
  // Keep only last 30 days of dailyActive
  const dailySerialized = {};
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  for (const [day, keys] of Object.entries(stats.dailyActive)) {
    if (new Date(day) >= cutoff) dailySerialized[day] = [...keys];
  }
  // Keep 90 days of per-day rows; freeze each day's unique-user count into its
  // row so it survives after dailyActive (30 days) drops the IP list
  const historyCutoff = new Date();
  historyCutoff.setDate(historyCutoff.getDate() - HISTORY_DAYS);
  const history = {};
  for (const [day, row] of Object.entries(stats.history)) {
    if (new Date(day) < historyCutoff) continue;
    history[day] = stats.dailyActive[day] ? { ...row, dau: stats.dailyActive[day].size } : row;
  }
  stats.history = history;
  return { ...stats, users: [...stats.users], dailyActive: dailySerialized };
}

// --- Per-day history (trends) + failures (provider problems) ---
const HISTORY_DAYS = 90;
const MAX_RECENT_ERRORS = 20;
// In memory only (reset on restart), newest first, never URLs/credentials:
const recentErrors = [];        // provider failures
const recentUnknownPaths = [];  // requests StreamVault answered 404 (paths masked)
const recentEmptyStreams = [];  // stream requests that returned nothing, and why
const recentUnconfigured = [];  // requests from installs without settings (+ which app)
const recentPlayRejects = [];   // /play redirects refused, and which check failed
const recentBadLinks = [];      // install links refused (manifest/catalog/meta/stream), and why
const recentTestFailures = [];  // failed Test Connections: error + address shape (private parts hidden)

// Which app/browser sent the request (to tell e.g. an old Stremio TV build from a bot)
function userAgent(req) {
  return String(req.get("user-agent") || "none").slice(0, 150);
}

function noteRecent(list, entry) {
  list.unshift({ at: new Date().toISOString(), ...entry });
  if (list.length > MAX_RECENT_ERRORS) list.pop();
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dayRow() {
  const day = todayKey();
  if (!stats.history[day]) {
    stats.history[day] = {
      launches: 0, installs: 0, configures: 0, searches: 0, streams: 0,
      catalogErrors: 0, metaErrors: 0, streamErrors: 0, emptyStreams: 0,
      // what users' providers returned, by where it happened: { catalog: { "503": 2 } }
      providerErrors: {},
      // what StreamVault answered with status >= 400, by endpoint: { "POST /api/test": { "429": 3 } }
      responseErrors: {},
    };
  }
  return stats.history[day];
}


function countToday(field) {
  const row = dayRow();
  row[field] = (row[field] || 0) + 1;
}

// Per-day count by where + code: row[mapName][where][code]. Each level only takes
// so many distinct keys, so random status codes can't bloat stats.json — extras
// go to "other".
const MAX_KEYS_PER_LEVEL = 30;
function boundedKey(obj, key) {
  return obj[key] !== undefined || Object.keys(obj).length < MAX_KEYS_PER_LEVEL ? key : "other";
}
function countCode(mapName, where, code) {
  const row = dayRow();
  const map = row[mapName] || (row[mapName] = {}); // rows from before error tracking have none
  const w = boundedKey(map, where);
  const codes = map[w] || (map[w] = {});
  const c = boundedKey(codes, code);
  codes[c] = (codes[c] || 0) + 1;
}

// Provider failure → HTTP status ("503") or, without one, what went wrong
function providerErrorKey(e) {
  const msg = String(e?.message || "");
  const status = (/status code (\d{3})/.exec(msg) || [])[1];
  if (status) return status;
  // https:// address on a server that only speaks plain http on that port
  if (/EPROTO|wrong version number|SSL routines/i.test(msg)) return "https_mismatch";
  if (/Invalid or blocked URL|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(msg)) return "bad_address";
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return "timeout";
  return "other";
}

// where = "catalog" | "meta" | "stream"
function recordError(where, config, e) {
  countToday(`${where}Errors`);
  countCode("providerErrors", `${where} (${config?.type || "unknown"})`, providerErrorKey(e));
  noteRecent(recentErrors, { where, source: config?.type, error: safeError(e) });
}

// Saves write a temp file and rename it over stats.json. A rename is all-or-nothing,
// so a crash/deploy mid-save leaves the previous stats.json intact instead of a
// half-written file (which would fail to load and reset all stats to zero).
let saving = false;

function saveStats() {
  if (saving) return; // previous save still running — the next interval saves again
  let data;
  try {
    data = JSON.stringify(saveStatsData(), null, 2);
  } catch (_) {
    return; // nothing started, so the flag is never left stuck on
  }
  saving = true;
  const tmp = `${STATS_FILE}.tmp`;
  fs.promises.writeFile(tmp, data)
    .then(() => fs.promises.rename(tmp, STATS_FILE))
    .catch(() => { /* disk error: the old stats.json stays; the next interval tries again */ })
    .finally(() => { saving = false; });
}

// On shutdown: sync (the process exits right after) and its own temp file, since an
// async save may be writing stats.json.tmp at this very moment
function saveStatsSync() {
  try {
    const tmp = `${STATS_FILE}.exit.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saveStatsData(), null, 2));
    fs.renameSync(tmp, STATS_FILE);
  } catch (_) {
    // Shutting down anyway; at worst the last minute of stats is lost
  }
}

setInterval(saveStats, 60000);
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

// --- In-memory caches ---
const m3uCache = new Map();
const M3U_CACHE_TTL = 10 * 60 * 1000;
// A full (10k-channel cap) playlist measured ~5 MB parsed → 15 ≈ 75 MB worst case,
// well under the 450 MB watchdog; fewer re-downloads as users grow
const M3U_CACHE_MAX = 15;
const xtreamCache = new Map();
const XTREAM_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
const XTREAM_CACHE_MAX = 25;
// Account info (expiry date) is one tiny request: re-read often so a renewal
// clears the expiry notice quickly, and retry a failed lookup after a few minutes
const ACCOUNT_CACHE_TTL = 30 * 60 * 1000;
const ACCOUNT_RETRY_MS = 3 * 60 * 1000;
// After its TTL an entry is still answered at once for this long while one
// background load refreshes it (usableEntry), so users don't wait for re-downloads
const M3U_STALE_MS = 50 * 60 * 1000;
const XTREAM_STALE_MS = 4 * 60 * 60 * 1000;
const ACCOUNT_STALE_MS = 6 * 60 * 60 * 1000;
// TV guide per channel, briefly: reopening a channel page (apps often ask twice)
// doesn't wait for the provider again. Keyed by panel + stream, not the user.
const EPG_CACHE_TTL = 3 * 60 * 1000;
const EPG_CACHE_MAX = 1000;
const epgCache = new Map();

function setCapped(cache, key, value, max) {
  cache.set(key, value);
  if (cache.size > max) {
    cache.delete(cache.keys().next().value); // evict oldest (insertion order)
  }
}

// Concurrent cache misses for the same key share one download instead of each
// fetching + parsing it (catalog/meta/stream/manifest often arrive together)
const inflight = new Map();

function once(key, load) {
  if (inflight.has(key)) return inflight.get(key);
  const p = load().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// At most this many large provider downloads (whole playlists / full Xtream
// channel lists) run at the same time across all users; the rest wait their
// turn. Per-IP limits can't stop many users downloading at once on 1 shared CPU.
const MAX_PARALLEL_DOWNLOADS = 4;
let downloadsRunning = 0;
const downloadQueue = []; // resolve callbacks of waiting downloads, in order

async function withDownloadSlot(download) {
  countToday("downloads");
  if (downloadsRunning >= MAX_PARALLEL_DOWNLOADS) {
    // All slots busy: count it and how long this one waited (stats history)
    countToday("downloadsQueued");
    const waitStart = Date.now();
    await new Promise(resolve => downloadQueue.push(resolve));
    const row = dayRow();
    row.longestDownloadWaitMs = Math.max(row.longestDownloadWaitMs || 0, Date.now() - waitStart);
  } else {
    downloadsRunning++;
  }
  try {
    return await download();
  } finally {
    // Hand the slot straight to the next waiter (running count unchanged), or free it
    const next = downloadQueue.shift();
    if (next) next();
    else downloadsRunning--;
  }
}

// Negative cache: a provider that just failed (down, refusing, timing out) is not
// asked again for FAIL_TTL — requests in that window fail at once with the same
// error. Without it every catalog/channel page of a dead provider re-downloaded
// (one day: 171× "521" from a single down server), each holding a download slot.
const FAIL_TTL = 2 * 60 * 1000;
const FAIL_CACHE_MAX = 500;
const failCache = new Map(); // key -> { message, until }

async function withFailureCache(key, load) {
  const failed = failCache.get(key);
  if (failed?.until > Date.now()) {
    // Answered from memory: the provider was NOT contacted. Marked so handlers
    // don't log/count it as another provider failure (one app opening 57
    // channel pages of a dead provider used to log 57 errors).
    failed.repeats++;
    const err = new Error(failed.message);
    err.fromFailureCache = true;
    throw err;
  }
  if (failed?.repeats > 0) {
    console.log(`[FAILCACHE] ${failed.repeats} more request(s) were answered from cache after: ${safeError(failed)}`);
  }
  try {
    const data = await load();
    failCache.delete(key);
    return data;
  } catch (e) {
    // Only the message is kept (the original error can hold request details)
    setCapped(failCache, key, { message: e?.message || "Unknown error", until: Date.now() + FAIL_TTL, repeats: 0 }, FAIL_CACHE_MAX);
    throw e;
  }
}

// Requests that waited for the same download (once()) all get the same error
// object: the provider was contacted once, so the failure is counted once
const reportedErrors = new WeakSet();

// Catalog/meta/stream handlers: log + count a real provider failure, or just
// count a repeat (answered from the failure cache, or a shared download)
function handleProviderError(where, req, e) {
  const shared = e !== null && typeof e === "object";
  if (e?.fromFailureCache || (shared && reportedErrors.has(e))) {
    countToday("cachedFailures");
    return;
  }
  if (shared) reportedErrors.add(e);
  console.error(`${where[0].toUpperCase()}${where.slice(1)} error:`, e.message);
  recordError(where, req.userConfig, e);
}

// Cache entry → fresh: use it. Expired but within `staleFor`: use it anyway and
// refresh it in the background (once() keeps that to one load, download slots
// and the failure cache still apply), so nobody waits for a re-download; a failed
// refresh keeps the old copy. Older or missing: null — the caller loads and waits.
function usableEntry(entry, ttl, staleFor, refresh) {
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (age < ttl) return entry;
  if (age >= ttl + staleFor) return null;
  refresh().catch((e) => {
    if (!e?.fromFailureCache) console.warn(`[REFRESH] kept the previous copy: ${safeError(e)}`);
  });
  return entry;
}

// Same playlist with a different group selection is a different (smaller) entry
function m3uCacheKey(config) {
  const groups = config.groups || [];
  return groups.length ? `${config.url}\u0001${groups.join("\u0001")}` : config.url;
}

async function getCachedM3U(config) {
  const groups = config.groups || [];
  const key = m3uCacheKey(config);
  const load = () => once(`m3u:${key}`, () => withFailureCache(`m3u:${key}`, async () => {
    const data = await withDownloadSlot(() => m3u.parseM3U(config.url, groups));
    setCapped(m3uCache, key, { data, ts: Date.now() }, M3U_CACHE_MAX);
    return data;
  }));
  const cached = usableEntry(m3uCache.get(key), M3U_CACHE_TTL, M3U_STALE_MS, load);
  return cached ? cached.data : load();
}

// Config "g" = JSON array of M3U group-titles the user picked (empty/invalid = all)
const MAX_SELECTED_GROUPS = 300;
function parseGroups(g) {
  if (!g) return [];
  try {
    const arr = JSON.parse(g);
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => typeof x === "string" && x).slice(0, MAX_SELECTED_GROUPS);
  } catch (_) {
    return []; // not valid JSON: treat as "all groups"
  }
}

// --- Cache eviction (runs every 10 min) ---
setInterval(() => {
  const now = Date.now();
  // Entries stay usable (stale) for a while after their TTL — see usableEntry
  for (const [key, val] of m3uCache) {
    if (now - val.ts > M3U_CACHE_TTL + M3U_STALE_MS) m3uCache.delete(key);
  }
  for (const [key, val] of xtreamCache) {
    if (now - val.ts > XTREAM_CACHE_TTL + XTREAM_STALE_MS) xtreamCache.delete(key);
  }
  for (const [key, val] of accountCache) {
    if (now - val.ts > ACCOUNT_CACHE_TTL + ACCOUNT_STALE_MS) accountCache.delete(key);
  }
  for (const [key, val] of epgCache) {
    if (now - val.ts > EPG_CACHE_TTL) epgCache.delete(key);
  }
}, 10 * 60 * 1000);

// --- Memory pressure eviction (runs every 10s) ---
// Thresholds sit below the --max-old-space-size=640 ceiling (see fly.toml) so
// the safety net clears caches with headroom to spare before the hard cap.
const HEAP_WARN_MB = 450;
const HEAP_CRIT_MB = 550;
// Surfaced in /stats so cache sizes can be tuned from real numbers (since last restart)
const memStats = { heapPeakMB: 0, rssPeakMB: 0, warnEvictions: 0, critEvictions: 0, lastEviction: null };
setInterval(() => {
  const { heapUsed, rss } = process.memoryUsage();
  const mb = heapUsed / 1024 / 1024;
  memStats.heapPeakMB = Math.max(memStats.heapPeakMB, Math.round(mb));
  memStats.rssPeakMB = Math.max(memStats.rssPeakMB, Math.round(rss / 1024 / 1024));
  if (mb > HEAP_CRIT_MB) {
    m3uCache.clear();
    xtreamCache.clear();
    accountCache.clear();
    epgCache.clear();
    memStats.critEvictions++;
    memStats.lastEviction = new Date().toISOString();
    console.warn(`[MEM] heap ${mb.toFixed(0)} MB — cleared all caches`);
  } else if (mb > HEAP_WARN_MB) {
    const keys = [...m3uCache.keys()];
    keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => m3uCache.delete(k));
    memStats.warnEvictions++;
    memStats.lastEviction = new Date().toISOString();
    console.warn(`[MEM] heap ${mb.toFixed(0)} MB — evicted oldest M3U cache entries`);
  }
}, 10 * 1000);

// --- Base manifest (unconfigured) — Stremio shows the config form ---
const BASE_MANIFEST = {
  id: "community.streamvault.addon",
  version: "1.1.0",
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

// --- Parse config from URL path segment (supports encrypted, base64url, and legacy URL-encoded) ---
// Settings object (short keys) → config the handlers use; null if not a StreamVault setup
function configFromSettings(obj) {
  if (!obj) return null;
  if (obj.t === "xtream") {
    return { type: "xtream", server: obj.s || "", username: obj.u || "", password: obj.p || "", country: obj.c || "", timezone: obj.z || "" };
  }
  if (obj.t === "m3u") {
    return { type: "m3u", url: obj.m || "", country: obj.c || "", timezone: obj.z || "", groups: parseGroups(obj.g) };
  }
  return null;
}

// "e-<hex>": AES-256-GCM encrypted settings; null if it doesn't decrypt
function settingsFromEncrypted(configStr) {
  if (!/^e-[0-9a-f]+$/i.test(configStr)) return null;
  try {
    return decryptConfig(configStr.slice(2));
  } catch (_) {
    return null; // tampered or not ours — try the other formats
  }
}

// "ey…": base64url JSON (legacy); null if it doesn't decode
function settingsFromBase64(configStr) {
  if (!/^ey[A-Za-z0-9_-]+$/.test(configStr)) return null;
  try {
    const base64 = configStr.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch (_) {
    return null; // not JSON — fall through to the oldest format
  }
}

// Oldest format: URL-encoded key=value&key2=value2
function configFromQueryString(configStr) {
  const params = {};
  for (const pair of decodeURIComponent(configStr).split("&")) {
    const idx = pair.indexOf("=");
    if (idx > -1) params[pair.substring(0, idx)] = pair.substring(idx + 1);
  }
  if (params.sourceType === "xtream") {
    return {
      type: "xtream",
      server: decodeURIComponent(params.server || ""),
      username: decodeURIComponent(params.username || ""),
      password: decodeURIComponent(params.password || ""),
      country: decodeURIComponent(params.country || ""),
    };
  }
  return {
    type: "m3u",
    url: decodeURIComponent(params.m3uUrl || ""),
    country: decodeURIComponent(params.country || ""),
  };
}

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

// An M3U playlist link ("…/index.m3u", or a bare "http://name.m3u") typed into
// the Xtream server field — player_api.php can't exist under it, so the test
// would only fail with 404. Query/hash ignored ("list.m3u8?token=…" counts).
function isPlaylistLink(url) {
  try {
    const u = new URL(url);
    return /\.m3u8?$/i.test(u.pathname === "/" ? u.hostname : u.pathname);
  } catch (_) {
    return false; // not a URL at all — validation reports that separately
  }
}

// --- Middleware: extract config from URL path ---
// Users often paste their provider's full link into "Server address", e.g.
// "http://provider.com:8080/get.php?username=abc&password=123&type=m3u_plus".
// Xtream needs just the server (scheme + host + port): take that, and fill an
// empty username/password from the link. Anything else is left unchanged.
function normalizeXtreamLogin(server, username, password) {
  const out = {
    server: String(server || "").trim(),
    username: String(username || "").trim(),
    password: String(password || "").trim(),
  };
  try {
    const u = new URL(out.server);
    const isFullLink = /\/(get|player_api|xmltv|panel_api)\.php$/i.test(u.pathname) || u.searchParams.has("username");
    if (isFullLink) {
      if (!out.username) out.username = u.searchParams.get("username") || "";
      if (!out.password) out.password = u.searchParams.get("password") || "";
      out.server = u.origin;
    }
  } catch (_) {
    return out; // not a URL: left as typed — validation reports it
  }
  return out;
}

function extractConfig(req, res, next) {
  // Refused install links are listed in /stats (recentBadLinks; /play has its own list)
  const refuse = (reason, error) => {
    res.locals.rejectReason = reason;
    if (!req.path.startsWith("/play/")) {
      noteRecent(recentBadLinks, { route: req.route ? req.route.path : maskPath(req.path), reason, userAgent: userAgent(req) });
    }
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
    noteAppForLink(req);
    if (config.type === "xtream") Object.assign(config, normalizeXtreamLogin(config.server, config.username, config.password));
    if (config.type === "xtream" && (!config.server || !config.username || !config.password)) {
      return refuse("install link has no Xtream server/login", "Missing Xtream credentials.");
    }
    if (config.type === "m3u" && !config.url) {
      return refuse("install link has no playlist URL (not a valid StreamVault link)", "Missing M3U URL.");
    }
    req.userConfig = config;
    next();
  } catch (e) {
    refuse("install link can't be read", "Invalid configuration.");
  }
}

// --- Which app uses an install link (for "Restart Nuvio/Stremio" after a save) ---
// In memory only, never saved: link fingerprint -> "Nuvio" | "Stremio" | "both".
// Learned from the app's own catalog/meta/stream requests; the configure page
// itself opens in a browser that doesn't say which app sent it there.
const LINK_APPS_MAX = 50_000; // ~100 bytes each → a few MB at most
const linkApps = new Map();

function appFromUserAgent(ua) {
  if (/nuvio/i.test(ua)) return "Nuvio";
  if (/stremio/i.test(ua)) return "Stremio";
  return null; // okhttp, browsers, players… — unknown
}

const linkKey = (link) => (linkStore.isId(link) ? link : crypto.createHash("sha256").update(link).digest("base64"));

function noteAppForLink(req) {
  // Addon requests only: /api/* comes from the configure page, /play from the player
  if (req.path.startsWith("/api/") || req.path.startsWith("/play/")) return;
  const app = appFromUserAgent(String(req.get("user-agent") || ""));
  if (!app) return;
  const key = linkKey(req.params.config);
  const known = linkApps.get(key);
  linkApps.delete(key); // re-insert → most recently used stays, oldest is evicted first
  setCapped(linkApps, key, known && known !== app ? "both" : app, LINK_APPS_MAX);
}

/** "Nuvio" / "Stremio" when we're sure which app uses this link, else null */
function appForLink(link) {
  const app = link ? linkApps.get(linkKey(link)) : null;
  return app === "Nuvio" || app === "Stremio" ? app : null;
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
    if (req.params.config) countToday("reconfigures");
    setCapped(lastConfigureAt, ip, now, 10000);
  }
  console.log(`[CONFIGURE] ${req.method} ${maskIp(ip)} opened configure page${counted ? "" : " (repeat, not counted)"}`);
  res.sendFile(path.join(__dirname, "public", "configure.html"));
}
// Crawlers may index the configure page (people find the addon) but nothing
// else — install links carry users' (encrypted) settings
app.get("/robots.txt", (req, res) => {
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

// --- API: Fetch categories from provider ---
app.post("/api/categories", limitProviderChecks, async (req, res) => {
  try {
    const { server, username, password } = normalizeXtreamLogin(req.body.server, req.body.username, req.body.password);
    if (!server || !username || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }
    if (!(await validateExternalUrl(server))) {
      return res.status(400).json({ error: "Invalid or blocked server URL" });
    }
    const config = { server: trimTrailingSlashes(server), username, password };
    const live = await xtream.getLiveCategories(config).catch(() => []);
    res.json({ live });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// --- API: List M3U groups (configure page group picker) ---
// Counts only — no channels are kept in memory, and concurrent clicks share one download
app.post("/api/m3u-groups", limitProviderChecks, async (req, res) => {
  try {
    const { m3uUrl } = req.body || {};
    if (!m3uUrl) {
      return res.status(400).json({ error: "Missing M3U URL" });
    }
    if (!(await validateExternalUrl(m3uUrl))) {
      return res.status(400).json({ error: "Invalid or blocked M3U URL" });
    }
    const groups = await once(`groups:${m3uUrl}`, () => withDownloadSlot(() => m3u.parseM3UGroups(m3uUrl)));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// --- API: Encrypt config for secure URL ---
const ALLOWED_CONFIG_KEYS = new Set(["t", "s", "u", "p", "m", "c", "z", "g"]);
// An older install link that really is a StreamVault setup (so random strings
// can't be used to fill the store with overrides)
function isUsableOldLink(link) {
  try {
    const c = parseConfigPath(link);
    if (c.type === "m3u") return !!c.url;
    if (c.type === "xtream") return !!(c.server && c.username && c.password);
    return false;
  } catch (_) {
    return false; // can't be read, so it isn't a usable link
  }
}

// Settings from the configure page → only known fields, nothing cut off silently
function sanitizeConfig(configObj) {
  const type = configObj?.t;
  if (type !== "xtream" && type !== "m3u") {
    return { error: "Invalid config" };
  }
  const sanitized = {};
  for (const key of Object.keys(configObj)) {
    if (ALLOWED_CONFIG_KEYS.has(key)) {
      sanitized[key] = String(configObj[key]).slice(0, 2048);
    }
  }
  // A truncated selection would silently fall back to "all groups" (M3U) or
  // keep a cut-off list of category ids (Xtream)
  if (sanitized.g && String(configObj.g).length > 2048) return { error: "Too many groups selected — pick fewer" };
  if (sanitized.c && String(configObj.c).length > 2048) return { error: "Too many categories selected — pick fewer" };
  return { sanitized };
}

app.post("/api/encrypt", limitConfig, (req, res) => {
  try {
    const { error, sanitized } = sanitizeConfig(req.body);
    if (error) return res.status(400).json({ error });
    res.json({ config: "e-" + encryptConfig(sanitized) });
  } catch (e) {
    res.status(500).json({ error: "Encryption failed" });
  }
});

// Install link from the configure page: a stable "s-<id>" link. When the page
// was opened from an installed StreamVault ("editing" = its link), that link is
// updated in place — same link, so apps don't add a second StreamVault. An "s-"
// link gets its settings replaced; an older link (e-/base64/plain) gets an
// override. Only a full store (or an unreadable old link) gives a new link.
app.post("/api/link", limitConfig, (req, res) => {
  try {
    const { error, sanitized } = sanitizeConfig(req.body);
    if (error) return res.status(400).json({ error });
    const encrypted = encryptConfig(sanitized);
    // Saving reloads the channel list (configure page hint says so)
    const config = configFromSettings(sanitized);
    if (config.type === "xtream") Object.assign(config, normalizeXtreamLogin(config.server, config.username, config.password));
    forceRefresh(config);
    // Not truncated: a cut-off link would fingerprint as a different link
    const editing = typeof req.body.editing === "string" && req.body.editing.length <= 8192 ? req.body.editing : "";
    if (editing) countToday("reinstalls");
    // app: which app to tell the user to restart (null = say "your app")
    if (linkStore.isId(editing)) {
      if (linkStore.update(editing, encrypted)) return res.json({ config: editing, updated: true, app: appForLink(editing) });
    } else if (editing && isUsableOldLink(editing) && linkStore.setOverride(editing, encrypted)) {
      return res.json({ config: editing, updated: true, app: appForLink(editing) });
    }
    const id = linkStore.create(encrypted);
    res.json({ config: id || "e-" + encrypted, updated: false });
  } catch (e) {
    res.status(500).json({ error: "Couldn't save your settings" });
  }
});

// "Account: Active · expires 2026-12-01 · 1/2 connections" (parts the provider omits are skipped)
function formatAccountInfo(info) {
  if (!info || typeof info !== "object") return "";
  const parts = [];
  if (info.status) parts.push(String(info.status).slice(0, 20));
  if (String(info.is_trial) === "1") parts.push("trial");
  const exp = Number(info.exp_date);
  if (exp > 0) parts.push(`expires ${new Date(exp * 1000).toISOString().slice(0, 10)}`);
  else if (info.exp_date === null || info.exp_date === "null") parts.push("no expiry");
  const max = Number(info.max_connections);
  if (max > 0) {
    const active = Number(info.active_cons);
    parts.push(Number.isFinite(active) ? `${active}/${max} connections` : `${max} connections`);
  }
  return parts.length ? `Account: ${parts.join(" · ")}` : "";
}

// --- API: Read back an install's settings (configure page opened from Stremio) ---
// Whoever holds the install link can already use these credentials, so returning
// them to the same link holder exposes nothing new.
app.get("/api/config/:config", limitConfig, extractConfig, (req, res) => {
  const c = req.userConfig;
  res.setHeader("Cache-Control", "no-store");
  if (c.type === "xtream") {
    return res.json({
      type: "xtream", server: c.server, username: c.username, password: c.password,
      categories: (c.country || "").split(",").filter(Boolean),
    });
  }
  res.json({ type: "m3u", m3uUrl: c.url, categories: c.groups || [] });
});

// Why an Xtream account can't be used, or null when it looks fine / is unknown
// (providers that don't report user_info are never blocked)
function accountProblem(info) {
  if (!info || typeof info !== "object") return null;
  if (String(info.auth) === "0") return "Wrong username or password";
  const status = String(info.status || "").trim().toLowerCase();
  if (status !== "" && status !== "active") return `Your account is ${status.slice(0, 20)}`;
  const exp = Number(info.exp_date);
  if (exp > 0 && exp * 1000 < Date.now()) {
    return `Your account expired on ${new Date(exp * 1000).toISOString().slice(0, 10)}`;
  }
  return null;
}

// Plain-language Test Connection errors for cases whose raw message means nothing
// to users (keys from providerErrorKey)
const TEST_ERROR_HINTS = {
  https_mismatch: "Your server address should probably start with http:// instead of https://",
  "429": "Your provider is limiting requests — try again in a few minutes",
  "403": "Your provider refused the connection from StreamVault's server. Check the link/login; some providers block servers — if it works in your player app, contact your provider",
};

// A playlist link that works but has no live TV: say which of the usual causes
// it is (from what the parser saw), so users know what to fix
function whyNoLiveChannels(shape) {
  const s = shape || {};
  if (s.html) {
    return { kind: "no_channels_web_page", message: "This link returned a web page, not a playlist — check the link (it may have expired or need a login)" };
  }
  if (s.vod > 0) {
    return { kind: "no_channels_vod_only", message: `This playlist only has movies/series (${s.vod}) — StreamVault shows live TV channels only` };
  }
  if (s.lines === 0) {
    return { kind: "no_channels_empty", message: "This playlist is empty — check the link with your provider" };
  }
  if (s.extinf === 0) {
    return { kind: "no_channels_not_m3u", message: "This link doesn't look like an M3U playlist — check that you copied the playlist link" };
  }
  return { kind: "no_channels", message: "No live channels found in this playlist" };
}

// Address with everything private hidden: scheme + port + path structure only.
// Host → <host>; path segments → <seg> unless they're a known file name
// (get.php, player_api.php, *.m3u/.m3u8); query → "?…". Paths/queries can hold
// usernames, passwords and tokens, so nothing else is kept.
const KNOWN_PATH_FILE = /^([a-z_]+\.php|[^/]*\.m3u8?)$/i;
function addressShape(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch (_) {
    return "not a URL"; // that's the answer: the shape of what was entered
  }
  const path = u.pathname.split("/").map(seg => (!seg || KNOWN_PATH_FILE.test(seg) ? seg : "<seg>")).join("/");
  return `${u.protocol}//<host>${u.port ? ":" + u.port : ""}${path}${u.search ? "?…" : ""}`;
}

// --- API: Test connection to provider ---
// Why an Xtream test failed (provider-error kind + message for the user), or null
function xtreamTestProblem(cats, account) {
  // Many panels answer a bad login with an empty list instead of an error, so
  // the account status is what tells a wrong password / expired account apart
  const problem = accountProblem(account);
  if (problem) return ["account", problem];
  if (!Array.isArray(cats)) return ["invalid_response", "Invalid response from server"];
  if (cats.length === 0) return ["no_channels", "No live channels on this account"];
  return null;
}

// An address copied from a guide with its placeholder left in ("…/<FILENAME>.m3u")
const PLACEHOLDER_RE = /<[^<>]{1,40}>|%3C[^%]{1,40}%3E/i;
const PLACEHOLDER_HINT = "The address still contains a placeholder like <FILENAME> — replace it with your real playlist link";

// Test Connection, Xtream: login + categories (+ account status)
async function testXtream(body, res) {
  const { server, username, password } = normalizeXtreamLogin(body.server, body.username, body.password);
  if (PLACEHOLDER_RE.test(server)) {
    return res.status(400).json({ ok: false, error: PLACEHOLDER_HINT.replace("playlist link", "server address") });
  }
  if (isPlaylistLink(server)) {
    return res.status(400).json({ ok: false, error: "This is a playlist link — use the M3U tab instead" });
  }
  if (!server || !username || !password) {
    return res.status(400).json({ ok: false, error: "Missing credentials" });
  }
  if (!(await validateExternalUrl(server))) {
    return res.status(400).json({ ok: false, error: "Invalid or blocked server URL" });
  }
  const config = { server: trimTrailingSlashes(server), username, password };
  const [cats, account] = await Promise.all([
    xtream.getLiveCategories(config),
    xtream.getAccountInfo(config).catch(() => null), // no account info = can't check it, not a failure
  ]);
  const failure = xtreamTestProblem(cats, account);
  if (failure) {
    countCode("providerErrors", "test (xtream)", failure[0]);
    return res.json({ ok: false, error: failure[1] });
  }
  res.json({
    ok: true,
    message: `Connected! Found ${cats.length} live categories.`,
    account: formatAccountInfo(account),
    // Lets the configure page fill the category picker without a second request
    categories: cats.map(c => ({ category_id: c.category_id, category_name: c.category_name || "" })),
  });
}

// Test Connection, M3U: playlist groups with channel counts
async function testM3u(m3uUrl, res) {
  if (!m3uUrl) {
    return res.status(400).json({ ok: false, error: "Missing M3U URL" });
  }
  if (PLACEHOLDER_RE.test(m3uUrl)) {
    return res.status(400).json({ ok: false, error: PLACEHOLDER_HINT });
  }
  if (!(await validateExternalUrl(m3uUrl))) {
    return res.status(400).json({ ok: false, error: "Invalid or blocked M3U URL" });
  }
  // Group counts only (no channel list in memory); shared with /api/m3u-groups,
  // so test + group picker cost one download
  const groups = await once(`groups:${m3uUrl}`, () => withDownloadSlot(() => m3u.parseM3UGroups(m3uUrl)));
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  if (total === 0) {
    const { kind, message } = whyNoLiveChannels(groups.shape);
    countCode("providerErrors", "test (m3u)", kind);
    return res.json({ ok: false, error: message });
  }
  res.json({ ok: true, message: `Connected! Found ${total} channels.`, groups });
}

// A failed Test Connection: counted, listed (address shape only) and explained
function answerTestFailure(body, res, e) {
  const key = providerErrorKey(e);
  const source = body.type === "xtream" ? "xtream" : "m3u";
  countCode("providerErrors", `test (${source})`, key);
  // What kind of address failed (host/path/query hidden) — e.g. to tell a
  // wrong port from a path pasted into the Xtream server field
  const entered = source === "xtream"
    ? normalizeXtreamLogin(body.server, body.username, body.password).server
    : body.m3uUrl;
  noteRecent(recentTestFailures, { source, error: key, address: addressShape(entered) });
  // "Use http:// instead of https://" only helps if the address IS https://;
  // an http:// address can hit this too (provider redirects to https on a
  // port without a certificate)
  const sslOnHttp = key === "https_mismatch" && !/^https:/i.test(String(entered || ""));
  const hint = sslOnHttp
    ? "Your provider's server had a secure-connection (SSL) problem. Try again later, or check the address with your provider"
    : TEST_ERROR_HINTS[key];
  res.json({ ok: false, error: hint || safeError(e) });
}

app.post("/api/test", limitProviderChecks, async (req, res) => {
  const body = req.body || {};
  try {
    if (body.type === "xtream") return await testXtream(body, res);
    if (body.type === "m3u") return await testM3u(body.m3uUrl, res);
    res.status(400).json({ ok: false, error: "Unknown source type" });
  } catch (e) {
    answerTestFailure(body, res, e);
  }
});

/**
 * Generate a poster URL with the channel name as visible text (PNG).
 * Uses ui-avatars.com — a free service that generates text-based images.
 */
function makePosterUrl(name) {
  // Cut by whole characters: substring(0, 30) could split an emoji in half, and
  // encodeURIComponent then threw "URI malformed", failing the whole catalog page.
  // toWellFormed() also repairs broken characters coming from a provider.
  const text = encodeURIComponent(Array.from(String(name).toWellFormed()).slice(0, 30).join(""));
  return `https://ui-avatars.com/api/?name=${text}&size=300&background=1e1e3a&color=ffffff&font-size=0.28&bold=true&length=30`;
}

/**
 * Channel logo as a square image with the whole logo visible.
 * Stremio fills square tiles by cropping, which cuts off most wide TV logos, so
 * wsrv.nl (a free image service) fits the logo into a 256×256 transparent square.
 * It also serves http logos over https. The server does no image work itself.
 * `fallback` is shown instead when the provider's logo link is dead.
 */
function squareLogo(logo, fallback) {
  if (!/^https?:\/\//i.test(logo || "")) return "";
  return `https://wsrv.nl/?url=${encodeURIComponent(logo.toWellFormed())}&w=256&h=256&fit=contain&cbg=transparent&output=png` +
    `&default=${encodeURIComponent(fallback)}`;
}

// Poster for a channel: its logo fitted into a square, or a generated name tile
function channelPoster(logo, name) {
  const nameTile = makePosterUrl(name);
  return squareLogo(logo, nameTile) || nameTile;
}

// Channel order: picked categories in the order the user picked them (configure
// page chips; Xtream `c` ids / M3U `g` names), otherwise categories A–Z; channels
// A–Z inside each; channels without a category (or M3U's "Uncategorized", unless
// picked) last. Any script (Latin, Cyrillic, Greek…), case and accents ignored,
// numbers in names compared as numbers ("Sport 2" before "Sport 10"). Done once
// per cache load, never per request. The genre dropdown follows the same order.
const nameOrder = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function sortCategory(meta) {
  return meta.genres?.[0] || "";
}

// Real categories A–Z, then the channels without one
function compareByName(a, b) {
  const ca = a === "Uncategorized" ? "" : a;
  const cb = b === "Uncategorized" ? "" : b;
  if (ca === cb) return 0;
  if (!ca || !cb) return ca ? -1 : 1;
  return nameOrder.compare(ca, cb);
}

// Picked categories first, in pick order; the rest by name
function compareCategories(a, b, rank) {
  const ra = rank.get(a) ?? Infinity;
  const rb = rank.get(b) ?? Infinity;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return compareByName(a, b);
}

// Names are compared as search sees them (normalizeForSearch: case, accents,
// punctuation and odd/leading spaces ignored, Cyrillic transliterated by sound),
// so a provider's hidden characters don't move a channel. Quality tags don't count
// either: "BTV", "BTV HD", "BTV UHD" stay together (before "BTV ACTION"); same
// base name → lower quality first. Tags match any case, also inside () or [].
const QUALITY_TAGS = new Map([
  ["sd", 1], ["lq", 1], ["hq", 2], ["hd", 2], ["720p", 2], ["fhd", 3], ["1080p", 3], ["1080i", 3],
  ["uhd", 4], ["4k", 4], ["2160p", 4], ["8k", 5],
  ["hevc", 0], ["h265", 0], ["h264", 0], ["50fps", 0], ["60fps", 0],
]);

// "[BG] BTV (UHD)" → { base: "bg btv", quality: 4 }
function nameKey(name) {
  const normalized = normalizeForSearch(name || "");
  const kept = [];
  let quality = 0;
  for (const word of normalized.split(" ")) {
    const tag = QUALITY_TAGS.get(word);
    if (tag === undefined) kept.push(word);
    else quality = Math.max(quality, tag);
  }
  // A trailing "TV" doesn't count either: "NOVA TV" sorts with "NOVA", not after
  // "NOVA SPORT" ("BTV", "TVN", "TV 1000" keep theirs)
  if (kept.length > 1 && kept.at(-1) === "tv") kept.pop();
  return { base: kept.join(" ") || normalized, quality };
}

function compareChannels(a, b) {
  return nameOrder.compare(a.base, b.base) || a.quality - b.quality || nameOrder.compare(a.meta.name, b.meta.name);
}

// Keys computed once per channel (not per comparison), then written back in order
function sortChannels(metas, picked = []) {
  const rank = new Map(picked.map((name, i) => [name, i]));
  const keyed = metas.map(meta => ({ meta, category: sortCategory(meta), ...nameKey(meta.name) }));
  keyed.sort((a, b) => compareCategories(a.category, b.category, rank) || compareChannels(a, b));
  keyed.forEach((k, i) => { metas[i] = k.meta; });
  return metas;
}

// Catalog channel { id, type, name, logo, genres? } → what Stremio gets. Called
// only for the channels actually sent (one page), so the long poster links are
// never built for a whole 10k-channel list or kept in the caches.
function catalogMeta({ logo, ...item }) {
  return { ...item, poster: channelPoster(logo, item.name), posterShape: "square" };
}

// --- Routes ---

// Root manifest (no config yet) — Stremio reads this to show config UI
app.get("/manifest.json", limitAddon, (req, res) => {
  res.json(BASE_MANIFEST);
});

// Configured manifest (user completed install)
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
  const today = new Date().toISOString().slice(0, 10);
  if (!stats.dailyActive[today]) stats.dailyActive[today] = new Set();
  stats.dailyActive[today].add(user);
  console.log(`[INSTALL] ${maskIp(ip)} ${isNew ? 'NEW install' : 'existing user'} — type: ${cType}`);
  const genres = await getGenresWithin(req.userConfig, req.configKey, GENRES_TIMEOUT_MS);
  res.json(configuredManifest(genres, cType));
});

// --- Category filter: the user's own groups become the catalog's "genre" options ---
const GENRES_TIMEOUT_MS = 8000;      // manifest must stay fast; fall back to no filter
const GENRES_CACHE_TTL = 6 * 60 * 60 * 1000;
const GENRES_CACHE_MAX = 500;
const MAX_GENRE_OPTIONS = 300;
const genresCache = new Map();       // config path -> { data: [names], ts }

function configuredManifest(genres, type) {
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
    catalogs: BASE_MANIFEST.catalogs.map(c => ({ ...c, extra })),
    behaviorHints: { configurable: true },
  };
}

async function getGenres(config, cacheKey) {
  const cached = genresCache.get(cacheKey);
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

// The promise's value, or `fallback` if it fails or takes longer than `ms`
async function withinMs(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([promise.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
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
  // Daily active users (last 7 days)
  const last7 = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    last7[key] = stats.dailyActive[key] ? stats.dailyActive[key].size : 0;
  }
  const mem = process.memoryUsage();
  const avgStreamsPerUser = stats.users.size > 0 ? +(stats.streams / stats.users.size).toFixed(1) : 0;
  res.json({
    addon: "StreamVault IPTV",
    installs: stats.installs,
    uniqueUsers: stats.users.size,
    configures: stats.configures,
    streamsPlayed: stats.streams,
    streamsByType: stats.streamsByType,
    searches: stats.searches,
    configType: stats.configType,
    installsByType: stats.installsByType,
    avgStreamsPerUser,
    dailyActiveUsers: last7,
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
      downloadsRunning: `${downloadsRunning}/${MAX_PARALLEL_DOWNLOADS}`,
      downloadsWaiting: downloadQueue.length,
      // providers that failed in the last 2 min and are not being retried yet
      failedProviders: [...failCache.values()].filter(f => f.until > Date.now()).length,
    },
    // Newest first; dau is live for recent days, frozen in the row for older ones
    history: Object.keys(stats.history).sort((a, b) => b.localeCompare(a)).map(date => {
      const live = stats.dailyActive[date];
      return { date, ...stats.history[date], dau: live ? live.size : (stats.history[date].dau || 0) };
    }),
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
  // Play on the setup tile opens the setup page in the browser — on a phone
  // the QR can't be scanned, so this is the way through
  const streams = req.params.id === "iptv_notice_setup"
    ? [{ name: "StreamVault", title: "Open setup page", externalUrl: `${SETUP_URL}?via=play` }]
    : [];
  serveUnconfigured(req, res, { streams });
});

// --- Search matching ---
// "La Vie Rêve" = "la vie reve", "БНТ 1" = "bnt 1", "Nova-Sport" = "nova sport".
// Cyrillic (Bulgarian/Serbian/Macedonian/Russian/Ukrainian) is written in Latin
// letters so either alphabet finds the channel.
const CYRILLIC_TO_LATIN = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", к: "k",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya",
  ы: "y", э: "e", є: "e", і: "i", ђ: "dj", ј: "j", љ: "lj", њ: "nj", ћ: "c",
  џ: "dz", ѕ: "dz",
};
// Latin letters that don't split into base letter + accent
const LATIN_EXTRA = { ß: "ss", đ: "d", ł: "l", ø: "o", æ: "ae", œ: "oe", ı: "i", þ: "th" };

function normalizeForSearch(text) {
  let s = String(text).toLowerCase();
  // Plain ASCII (most names and searches) skips the slow path
  if (/[^\x00-\x7f]/.test(s)) {
    s = s.normalize("NFKD").replace(/\p{M}/gu, ""); // ê → e, й → и, ё → е
    s = s.replace(/[Ѐ-ӿß-þđıłœ]/g, ch => CYRILLIC_TO_LATIN[ch] ?? LATIN_EXTRA[ch] ?? ch);
  }
  return s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

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

    let metas = [];
    let notice = null; // tile shown first (account problem / expiry)

    if (config.type === "xtream") {
      ({ metas, notice } = await xtreamCatalogAndNotice(config, type, skip, Boolean(extra.search?.trim())));
    } else if (config.type === "m3u") {
      metas = await getM3UCatalog(config, type);
    }

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

// Xtream channels plus the tile to show first (account problem / expiry), if any
async function xtreamCatalogAndNotice(config, type, skip, searching) {
  // First page (no search): account read alongside the channels for the expiry
  // notice; never waits more than a few seconds
  const accountPromise = skip === 0 && !searching
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

// --- Error tiles: tell the user why their catalog is empty ---
const NOTICES = {
  provider_down: {
    name: "Provider not responding",
    description: "Your IPTV provider's server returned an error or didn't respond. This is usually temporary — try again in a few minutes.",
  },
  provider_refused: {
    name: "Provider refused access",
    description: "Your IPTV provider refused the connection. Check that your subscription is active and your login is correct. If it keeps happening, contact your provider.",
  },
  not_found: {
    name: "Playlist not found",
    description: "Your provider says this playlist or server address doesn't exist. Open Stremio's Addons page, click Configure on StreamVault and check the address.",
  },
  bad_address: {
    name: "Address doesn't work",
    description: "The server or playlist address in your setup can't be reached. Open Stremio's Addons page, click Configure on StreamVault and check the address.",
  },
  https_mismatch: {
    name: "Use http:// not https://",
    description: "Your server address starts with https://, but your provider's server only works with http:// on that port. Open Stremio's Addons page, click Configure on StreamVault and change the address to start with http://.",
  },
  provider_limited: {
    name: "Provider is limiting requests",
    description: "Your IPTV provider is temporarily refusing requests because too many were made. Try again in a few minutes.",
  },
  account: {
    name: "Account problem",
    description: "", // filled with the specific reason (expired, wrong login, ...)
  },
  setup: {
    name: "Set up StreamVault first",
    // First line is what shows before "Show more", so it's the action
    description: "On this phone: tap Play to set up. On a TV: scan the code with your phone, or open https://streamvault.fly.dev/setup. Then Sync addons (Stremio) or add the new link (other apps), and delete this empty StreamVault.",
  },
  unknown: {
    name: "Couldn't load channels",
    description: "Something went wrong loading your channels. Try again later, or click Configure on StreamVault in Stremio's Addons page to check your details.",
  },
};

function classifyError(e) {
  const key = providerErrorKey(e);
  const status = Number(key);
  if (status === 401 || status === 403) return "provider_refused";
  if (status === 404) return "not_found";
  if (status === 429) return "provider_limited";
  if (status >= 500) return "provider_down";
  if (key === "https_mismatch") return "https_mismatch";
  if (key === "bad_address") return "bad_address";
  if (key === "timeout") return "provider_down";
  return "unknown";
}

const SETUP_URL = "https://streamvault.fly.dev/setup";
// ?v= changes when the picture does (/public is cached for 7 days)
const SETUP_QR_URL = "https://streamvault.fly.dev/public/img/setup-qr.png?v=2";
// Wide detail-page background: QR on the right, left kept dark for the app's
// title/description overlay (without it apps stretch the square tile behind
// the text, half-covering the code)
const SETUP_BG_URL = "https://streamvault.fly.dev/public/img/setup-bg.png?v=3";

function noticeMeta(kind, type, detail) {
  const notice = NOTICES[kind] || NOTICES.unknown;
  const name = kind === "account" && detail ? detail : notice.name;
  const description = kind === "account"
    ? `${detail || "There is a problem with your IPTV account"}. Renew or check your subscription with your provider, then reopen Stremio.`
    : notice.description;
  return {
    id: `iptv_notice_${kind}`,
    type: type || "tv",
    name: `⚠️ ${name}`,
    // The setup tile's picture is a QR code to /setup, so a TV user can finish
    // setting up on their phone
    poster: kind === "setup" ? SETUP_QR_URL : makePosterUrl(name),
    posterShape: "square",
    description,
    ...(kind === "setup" && {
      background: SETUP_BG_URL,
      // A tappable button on the detail page in apps that show meta links
      links: [{ name: "Set up StreamVault", category: "Setup", url: `${SETUP_URL}?via=link` }],
    }),
  };
}

// First tile of the catalog when the account can't be used (expired/disabled
// while the panel still lists channels) or ends within EXPIRY_WARN_DAYS
const EXPIRY_WARN_DAYS = 7;
const ACCOUNT_WAIT_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
function accountNotice(info, type) {
  const problem = accountProblem(info);
  if (problem) return noticeMeta("account", type, problem);
  const exp = Number(info?.exp_date) * 1000;
  const left = exp - Date.now();
  if (!(left > 0 && left <= EXPIRY_WARN_DAYS * DAY_MS)) return null;
  const when = left < DAY_MS ? "in less than a day" : `in ${Math.ceil(left / DAY_MS)} days`;
  const date = new Date(exp).toISOString().slice(0, 10);
  return {
    id: "iptv_notice_expiring",
    type: type || "tv",
    name: `⚠️ Subscription ends ${when}`,
    poster: makePosterUrl(`Subscription ends ${when}`),
    posterShape: "square",
    description: `Your IPTV subscription ends on ${date} (UTC). Renew it with your provider to keep watching. `
      + "After renewing, this notice disappears within 30 minutes.",
  };
}

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
      streams = await getXtreamStreams(config, type, id, baseUrl, req.params.config);
    } else if (config.type === "m3u") {
      streams = await getM3UStreams(config, id);
    }

    stats.streams++;
    countToday("streams");
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

// --- Xtream Codes handlers ---

function xtreamCacheKey(config, type, categoryIds) {
  return `${config.server}_${config.username}_${type}_${categoryIds.join(",")}`;
}

function xtreamCategoryIds(config) {
  return (config.country || "").split(",").filter(Boolean);
}

async function getXtreamCatalog(config, type) {
  // Only live TV channels are supported
  if (type !== "tv") return [];

  const categoryIds = xtreamCategoryIds(config);
  const cacheKey = xtreamCacheKey(config, type, categoryIds);
  const load = () => once(`xtream:${cacheKey}`, () =>
    withFailureCache(`xtream:${cacheKey}`, () => loadXtreamCatalog(config, type, categoryIds, cacheKey)));
  const cached = usableEntry(xtreamCache.get(cacheKey), XTREAM_CACHE_TTL, XTREAM_STALE_MS, load);
  return cached ? cached.data : load();
}

async function loadXtreamCatalog(config, type, categoryIds, cacheKey) {
  // Category names (for the genre filter) are fetched alongside; failure just means no genres
  const categoriesPromise = xtream.getLiveCategories(config).catch(() => []);
  // One download slot per catalog load (a user's selected categories together)
  let items = await withDownloadSlot(async () => {
    if (categoryIds.length === 0) return xtream.getLiveStreams(config);
    const results = await Promise.all(categoryIds.map(catId => xtream.getLiveStreams(config, catId)));
    return results.filter(Array.isArray).flat();
  });
  const categories = await categoriesPromise;

  // Guard: API may return an object/error instead of an array
  if (!Array.isArray(items)) items = [];

  const categoryNames = new Map(
    (Array.isArray(categories) ? categories : []).map(c => [String(c.category_id), c.category_name])
  );

  const result = items.map((item) => {
    const name = item.name || item.title || "Unknown";
    const logo = item.stream_icon || item.cover || "";
    const category = categoryNames.get(String(item.category_id));
    // Cached as the raw logo; the (much longer) poster link is built only for the
    // channels actually sent — see catalogMeta() — so the cache stays small
    const meta = {
      id: `iptv_${type}_${item.stream_id}`,
      type: type,
      name: name,
      logo,
    };
    if (category) meta.genres = [category];
    return meta;
  });
  sortChannels(result, categoryIds.map(id => categoryNames.get(id)).filter(Boolean));

  setCapped(xtreamCache, cacheKey, { data: result, ts: Date.now() }, XTREAM_CACHE_MAX);
  return result;
}

// "HH:MM - HH:MM" in the viewer's timezone (captured by the configure page).
// Older installs have no timezone → fall back to the provider's local strings.
function epgTimeRange(e, timezone) {
  const startTs = Number(e.start_timestamp);
  const endTs = Number(e.stop_timestamp || e.end_timestamp);
  if (!timezone || !startTs || !endTs) return providerTimeRange(e);
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone });
    return `${fmt.format(startTs * 1000)} - ${fmt.format(endTs * 1000)}`;
  } catch (_) {
    return providerTimeRange(e); // invalid timezone: use the provider's own times
  }
}

// "HH:MM - HH:MM" as the provider wrote it (its local time)
function providerTimeRange(e) {
  const start = e.start || "";
  const end = e.end || "";
  return start && end ? `${start.slice(11, 16)} - ${end.slice(11, 16)}` : "";
}

// Account info (expiry) for channel pages and the expiry notice — tiny request
const accountCache = new Map();
async function getXtreamAccount(config) {
  const key = `${config.server}_${config.username}`;
  const entry = accountCache.get(key);
  const load = () => once(`account:${key}`, async () => {
    const info = await xtream.getAccountInfo(config).catch(() => null);
    setCapped(accountCache, key, { data: info, ts: Date.now() }, XTREAM_CACHE_MAX);
    return info;
  });
  const ttl = entry?.data ? ACCOUNT_CACHE_TTL : ACCOUNT_RETRY_MS;
  const cached = usableEntry(entry, ttl, ACCOUNT_STALE_MS, load);
  return cached ? cached.data : load();
}

// "Save changes" on the configure page: forget this setup's cached channel list
// (and Xtream account, and a remembered provider failure) so the next request
// downloads them fresh — new channels show at once instead of after the TTL.
// At most once per FORCED_REFRESH_MS per setup: each reload is a full download.
const FORCED_REFRESH_MS = 2 * 60 * 1000;
const forcedRefreshes = new Map(); // cache key -> last forced refresh (ms)
function forceRefresh(config) {
  const key = config.type === "xtream"
    ? xtreamCacheKey(config, "tv", xtreamCategoryIds(config))
    : m3uCacheKey(config);
  const last = forcedRefreshes.get(key);
  if (!key || (last && Date.now() - last < FORCED_REFRESH_MS)) return false;
  forcedRefreshes.delete(key); // re-insert: newest last for setCapped
  setCapped(forcedRefreshes, key, Date.now(), 1000);
  if (config.type === "xtream") {
    xtreamCache.delete(key);
    failCache.delete(`xtream:${key}`);
    accountCache.delete(`${config.server}_${config.username}`);
  } else {
    m3uCache.delete(key);
    failCache.delete(`m3u:${key}`);
  }
  return true;
}

// TV guide listings for one channel (see EPG_CACHE_TTL); failures aren't kept
async function getCachedEPG(config, streamId) {
  const key = `${trimTrailingSlashes(config.server)}_${streamId}`;
  const cached = epgCache.get(key);
  if (cached && Date.now() - cached.ts < EPG_CACHE_TTL) return cached.data;
  return once(`epg:${key}`, async () => {
    const data = await xtream.getShortEPG(config, streamId);
    setCapped(epgCache, key, { data, ts: Date.now() }, EPG_CACHE_MAX);
    return data;
  });
}

// "🗓 Subscription expires 2026-12-01" for the channel page, or "" when unknown
function subscriptionLine(info) {
  if (!info || typeof info !== "object") return "";
  const status = String(info.status || "").trim().toLowerCase();
  if (status !== "" && status !== "active") return `⚠️ Your IPTV account is ${status.slice(0, 20)}`;
  const exp = Number(info.exp_date);
  if (!Number.isFinite(exp) || exp <= 0) return ""; // missing/invalid date → nothing to show
  const date = new Date(exp * 1000).toISOString().slice(0, 10);
  return exp * 1000 < Date.now() ? `⚠️ Subscription expired on ${date}` : `🗓 Subscription expires ${date}`;
}

async function getXtreamMeta(config, type, id) {
  // Only live TV channels are supported
  if (type !== "tv") return null;

  const streamId = id.replace(`iptv_${type}_`, "");

  // Look up actual channel name from cached catalog
  const catalog = await getXtreamCatalog(config, type);
  const item = catalog.find(m => m.id === id);

  const name = item ? item.name : `Stream ${streamId}`;
  const poster = item ? channelPoster(item.logo, item.name) : makePosterUrl(name);
  let description = "📺 Live Channel — StreamVault IPTV";

  // Subscription expiry (cached; fetched alongside the EPG)
  const accountPromise = getXtreamAccount(config);

  // Fetch EPG for live channels
  try {
    const epg = await getCachedEPG(config, streamId);
    if (epg?.length > 0) {
      const lines = epg.map(e => {
        const title = e.title ? Buffer.from(e.title, "base64").toString("utf-8") : "";
        const desc = e.description ? Buffer.from(e.description, "base64").toString("utf-8") : "";
        const time = epgTimeRange(e, config.timezone);
        return `${time ? time + " " : ""}${title}${desc ? "\n  " + desc : ""}`;
      });
      description = "📺 TV Guide:\n" + lines.join("\n");
    }
  } catch (_) {
    // No TV guide from the provider: the channel page just shows no guide
  }

  const subscription = subscriptionLine(await accountPromise);
  if (subscription) description += `\n\n${subscription}`;

  // Not in the (just loaded) catalog → the provider doesn't list it in the
  // user's categories; refetching the full stream list would only spike memory
  const meta = { id, type, name, poster, posterShape: "square", description };
  if (item?.genres) meta.genres = item.genres;
  return meta;
}

async function getXtreamStreams(config, type, id, baseUrl, configPath) {
  // Only live TV channels are supported
  if (type !== "tv") return [];

  // id format: iptv_tv_<streamId>
  const streamId = id.replace(`iptv_${type}_`, "");
  const server = trimTrailingSlashes(config.server);

  // Look up channel name from catalog
  let channelName = "";
  try {
    const catalog = await getXtreamCatalog(config, type);
    const item = catalog.find(m => m.id === id);
    if (item) channelName = item.name;
  } catch (_) {
    // Catalog unavailable: the stream still plays, titled "Channel <id>"
  }

  // Live TV: notWebReady hints Stremio to prefer external player (VLC/MX)
  const tvName = channelName || `Channel ${streamId}`;
  const safeName = encodeURIComponent(tvName.toWellFormed());
  // Route through /play redirect so VLC shows channel name (last path segment)
  const useRedirect = baseUrl && configPath;
  const tsUrl = useRedirect
    ? `${baseUrl}/play/${configPath}/live/${streamId}/ts/${safeName}`
    : `${server}/live/${config.username}/${config.password}/${streamId}.ts`;
  const hlsUrl = useRedirect
    ? `${baseUrl}/play/${configPath}/live/${streamId}/m3u8/${safeName}`
    : `${server}/live/${config.username}/${config.password}/${streamId}.m3u8`;

  const streams = [
    {
      name: "StreamVault\nTS",
      title: `${tvName}\nMPEG-TS (best for VLC)`,
      url: tsUrl,
      behaviorHints: { notWebReady: true, bingeGroup: "streamvault-live" },
    },
    {
      name: "StreamVault\nHLS",
      title: `${tvName}\nHLS / m3u8 (fallback)`,
      url: hlsUrl,
      behaviorHints: { notWebReady: true, bingeGroup: "streamvault-live" },
    }
  ];

  return streams;
}

// --- M3U handlers ---

// Sorted catalog per cached playlist: built once, dropped with the cache entry
const m3uCatalogs = new WeakMap();
async function getM3UCatalog(config, type) {
  // Only live TV channels are supported
  if (type !== "tv") return [];

  const data = await getCachedM3U(config);
  let catalog = m3uCatalogs.get(data);
  if (!catalog) {
    // Raw logo here; catalogMeta() builds the poster for the page that's sent
    catalog = sortChannels(data.channels.filter((ch) => ch.type === "tv").map((ch) => ({
      id: `iptv_tv_${ch.id}`,
      type: "tv",
      name: ch.name,
      logo: ch.logo,
      genres: [ch.group],
    })), config.groups || []);
    m3uCatalogs.set(data, catalog);
  }
  return catalog;
}

// Channels without a tvg-id get "m3u_<name>_<position in playlist>". When the
// provider adds/removes a channel above it, the position shifts and saved channels
// / "continue watching" pointed at an id that no longer existed. If the exact id
// is gone, fall back to the same name at the nearest position.
function findM3UChannel(channels, channelId) {
  const exact = channels.find((ch) => ch.id === channelId && ch.type === "tv");
  if (exact) return exact;
  // "<tvg-id>_v2/_v3" = a duplicate entry numbered by playlist order; when the
  // provider adds/removes copies the number moves. Fall back to the channel itself.
  const variant = /^(.+)_v\d+$/.exec(channelId);
  if (variant) {
    const base = channels.find((ch) => ch.id === variant[1] && ch.type === "tv");
    if (base) return base;
  }
  const m = /^(m3u_.*_)(\d+)$/.exec(channelId);
  if (!m) return null;
  const [, prefix, oldPos] = m;
  let best = null, bestDist = Infinity;
  for (const ch of channels) {
    if (ch.type !== "tv" || !ch.id.startsWith(prefix)) continue;
    const pos = ch.id.slice(prefix.length);
    if (!/^\d+$/.test(pos)) continue;
    const dist = Math.abs(Number(pos) - Number(oldPos));
    if (dist < bestDist) { best = ch; bestDist = dist; }
  }
  return best;
}

async function getM3UMeta(config, type, id) {
  // Only live TV channels are supported
  if (type !== "tv") return null;

  const { channels } = await getCachedM3U(config);
  const channelId = id.replace(`iptv_${type}_`, "");
  const channel = findM3UChannel(channels, channelId);

  if (!channel) return null;

  return {
    id,
    type,
    name: channel.name,
    poster: channelPoster(channel.logo, channel.name),
    posterShape: "square",
    genres: [channel.group],
    description: `Group: ${channel.group}`,
  };
}

async function getM3UStreams(config, id) {
  const { channels } = await getCachedM3U(config);

  // Extract channel id from the full id (iptv_tv_<channelId>)
  const parts = /^iptv_tv_(.+)$/.exec(id);
  const channelId = parts ? parts[1] : id;

  const channel = findM3UChannel(channels, channelId);

  if (!channel) return [];

  // Other entries sharing this tvg-id are usually quality variants (HD/FHD/UHD)
  // of the same channel — offer them after the one the user picked. A tvg-id
  // shared by many entries is junk (e.g. "0"), so skip variants then.
  let variants = [];
  if (channel.tvgId) {
    variants = channels.filter((ch) => ch.tvgId === channel.tvgId && ch !== channel && ch.type === "tv");
    if (variants.length > MAX_M3U_VARIANTS) variants = [];
  }

  return [channel, ...variants].map(m3uStream);
}

const MAX_M3U_VARIANTS = 5;

function streamFormat(url) {
  const path = url.split("?")[0].toLowerCase();
  if (path.endsWith(".m3u8")) return "HLS";
  if (path.endsWith(".ts")) return "TS";
  return "Live";
}

function m3uStream(ch) {
  const behaviorHints = { notWebReady: true, bingeGroup: "streamvault-live" };
  // Playlist-provided User-Agent/Referer — some providers reject requests without them
  if (ch.headers) behaviorHints.proxyHeaders = { request: ch.headers };
  return {
    name: `StreamVault\n${streamFormat(ch.url)}`,
    title: ch.group ? `${ch.name}\n${ch.group}` : ch.name,
    url: ch.url,
    behaviorHints,
  };
}

// --- Utility ---

/**
 * Parse Stremio extra params string like "skip=100&genre=Action"
 */
function parseExtra(extraStr) {
  const cleaned = extraStr.replace(/\.json$/, "");
  const params = {};
  cleaned.split("&").forEach((pair) => {
    const idx = pair.indexOf("=");
    const key = idx === -1 ? pair : pair.slice(0, idx);
    const val = idx === -1 ? "" : pair.slice(idx + 1);
    if (key) params[safeDecode(key)] = safeDecode(val);
  });
  return params;
}

// A "%" that isn't valid URL encoding (e.g. a category named "100% Sport" sent
// unencoded) made decodeURIComponent throw "URI malformed" and broke the catalog.
// Keep the raw text instead.
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s; // malformed %-encoding: keep the raw text
  }
}

// Some apps (Nuvio on webOS) ask every addon for subtitles, although the
// manifest offers none — with or without settings, sometimes with a mangled
// tail. Answer "no subtitles" at once instead of a 404; counted as foreignRequests.
app.get(/^\/(?:[^/]+\/)?subtitles\//, limitAddon, (req, res) => {
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
app.get(/^\/[0-9a-f]{40}\/\d+\/stats\.json$/i, (req, res) => {
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

// Path for logs/stats with install links hidden: any segment that is a user's
// config ("e-<hex>", base64 "ey...") or just very long becomes "<config>"
function maskPath(p) {
  return p.split("/").map(seg => (/^(e-|ey|s-)/.test(seg) || seg.length > 40 ? "<config>" : seg))
    .join("/").slice(0, 150);
}

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
  cache("link_apps", linkApps.size, LINK_APPS_MAX);
  g("failed_providers", "Providers in the 2-minute failure cache", [...failCache.values()].filter(f => f.until > Date.now()).length);
  g("downloads_running", "Big provider downloads running now", downloadsRunning);
  g("downloads_capacity", "Big provider downloads allowed at once", MAX_PARALLEL_DOWNLOADS);
  g("downloads_waiting", "Big provider downloads waiting for a slot", downloadQueue.length);
  g("inflight_loads", "Shared in-flight loads (once())", inflight.size);
  g("stable_links", "Saved stable install links + edited old links (links.json)", linkStore.size());

  // All-time usage (from stats.json, survives restarts)
  c("installs_total", "Installs (new users) since the start", stats.installs);
  c("configures_total", "Configure page visits since the start", stats.configures);
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
  for (const [counter, value] of Object.entries(row)) {
    if (typeof value === "number" && counter !== "dau") g("today", "Today's (UTC) daily counters, as in /stats history", value, { counter });
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

module.exports = { app, parseConfigPath, parseExtra, makePosterUrl, encryptConfig, decryptConfig, isPrivateIp, validateExternalUrl, safeError, formatAccountInfo, epgTimeRange, saveStats, buildMetricsText };
