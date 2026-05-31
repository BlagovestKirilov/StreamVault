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

const { URL } = require("url");
const dns = require("dns");
const { promisify } = require("util");
const dnsLookup = promisify(dns.lookup);

const app = express();
const PORT = process.env.PORT || 7000;

// --- CORS headers (required for Stremio) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- JSON body parser (with size limit) ---
app.use(express.json({ limit: "16kb" }));

// --- Health check for Fly.io (must be unauthenticated for Fly's built-in checks) ---
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// --- Helper: extract client IP ---
function getIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

// --- Helper: sanitize error messages (never leak URLs/credentials) ---
function safeError(e) {
  const msg = e.message || "Unknown error";
  if (msg.includes("://")) return "Connection failed";
  if (msg.length > 100) return msg.slice(0, 100);
  return msg;
}

// --- SSRF protection: block private/internal IPs ---
const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^::$/,
];

function isPrivateIp(ip) {
  return PRIVATE_IP_RANGES.some(r => r.test(ip));
}

async function validateExternalUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return false;
  if (urlStr.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname;
  if (isPrivateIp(hostname)) return false;
  if (hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal")) return false;
  try {
    const { address } = await dnsLookup(hostname);
    if (isPrivateIp(address)) return false;
  } catch (_) {
    return false;
  }
  return true;
}

// --- Serve static files (logo, images) ---
app.use("/public", express.static(path.join(__dirname, "public")));

// --- Analytics (use /data volume on Fly.io for persistence across deploys) ---
const STATS_DIR = fs.existsSync("/data") ? "/data" : __dirname;
const STATS_FILE = path.join(STATS_DIR, "stats.json");
let stats = { installs: 0, configures: 0, streams: 0, searches: 0, users: new Set(), startedAt: new Date().toISOString() };

try {
  const saved = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
  stats = { ...saved, users: new Set(saved.users || []) };
} catch (_) {}

const MAX_TRACKED_USERS = 10000;

function saveStatsData() {
  // Cap users Set to prevent unbounded growth
  if (stats.users.size > MAX_TRACKED_USERS) {
    const arr = [...stats.users];
    stats.users = new Set(arr.slice(arr.length - MAX_TRACKED_USERS));
  }
  return { ...stats, users: [...stats.users] };
}

function saveStats() {
  const toSave = saveStatsData();
  fs.promises.writeFile(STATS_FILE, JSON.stringify(toSave, null, 2)).catch(() => {});
}

function saveStatsSync() {
  try {
    const toSave = saveStatsData();
    fs.writeFileSync(STATS_FILE, JSON.stringify(toSave, null, 2));
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
const xtreamCache = new Map();
const XTREAM_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

async function getCachedM3U(url) {
  const cached = m3uCache.get(url);
  if (cached && Date.now() - cached.ts < M3U_CACHE_TTL) {
    return cached.data;
  }
  const data = await m3u.parseM3U(url);
  m3uCache.set(url, { data, ts: Date.now() });
  return data;
}

// --- Cache eviction (runs every 30 min) ---
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of m3uCache) {
    if (now - val.ts > M3U_CACHE_TTL) m3uCache.delete(key);
  }
  for (const [key, val] of xtreamCache) {
    if (now - val.ts > XTREAM_CACHE_TTL) xtreamCache.delete(key);
  }
}, 30 * 60 * 1000);

// --- Base manifest (unconfigured) — Stremio shows the config form ---
const BASE_MANIFEST = {
  id: "community.streamvault.addon",
  version: "1.0.0",
  name: "StreamVault IPTV",
  description: "Stream IPTV via Xtream Codes or M3U playlist — live TV, VOD & series. VLC player is required for live TV.",
  logo: "https://streamvault.fly.dev/public/img/logo.png",
  resources: ["catalog", "meta", "stream"],
  types: ["tv", "movie", "series"],
  idPrefixes: ["iptv_"],
  catalogs: [
    { type: "tv", id: "iptv_live", name: "StreamVault Live", extra: [{ name: "search" }, { name: "skip" }] },
    { type: "movie", id: "iptv_vod", name: "StreamVault VOD", extra: [{ name: "search" }, { name: "skip" }] },
    { type: "series", id: "iptv_series", name: "StreamVault Series", extra: [{ name: "search" }, { name: "skip" }] },
  ],
  // Stremio will show these fields in its own Settings UI
  behaviorHints: {
    configurable: true,
    configurationRequired: true,
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
        return { type: "xtream", server: obj.s || "", username: obj.u || "", password: obj.p || "", country: obj.c || "" };
      } else if (obj.t === "m3u") {
        return { type: "m3u", url: obj.m || "", country: obj.c || "" };
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
        return { type: "xtream", server: obj.s || "", username: obj.u || "", password: obj.p || "", country: obj.c || "" };
      } else if (obj.t === "m3u") {
        return { type: "m3u", url: obj.m || "", country: obj.c || "" };
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
  console.log(`[CONFIGURE] ${getIp(req)} opened configure page`);
  res.sendFile(path.join(__dirname, "public", "configure.html"));
});
app.get("/:config/configure", (req, res) => {
  stats.configures++;
  console.log(`[CONFIGURE] ${getIp(req)} opened configure page`);
  res.sendFile(path.join(__dirname, "public", "configure.html"));
});

// --- API: Fetch categories from provider ---
app.post("/api/categories", async (req, res) => {
  try {
    const { server, username, password } = req.body;
    if (!server || !username || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }
    if (!(await validateExternalUrl(server))) {
      return res.status(400).json({ error: "Invalid or blocked server URL" });
    }
    const config = { server: server.replace(/\/+$/, ""), username, password };
    const [live, vod, series] = await Promise.all([
      xtream.getLiveCategories(config).catch(() => []),
      xtream.getVodCategories(config).catch(() => []),
      xtream.getSeriesCategories(config).catch(() => []),
    ]);
    res.json({ live, vod, series });
  } catch (e) {
    res.status(500).json({ error: safeError(e) });
  }
});

// --- API: Encrypt config for secure URL ---
const ALLOWED_CONFIG_KEYS = new Set(["t", "s", "u", "p", "m", "c"]);
app.post("/api/encrypt", (req, res) => {
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
    const encrypted = encryptConfig(sanitized);
    res.json({ config: "e-" + encrypted });
  } catch (e) {
    res.status(500).json({ error: "Encryption failed" });
  }
});

// --- API: Test connection to provider ---
app.post("/api/test", async (req, res) => {
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
      const cats = await xtream.getLiveCategories(config);
      if (!Array.isArray(cats)) {
        return res.json({ ok: false, error: "Invalid response from server" });
      }
      res.json({ ok: true, message: `Connected! Found ${cats.length} live categories.` });
    } else if (type === "m3u") {
      if (!m3uUrl) {
        return res.status(400).json({ ok: false, error: "Missing M3U URL" });
      }
      if (!(await validateExternalUrl(m3uUrl))) {
        return res.status(400).json({ ok: false, error: "Invalid or blocked M3U URL" });
      }
      const { channels } = await m3u.parseM3U(m3uUrl);
      res.json({ ok: true, message: `Connected! Found ${channels.length} channels.` });
    } else {
      res.status(400).json({ ok: false, error: "Unknown source type" });
    }
  } catch (e) {
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
app.get("/manifest.json", (req, res) => {
  res.json(BASE_MANIFEST);
});

// Configured manifest (user completed install)
app.get("/:config/manifest.json", extractConfig, (req, res) => {
  const ip = getIp(req);
  const isNew = !stats.users.has(ip);
  if (isNew) {
    stats.users.add(ip);
    stats.installs++;
  }
  console.log(`[INSTALL] ${ip} ${isNew ? 'NEW install' : 'existing user'} — type: ${req.userConfig.type}`);
  const manifest = { ...BASE_MANIFEST, behaviorHints: { configurable: true } };
  res.json(manifest);
});

// --- Stats dashboard (protected by STATS_SECRET env var) ---
app.get("/stats", (req, res) => {
  if (STATS_SECRET && req.query.key !== STATS_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const uptime = process.uptime();
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  res.json({
    addon: "StreamVault IPTV",
    installs: stats.installs,
    uniqueUsers: stats.users.size,
    configures: stats.configures,
    streamsPlayed: stats.streams,
    searches: stats.searches,
    uptime: `${h}h ${m}m`,
    startedAt: stats.startedAt,
  });
});

// Catalog handler (with extra params like search=X)
app.get("/:config/catalog/:type/:id/:extra.json", extractConfig, catalogHandler);
// Catalog handler (no extra params)
app.get("/:config/catalog/:type/:id.json", extractConfig, catalogHandler);

async function catalogHandler(req, res) {
  try {
    const config = req.userConfig;
    const { type } = req.params;
    const extra = req.params.extra ? parseExtra(req.params.extra) : {};
    const search = (extra.search || "").toLowerCase();
    const skip = parseInt(extra.skip) || 0;
    const PAGE_SIZE = 100;

    let metas = [];

    if (config.type === "xtream") {
      metas = await getXtreamCatalog(config, type);
    } else if (config.type === "m3u") {
      metas = await getM3UCatalog(config, type);
    }

    // Filter by search — all words must appear in the name (any order)
    if (search) {
      stats.searches++;
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
    res.json({ metas: [] });
  }
}

// Meta handler
app.get("/:config/meta/:type/:id.json", extractConfig, async (req, res) => {
  try {
    const config = req.userConfig;
    const { type, id } = req.params;

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
    res.json({ meta: { id: req.params.id, type: req.params.type, name: "Unknown" } });
  }
});

// Stream handler
app.get("/:config/stream/:type/:id.json", extractConfig, async (req, res) => {
  try {
    const config = req.userConfig;
    const { type, id } = req.params;

    let streams = [];

    if (config.type === "xtream") {
      streams = getXtreamStreams(config, type, id);
    } else if (config.type === "m3u") {
      streams = await getM3UStreams(config, id);
    }

    stats.streams++;
    res.json({ streams });
  } catch (e) {
    console.error("Stream error:", e.message);
    res.json({ streams: [] });
  }
});

// --- Xtream Codes handlers ---

async function getXtreamCatalog(config, type) {
  const categoryIds = (config.country || "").split(",").filter(Boolean);
  const cacheKey = `${config.server}_${config.username}_${type}_${categoryIds.join(",")}`;
  const cached = xtreamCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < XTREAM_CACHE_TTL) {
    return cached.data;
  }

  let items = [];
  if (categoryIds.length === 0) {
    // No filter — get all
    if (type === "tv") items = await xtream.getLiveStreams(config);
    else if (type === "movie") items = await xtream.getVodStreams(config);
    else if (type === "series") items = await xtream.getSeries(config);
  } else {
    // Fetch each selected category in parallel
    const fetches = categoryIds.map(catId => {
      if (type === "tv") return xtream.getLiveStreams(config, catId);
      else if (type === "movie") return xtream.getVodStreams(config, catId);
      else if (type === "series") return xtream.getSeries(config, catId);
      return Promise.resolve([]);
    });
    const results = await Promise.all(fetches);
    items = results.flat();
  }

  const result = items.map((item) => {
    const name = item.name || item.title || "Unknown";
    const logo = item.stream_icon || item.cover || "";
    return {
      id: `iptv_${type}_${item.stream_id || item.series_id}`,
      type: type,
      name: name,
      poster: logo || makePosterUrl(name),
      posterShape: "square",
    };
  });

  xtreamCache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

async function getXtreamMeta(config, type, id) {
  const streamId = id.replace(`iptv_${type}_`, "");

  // Look up actual channel name from cached catalog
  const catalog = await getXtreamCatalog(config, type);
  const item = catalog.find(m => m.id === id);

  let name = item ? item.name : `Stream ${streamId}`;
  let poster = item ? item.poster : makePosterUrl(name);
  let description = `${type === "tv" ? "Live Channel" : type === "movie" ? "Movie" : "Series"} — StreamVault IPTV`;

  // Fetch EPG for live channels
  if (type === "tv") {
    try {
      const epg = await xtream.getShortEPG(config, streamId);
      if (epg && epg.length > 0) {
        const lines = epg.map(e => {
          const title = e.title ? Buffer.from(e.title, "base64").toString("utf-8") : "";
          const desc = e.description ? Buffer.from(e.description, "base64").toString("utf-8") : "";
          const start = e.start || "";
          const end = e.end || "";
          const time = start && end ? `${start.slice(11, 16)} - ${end.slice(11, 16)}` : "";
          return `${time ? time + " " : ""}${title}${desc ? "\n  " + desc : ""}`;
        });
        description = "📺 TV Guide:\n" + lines.join("\n");
      }
    } catch (_) {}
  }

  if (item) {
    return { id, type, name, poster, posterShape: "square", description };
  }

  // Fallback: fetch from API if not in cache
  try {
    let items = [];
    if (type === "tv") items = await xtream.getLiveStreams(config);
    else if (type === "movie") items = await xtream.getVodStreams(config);
    else if (type === "series") items = await xtream.getSeries(config);
    const found = items.find(i => String(i.stream_id || i.series_id) === streamId);
    if (found) {
      name = found.name || found.title || name;
      const logo = found.stream_icon || found.cover || "";
      poster = logo || makePosterUrl(name);
      return { id, type, name, poster, posterShape: "square", description };
    }
  } catch (_) {}

  return {
    id,
    type,
    name: `Stream ${streamId}`,
    poster: makePosterUrl(`Stream ${streamId}`),
    posterShape: "square",
    description: `IPTV ${type} stream`,
  };
}

function getXtreamStreams(config, type, id) {
  // id format: iptv_<type>_<streamId>
  const streamId = id.replace(`iptv_${type}_`, "");
  const server = config.server.replace(/\/+$/, "");

  let streams = [];

  if (type === "tv") {
    // Live TV: notWebReady hints Stremio to prefer external player (VLC/MX)
    streams.push(
      {
        title: "Live Stream (TS)",
        url: `${server}/live/${config.username}/${config.password}/${streamId}.ts`,
        behaviorHints: { notWebReady: true, bingeGroup: "streamvault-live" },
      },
      {
        title: "Live Stream (HLS)",
        url: `${server}/live/${config.username}/${config.password}/${streamId}.m3u8`,
        behaviorHints: { notWebReady: true, bingeGroup: "streamvault-live" },
      }
    );
  } else if (type === "movie") {
    streams.push(
      {
        title: "VOD Stream (MP4)",
        url: `${server}/movie/${config.username}/${config.password}/${streamId}.mp4`,
        behaviorHints: { notWebReady: false },
      },
      {
        title: "VOD Stream (MKV)",
        url: `${server}/movie/${config.username}/${config.password}/${streamId}.mkv`,
        behaviorHints: { notWebReady: false },
      }
    );
  } else if (type === "series") {
    streams.push(
      {
        title: "Series Stream (MKV)",
        url: `${server}/series/${config.username}/${config.password}/${streamId}.mkv`,
        behaviorHints: { notWebReady: false },
      },
      {
        title: "Series Stream (MP4)",
        url: `${server}/series/${config.username}/${config.password}/${streamId}.mp4`,
        behaviorHints: { notWebReady: false },
      }
    );
  }

  return streams;
}

// --- M3U handlers ---

async function getM3UCatalog(config, type) {
  const { channels } = await getCachedM3U(config.url);

  return channels.filter((ch) => ch.type === type).map((ch) => {
    return {
      id: `iptv_${type}_${ch.id}`,
      type: type,
      name: ch.name,
      poster: ch.logo || makePosterUrl(ch.name),
      posterShape: "square",
    };
  });
}

async function getM3UMeta(config, type, id) {
  const { channels } = await getCachedM3U(config.url);
  const channelId = id.replace(`iptv_${type}_`, "");
  const channel = channels.find((ch) => ch.id === channelId);

  if (!channel) return null;

  return {
    id,
    type,
    name: channel.name,
    poster: channel.logo || "",
    posterShape: "square",
    description: `Group: ${channel.group}`,
  };
}

async function getM3UStreams(config, id) {
  const { channels } = await getCachedM3U(config.url);

  // Extract channel id from the full id (iptv_<type>_<channelId>)
  const parts = id.match(/^iptv_(tv|movie|series)_(.+)$/);
  const channelId = parts ? parts[2] : id;

  const channel = channels.find((ch) => ch.id === channelId);

  if (!channel) return [];

  const isLive = channel.type === "tv";
  return [
    {
      title: channel.name,
      url: channel.url,
      behaviorHints: isLive
        ? { notWebReady: true, bingeGroup: "streamvault-live" }
        : { notWebReady: false },
    },
  ];
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

// --- Start server ---
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`StreamVault IPTV running on 0.0.0.0:${PORT}`);
  });
}

module.exports = { app, parseConfigPath, parseExtra, makePosterUrl, getIp, encryptConfig, decryptConfig, isPrivateIp, validateExternalUrl, safeError };
