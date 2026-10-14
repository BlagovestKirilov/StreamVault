/**
 * addon.js — Main Stremio IPTV addon entry point.
 *
 * Configuration is done entirely within Stremio's UI.
 * No browser needed — just add the manifest URL in Stremio and configure there.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
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

const { isPrivateIp, validateExternalUrl } = require("./urlguard");

const compression = require("compression");

const app = express();
const PORT = process.env.PORT || 7000;
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
app.use((req, res, next) => {
  res.on("finish", () => {
    if (res.statusCode < 400 || req.path === "/health") return;
    const endpoint = req.route ? `${req.method} ${req.route.path}` : "unknown path";
    countCode("responseErrors", endpoint, String(res.statusCode));
  });
  next();
});

// --- JSON body parser (with size limit) ---
app.use(express.json({ limit: "16kb" }));

// --- Health check for Fly.io (must be unauthenticated for Fly's built-in checks) ---
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// --- Client IP + per-IP limits (see ratelimit.js) ---
const { getIp, rateLimit } = require("./ratelimit");
const MINUTE = 60 * 1000;
const limitProviderChecks = rateLimit("provider-check", 10, MINUTE); // each downloads from the provider
const limitConfig = rateLimit("config", 30, MINUTE);
const limitStats = rateLimit("stats", 5, MINUTE);                    // slows guessing STATS_SECRET
const limitAddon = rateLimit("addon", 300, MINUTE);                  // Stremio bursts + shared IPs

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

// --- Analytics (use /data volume on Fly.io for persistence across deploys) ---
// STATS_DIR env only for tests (a throwaway folder); production uses the /data volume
const STATS_DIR = process.env.STATS_DIR || (fs.existsSync("/data") ? "/data" : __dirname);
const STATS_FILE = path.join(STATS_DIR, "stats.json");
const PROCESS_START = new Date().toISOString();
let stats = {
  installs: 0, configures: 0, streams: 0, searches: 0,
  users: new Set(), startedAt: new Date().toISOString(),
  streamsByType: { tv: 0, movie: 0, series: 0 },
  configType: { xtream: 0, m3u: 0 },
  installsByType: { xtream: 0, m3u: 0 },
  dailyActive: {},  // { "2026-05-31": Set([ips]) }
  history: {},      // { "2026-05-31": { launches, installs, ..., catalogErrors, dau } }
};

try {
  const saved = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
  stats = { ...saved, users: new Set(saved.users || []) };
  if (!stats.streamsByType) stats.streamsByType = { tv: 0, movie: 0, series: 0 };
  if (!stats.configType) stats.configType = { xtream: 0, m3u: 0 };
  if (!stats.installsByType) stats.installsByType = { xtream: 0, m3u: 0 };
  if (!stats.dailyActive) stats.dailyActive = {};
  if (!stats.history) stats.history = {};
  for (const row of Object.values(stats.history)) normalizeErrorMaps(row);
  // Restore daily active Sets
  for (const day of Object.keys(stats.dailyActive)) {
    stats.dailyActive[day] = new Set(stats.dailyActive[day]);
  }
} catch (_) {}

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
  for (const [day, ips] of Object.entries(stats.dailyActive)) {
    if (new Date(day) >= cutoff) dailySerialized[day] = [...ips];
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
const recentErrors = []; // in memory only: newest first, no URLs/credentials

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

// Rows saved before errors were split by endpoint hold flat { "503": 2 } counts
// (only a few minutes on 2026-10-14) — drop those so every row has the
// { where: { code: n } } shape. Runs on every row when stats.json loads
// (function declaration → hoisted). Can be removed once that deploy has run.
function normalizeErrorMaps(row) {
  for (const name of ["providerErrors", "responseErrors"]) {
    const map = row[name];
    if (!map || Object.values(map).some(v => typeof v === "number")) row[name] = {};
    else delete map["(before endpoint tracking)"];
  }
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
  const map = dayRow()[mapName];
  const w = boundedKey(map, where);
  const codes = map[w] || (map[w] = {});
  const c = boundedKey(codes, code);
  codes[c] = (codes[c] || 0) + 1;
}

// Provider failure → HTTP status ("503") or, without one, what went wrong
function providerErrorKey(e) {
  const msg = String((e && e.message) || "");
  const status = (msg.match(/status code (\d{3})/) || [])[1];
  if (status) return status;
  if (/Invalid or blocked URL|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(msg)) return "bad_address";
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return "timeout";
  return "other";
}

// where = "catalog" | "meta" | "stream"
function recordError(where, config, e) {
  countToday(`${where}Errors`);
  countCode("providerErrors", `${where} (${(config && config.type) || "unknown"})`, providerErrorKey(e));
  recentErrors.unshift({
    at: new Date().toISOString(),
    where,
    source: config && config.type,
    error: safeError(e),
  });
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.pop();
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
    .catch(() => {})
    .finally(() => { saving = false; });
}

// On shutdown: sync (the process exits right after) and its own temp file, since an
// async save may be writing stats.json.tmp at this very moment
function saveStatsSync() {
  try {
    const tmp = `${STATS_FILE}.exit.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saveStatsData(), null, 2));
    fs.renameSync(tmp, STATS_FILE);
  } catch (_) {}
}

setInterval(saveStats, 60000);
process.on("SIGTERM", () => { saveStatsSync(); process.exit(0); });
process.on("SIGINT", () => { saveStatsSync(); process.exit(0); });
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  saveStatsSync();
  process.exit(1);
});

// --- In-memory caches ---
const m3uCache = new Map();
const M3U_CACHE_TTL = 10 * 60 * 1000;
const M3U_CACHE_MAX = 3;
const xtreamCache = new Map();
const XTREAM_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
const XTREAM_CACHE_MAX = 25;

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

async function getCachedM3U(config) {
  const groups = config.groups || [];
  // Same playlist with a different group selection is a different (smaller) entry
  const key = groups.length ? `${config.url}\u0001${groups.join("\u0001")}` : config.url;
  const cached = m3uCache.get(key);
  if (cached && Date.now() - cached.ts < M3U_CACHE_TTL) {
    return cached.data;
  }
  return once(`m3u:${key}`, async () => {
    const data = await m3u.parseM3U(config.url, groups);
    setCapped(m3uCache, key, { data, ts: Date.now() }, M3U_CACHE_MAX);
    return data;
  });
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
    return [];
  }
}

// --- Cache eviction (runs every 10 min) ---
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of m3uCache) {
    if (now - val.ts > M3U_CACHE_TTL) m3uCache.delete(key);
  }
  for (const cache of [xtreamCache, accountCache]) {
    for (const [key, val] of cache) {
      if (now - val.ts > XTREAM_CACHE_TTL) cache.delete(key);
    }
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
  description: "Stream live TV via Xtream Codes or M3U playlist. VLC player is required for live TV.",
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
function parseConfigPath(configStr) {
  let params = {};

  // Detect encrypted format: "e-" prefix followed by hex chars (iv + authTag + ciphertext)
  if (configStr.startsWith("e-") && /^e-[0-9a-f]+$/i.test(configStr)) {
    try {
      const obj = decryptConfig(configStr.slice(2));
      if (obj.t === "xtream") {
        return { type: "xtream", server: obj.s || "", username: obj.u || "", password: obj.p || "", country: obj.c || "", timezone: obj.z || "" };
      } else if (obj.t === "m3u") {
        return { type: "m3u", url: obj.m || "", country: obj.c || "", timezone: obj.z || "", groups: parseGroups(obj.g) };
      }
    } catch (e) { /* fall through */ }
  }

  // Detect base64url format: must start with "ey" (base64-encoded JSON "{") and contain only base64url chars
  if (/^ey[A-Za-z0-9_-]+$/.test(configStr)) {
    try {
      // Base64url decode
      const base64 = configStr.replace(/-/g, "+").replace(/_/g, "/");
      const json = Buffer.from(base64, "base64").toString("utf-8");
      const obj = JSON.parse(json);
      if (obj.t === "xtream") {
        return { type: "xtream", server: obj.s || "", username: obj.u || "", password: obj.p || "", country: obj.c || "", timezone: obj.z || "" };
      } else if (obj.t === "m3u") {
        return { type: "m3u", url: obj.m || "", country: obj.c || "", timezone: obj.z || "", groups: parseGroups(obj.g) };
      }
    } catch (e) { /* fall through to legacy parsing */ }
  }

  // Legacy: URL-encoded key=value&key2=value2
  const decoded = decodeURIComponent(configStr);
  decoded.split("&").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx > -1) {
      params[pair.substring(0, idx)] = pair.substring(idx + 1);
    }
  });

  if (params.sourceType === "xtream") {
    return {
      type: "xtream",
      server: decodeURIComponent(params.server || ""),
      username: decodeURIComponent(params.username || ""),
      password: decodeURIComponent(params.password || ""),
      country: decodeURIComponent(params.country || ""),
    };
  } else {
    return {
      type: "m3u",
      url: decodeURIComponent(params.m3uUrl || ""),
      country: decodeURIComponent(params.country || ""),
    };
  }
}

// --- Middleware: extract config from URL path ---
function extractConfig(req, res, next) {
  try {
    const config = parseConfigPath(req.params.config);
    if (config.type === "xtream" && (!config.server || !config.username || !config.password)) {
      return res.status(400).json({ error: "Missing Xtream credentials." });
    }
    if (config.type === "m3u" && !config.url) {
      return res.status(400).json({ error: "Missing M3U URL." });
    }
    req.userConfig = config;
    next();
  } catch (e) {
    res.status(400).json({ error: "Invalid configuration." });
  }
}

// --- Serve configuration page for Stremio ---
app.get("/configure", (req, res) => {
  stats.configures++;
  countToday("configures");
  console.log(`[CONFIGURE] ${getIp(req)} opened configure page`);
  res.sendFile(path.join(__dirname, "public", "configure.html"));
});
app.get("/:config/configure", (req, res) => {
  stats.configures++;
  countToday("configures");
  console.log(`[CONFIGURE] ${getIp(req)} opened configure page`);
  res.sendFile(path.join(__dirname, "public", "configure.html"));
});

// --- API: Fetch categories from provider ---
app.post("/api/categories", limitProviderChecks, async (req, res) => {
  try {
    const { server, username, password } = req.body;
    if (!server || !username || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }
    if (!(await validateExternalUrl(server))) {
      return res.status(400).json({ error: "Invalid or blocked server URL" });
    }
    const config = { server: server.replace(/\/+$/, ""), username, password };
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
    const groups = await once(`groups:${m3uUrl}`, () => m3u.parseM3UGroups(m3uUrl));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// --- API: Encrypt config for secure URL ---
const ALLOWED_CONFIG_KEYS = new Set(["t", "s", "u", "p", "m", "c", "z", "g"]);
app.post("/api/encrypt", limitConfig, (req, res) => {
  try {
    const configObj = req.body;
    if (!configObj || !configObj.t || (configObj.t !== "xtream" && configObj.t !== "m3u")) {
      return res.status(400).json({ error: "Invalid config" });
    }
    // Only allow known fields
    const sanitized = {};
    for (const key of Object.keys(configObj)) {
      if (ALLOWED_CONFIG_KEYS.has(key)) {
        sanitized[key] = String(configObj[key]).slice(0, 2048);
      }
    }
    // A truncated group list would silently fall back to "all groups"
    if (sanitized.g && String(configObj.g).length > 2048) {
      return res.status(400).json({ error: "Too many groups selected — pick fewer" });
    }
    const encrypted = encryptConfig(sanitized);
    res.json({ config: "e-" + encrypted });
  } catch (e) {
    res.status(500).json({ error: "Encryption failed" });
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
  const status = String(info.status || "").trim();
  if (status && status.toLowerCase() !== "active") return `Your account is ${status.toLowerCase().slice(0, 20)}`;
  const exp = Number(info.exp_date);
  if (exp > 0 && exp * 1000 < Date.now()) {
    return `Your account expired on ${new Date(exp * 1000).toISOString().slice(0, 10)}`;
  }
  return null;
}

// --- API: Test connection to provider ---
app.post("/api/test", limitProviderChecks, async (req, res) => {
  try {
    const { type, server, username, password, m3uUrl } = req.body;
    if (type === "xtream") {
      if (!server || !username || !password) {
        return res.status(400).json({ ok: false, error: "Missing credentials" });
      }
      if (!(await validateExternalUrl(server))) {
        return res.status(400).json({ ok: false, error: "Invalid or blocked server URL" });
      }
      const config = { server: server.replace(/\/+$/, ""), username, password };
      const [cats, account] = await Promise.all([
        xtream.getLiveCategories(config),
        xtream.getAccountInfo(config).catch(() => null),
      ]);
      // Many panels answer a bad login with an empty list instead of an error, so
      // the account status is what tells a wrong password / expired account apart
      const problem = accountProblem(account);
      if (problem) {
        countCode("providerErrors", "test (xtream)", "account");
        return res.json({ ok: false, error: problem });
      }
      if (!Array.isArray(cats)) {
        countCode("providerErrors", "test (xtream)", "invalid_response");
        return res.json({ ok: false, error: "Invalid response from server" });
      }
      if (cats.length === 0) {
        countCode("providerErrors", "test (xtream)", "no_channels");
        return res.json({ ok: false, error: "No live channels on this account" });
      }
      res.json({
        ok: true,
        message: `Connected! Found ${cats.length} live categories.`,
        account: formatAccountInfo(account),
        // Lets the configure page fill the category picker without a second request
        categories: cats.map(c => ({ category_id: c.category_id, category_name: c.category_name || "" })),
      });
    } else if (type === "m3u") {
      if (!m3uUrl) {
        return res.status(400).json({ ok: false, error: "Missing M3U URL" });
      }
      if (!(await validateExternalUrl(m3uUrl))) {
        return res.status(400).json({ ok: false, error: "Invalid or blocked M3U URL" });
      }
      // Group counts only (no channel list in memory); shared with /api/m3u-groups,
      // so test + group picker cost one download
      const groups = await once(`groups:${m3uUrl}`, () => m3u.parseM3UGroups(m3uUrl));
      const total = groups.reduce((sum, g) => sum + g.count, 0);
      if (total === 0) {
        countCode("providerErrors", "test (m3u)", "no_channels");
        return res.json({ ok: false, error: "No live channels found in this playlist" });
      }
      res.json({ ok: true, message: `Connected! Found ${total} channels.`, groups });
    } else {
      res.status(400).json({ ok: false, error: "Unknown source type" });
    }
  } catch (e) {
    countCode("providerErrors", `test (${req.body && req.body.type === "xtream" ? "xtream" : "m3u"})`, providerErrorKey(e));
    res.json({ ok: false, error: safeError(e) });
  }
});

/**
 * Generate a poster URL with the channel name as visible text (PNG).
 * Uses ui-avatars.com — a free service that generates text-based images.
 */
function makePosterUrl(name) {
  const text = encodeURIComponent(name.substring(0, 30));
  return `https://ui-avatars.com/api/?name=${text}&size=300&background=1e1e3a&color=ffffff&font-size=0.28&bold=true&length=30`;
}

// --- Routes ---

// Root manifest (no config yet) — Stremio reads this to show config UI
app.get("/manifest.json", limitAddon, (req, res) => {
  res.json(BASE_MANIFEST);
});

// Configured manifest (user completed install)
app.get("/:config/manifest.json", limitAddon, extractConfig, async (req, res) => {
  const ip = getIp(req);
  const isNew = !stats.users.has(ip);
  if (isNew) {
    stats.users.add(ip);
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
  stats.dailyActive[today].add(ip);
  console.log(`[INSTALL] ${ip} ${isNew ? 'NEW install' : 'existing user'} — type: ${cType}`);
  const genres = await getGenresWithin(req.userConfig, req.params.config, GENRES_TIMEOUT_MS);
  res.json(configuredManifest(genres));
});

// --- Category filter: the user's own groups become the catalog's "genre" options ---
const GENRES_TIMEOUT_MS = 8000;      // manifest must stay fast; fall back to no filter
const GENRES_CACHE_TTL = 6 * 60 * 60 * 1000;
const GENRES_CACHE_MAX = 500;
const MAX_GENRE_OPTIONS = 300;
const genresCache = new Map();       // config path -> { data: [names], ts }

function configuredManifest(genres) {
  const extra = [{ name: "search" }];
  // A single group (e.g. everything "Uncategorized") makes a useless dropdown
  if (genres.length > 1) extra.push({ name: "genre", options: genres, isRequired: false });
  extra.push({ name: "skip" });
  return {
    ...BASE_MANIFEST,
    catalogs: BASE_MANIFEST.catalogs.map(c => ({ ...c, extra })),
    behaviorHints: { configurable: true },
  };
}

async function getGenres(config, cacheKey) {
  const cached = genresCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < GENRES_CACHE_TTL) return cached.data;

  // Catalog items carry their group in `genres`; keep provider order, dedupe
  const metas = config.type === "xtream"
    ? await getXtreamCatalog(config, "tv")
    : await getM3UCatalog(config, "tv");
  const names = [...new Set(metas.map(m => m.genres && m.genres[0]).filter(Boolean))]
    .slice(0, MAX_GENRE_OPTIONS);

  setCapped(genresCache, cacheKey, { data: names, ts: Date.now() }, GENRES_CACHE_MAX);
  return names;
}

// Slow/broken provider must not block the manifest — return [] (no filter) instead
async function getGenresWithin(config, cacheKey, ms) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve([]), ms); });
  try {
    return await Promise.race([getGenres(config, cacheKey).catch(() => []), timeout]);
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
      genres: `${genresCache.size}/${GENRES_CACHE_MAX}`,
      inflightDownloads: inflight.size,
    },
    // Newest first; dau is live for recent days, frozen in the row for older ones
    history: Object.keys(stats.history).sort().reverse().map(date => {
      const live = stats.dailyActive[date];
      return { date, ...stats.history[date], dau: live ? live.size : (stats.history[date].dau || 0) };
    }),
    // Since last restart: what failed and where (no URLs or credentials)
    recentErrors,
  });
});

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
    const search = (extra.search || "").toLowerCase();
    const skip = parseInt(extra.skip) || 0;
    const PAGE_SIZE = 100;

    let metas = [];

    if (config.type === "xtream") {
      metas = await getXtreamCatalog(config, type);
      // Expired/disabled accounts often return an empty list rather than an
      // error — say so instead of showing an empty catalog
      if (metas.length === 0 && skip === 0 && type === "tv") {
        const problem = accountProblem(await getXtreamAccount(config));
        if (problem) return res.json({ metas: [noticeMeta("account", type, problem)] });
      }
    } else if (config.type === "m3u") {
      metas = await getM3UCatalog(config, type);
    }

    // Filter by category (Stremio's genre dropdown)
    if (extra.genre) {
      metas = metas.filter(m => m.genres && m.genres[0] === extra.genre);
    }

    // Filter by search — all words must appear in the name (any order)
    if (search) {
      stats.searches++;
      countToday("searches");
      const words = search.split(/\s+/).filter(w => w.length > 0);
      metas = metas.filter(m => {
        const name = m.name.toLowerCase();
        return words.every(word => name.includes(word));
      });
    }

    // Paginate
    metas = metas.slice(skip, skip + PAGE_SIZE);

    res.json({ metas });
  } catch (e) {
    console.error("Catalog error:", e.message);
    recordError("catalog", req.userConfig, e);
    // Instead of an empty catalog, show one tile explaining what went wrong
    // (first page only, so scrolling doesn't repeat it)
    const firstPage = !/(^|&)skip=[1-9]/.test(req.path.split("/").pop() || "");
    res.json({ metas: firstPage ? [noticeMeta(classifyError(e), req.params.type)] : [] });
  }
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
  account: {
    name: "Account problem",
    description: "", // filled with the specific reason (expired, wrong login, ...)
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
  if (status >= 500) return "provider_down";
  if (key === "bad_address") return "bad_address";
  if (key === "timeout") return "provider_down";
  return "unknown";
}

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
    poster: makePosterUrl(name),
    posterShape: "square",
    description,
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
  return noticeMeta(NOTICES[kind] ? kind : "unknown", type);
}

// Meta handler
app.get("/:config/meta/:type/:id.json", limitAddon, extractConfig, async (req, res) => {
  try {
    const config = req.userConfig;
    const { type, id } = req.params;

    if (id.startsWith("iptv_notice_")) {
      return res.json({ meta: await noticeMetaForAccount(config, id, type) });
    }

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
    console.error("Meta error:", e.message);
    recordError("meta", req.userConfig, e);
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

    let streams = [];

    if (config.type === "xtream") {
      const baseUrl = `${req.protocol}://${req.get("host")}`;
      streams = await getXtreamStreams(config, type, id, baseUrl, req.params.config);
    } else if (config.type === "m3u") {
      streams = await getM3UStreams(config, id);
    }

    stats.streams++;
    countToday("streams");
    if (streams.length === 0) countToday("emptyStreams");
    if (stats.streamsByType[type] !== undefined) stats.streamsByType[type]++;
    res.json({ streams });
  } catch (e) {
    console.error("Stream error:", e.message);
    recordError("stream", req.userConfig, e);
    res.json({ streams: [] });
  }
});

// --- Stream redirect (gives VLC a readable title from the URL path) ---
// Only the exact shape getXtreamStreams generates is redirected, so the route
// can't be used as a general-purpose redirector to arbitrary paths/schemes
const PLAY_EXTS = new Set(["ts", "m3u8"]);
app.get("/play/:config/:streamType/:streamId/:ext/:name", limitAddon, extractConfig, async (req, res) => {
  const config = req.userConfig;
  const { streamType, streamId, ext } = req.params;
  if (config.type !== "xtream" || streamType !== "live" || !/^\d+$/.test(streamId) || !PLAY_EXTS.has(ext)) {
    return res.status(400).json({ error: "Invalid stream" });
  }
  if (!(await validateExternalUrl(config.server))) {
    return res.status(400).json({ error: "Invalid or blocked server URL" });
  }
  const server = config.server.replace(/\/+$/, "");
  const url = `${server}/${streamType}/${config.username}/${config.password}/${streamId}.${ext}`;
  res.redirect(302, url);
});

// --- Xtream Codes handlers ---

async function getXtreamCatalog(config, type) {
  // Only live TV channels are supported
  if (type !== "tv") return [];

  const categoryIds = (config.country || "").split(",").filter(Boolean);
  const cacheKey = `${config.server}_${config.username}_${type}_${categoryIds.join(",")}`;
  const cached = xtreamCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < XTREAM_CACHE_TTL) {
    return cached.data;
  }
  return once(`xtream:${cacheKey}`, () => loadXtreamCatalog(config, type, categoryIds, cacheKey));
}

async function loadXtreamCatalog(config, type, categoryIds, cacheKey) {
  // Category names (for the genre filter) are fetched alongside; failure just means no genres
  const categoriesPromise = xtream.getLiveCategories(config).catch(() => []);
  let items = [];
  if (categoryIds.length === 0) {
    items = await xtream.getLiveStreams(config);
  } else {
    const fetches = categoryIds.map(catId => xtream.getLiveStreams(config, catId));
    const results = await Promise.all(fetches);
    items = results.filter(Array.isArray).flat();
  }
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
    const meta = {
      id: `iptv_${type}_${item.stream_id}`,
      type: type,
      name: name,
      poster: logo || makePosterUrl(name),
      posterShape: "square",
    };
    if (category) meta.genres = [category];
    return meta;
  });

  setCapped(xtreamCache, cacheKey, { data: result, ts: Date.now() }, XTREAM_CACHE_MAX);
  return result;
}

// "HH:MM - HH:MM" in the viewer's timezone (captured by the configure page).
// Older installs have no timezone → fall back to the provider's local strings.
function epgTimeRange(e, timezone) {
  const startTs = Number(e.start_timestamp);
  const endTs = Number(e.stop_timestamp || e.end_timestamp);
  if (timezone && startTs && endTs) {
    try {
      const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone });
      return `${fmt.format(startTs * 1000)} - ${fmt.format(endTs * 1000)}`;
    } catch (_) { /* invalid timezone → fallback */ }
  }
  const start = e.start || "";
  const end = e.end || "";
  return start && end ? `${start.slice(11, 16)} - ${end.slice(11, 16)}` : "";
}

// Account info (expiry) shown on channel pages — tiny, cached like the catalog
const accountCache = new Map();
async function getXtreamAccount(config) {
  const key = `${config.server}_${config.username}`;
  const cached = accountCache.get(key);
  if (cached && Date.now() - cached.ts < XTREAM_CACHE_TTL) return cached.data;
  return once(`account:${key}`, async () => {
    const info = await xtream.getAccountInfo(config).catch(() => null);
    setCapped(accountCache, key, { data: info, ts: Date.now() }, XTREAM_CACHE_MAX);
    return info;
  });
}

// "🗓 Subscription expires 2026-12-01" for the channel page, or "" when unknown
function subscriptionLine(info) {
  if (!info || typeof info !== "object") return "";
  const status = String(info.status || "").trim();
  if (status && status.toLowerCase() !== "active") return `⚠️ Your IPTV account is ${status.toLowerCase().slice(0, 20)}`;
  const exp = Number(info.exp_date);
  if (!(exp > 0)) return "";
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
  const poster = item ? item.poster : makePosterUrl(name);
  let description = "📺 Live Channel — StreamVault IPTV";

  // Subscription expiry (cached; fetched alongside the EPG)
  const accountPromise = getXtreamAccount(config);

  // Fetch EPG for live channels
  try {
    const epg = await xtream.getShortEPG(config, streamId);
    if (epg && epg.length > 0) {
      const lines = epg.map(e => {
        const title = e.title ? Buffer.from(e.title, "base64").toString("utf-8") : "";
        const desc = e.description ? Buffer.from(e.description, "base64").toString("utf-8") : "";
        const time = epgTimeRange(e, config.timezone);
        return `${time ? time + " " : ""}${title}${desc ? "\n  " + desc : ""}`;
      });
      description = "📺 TV Guide:\n" + lines.join("\n");
    }
  } catch (_) {}

  const subscription = subscriptionLine(await accountPromise);
  if (subscription) description += `\n\n${subscription}`;

  // Not in the (just loaded) catalog → the provider doesn't list it in the
  // user's categories; refetching the full stream list would only spike memory
  const meta = { id, type, name, poster, posterShape: "square", description };
  if (item && item.genres) meta.genres = item.genres;
  return meta;
}

async function getXtreamStreams(config, type, id, baseUrl, configPath) {
  // Only live TV channels are supported
  if (type !== "tv") return [];

  // id format: iptv_tv_<streamId>
  const streamId = id.replace(`iptv_${type}_`, "");
  const server = config.server.replace(/\/+$/, "");

  // Look up channel name from catalog
  let channelName = "";
  try {
    const catalog = await getXtreamCatalog(config, type);
    const item = catalog.find(m => m.id === id);
    if (item) channelName = item.name;
  } catch (_) {}

  // Live TV: notWebReady hints Stremio to prefer external player (VLC/MX)
  const tvName = channelName || `Channel ${streamId}`;
  const safeName = encodeURIComponent(tvName);
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

async function getM3UCatalog(config, type) {
  // Only live TV channels are supported
  if (type !== "tv") return [];

  const { channels } = await getCachedM3U(config);

  return channels.filter((ch) => ch.type === "tv").map((ch) => {
    return {
      id: `iptv_tv_${ch.id}`,
      type: "tv",
      name: ch.name,
      poster: ch.logo || makePosterUrl(ch.name),
      posterShape: "square",
      genres: [ch.group],
    };
  });
}

async function getM3UMeta(config, type, id) {
  // Only live TV channels are supported
  if (type !== "tv") return null;

  const { channels } = await getCachedM3U(config);
  const channelId = id.replace(`iptv_${type}_`, "");
  const channel = channels.find((ch) => ch.id === channelId && ch.type === "tv");

  if (!channel) return null;

  return {
    id,
    type,
    name: channel.name,
    poster: channel.logo || makePosterUrl(channel.name),
    posterShape: "square",
    genres: [channel.group],
    description: `Group: ${channel.group}`,
  };
}

async function getM3UStreams(config, id) {
  const { channels } = await getCachedM3U(config);

  // Extract channel id from the full id (iptv_tv_<channelId>)
  const parts = id.match(/^iptv_tv_(.+)$/);
  const channelId = parts ? parts[1] : id;

  const channel = channels.find((ch) => ch.id === channelId && ch.type === "tv");

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
    const [key, val] = pair.split("=");
    if (key) params[decodeURIComponent(key)] = decodeURIComponent(val || "");
  });
  return params;
}

// --- Fallback: people opening the site in a browser land on the configure page ---
// ("/" or any unknown page). Unknown API/addon (.json) calls get a JSON 404 instead,
// so Stremio and the configure page still see a real error.
app.use((req, res) => {
  const isApiCall = req.path.startsWith("/api/") || req.path.startsWith("/public/") || req.path.endsWith(".json");
  if (req.method === "GET" && !isApiCall) {
    return res.redirect(302, "/configure");
  }
  res.status(404).json({ error: "Not found" });
});

// --- Start server ---
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`StreamVault IPTV running on 0.0.0.0:${PORT}`);
  });
}

module.exports = { app, parseConfigPath, parseExtra, makePosterUrl, getIp, encryptConfig, decryptConfig, isPrivateIp, validateExternalUrl, safeError, formatAccountInfo, epgTimeRange, saveStats };
