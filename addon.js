/**
 * addon.js — Main Stremio IPTV addon entry point.
 *
 * Configuration is done entirely within Stremio's UI.
 * No browser needed — just add the manifest URL in Stremio and configure there.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const xtream = require("./xtream");
const m3u = require("./m3u");

const app = express();
const PORT = process.env.PORT || 7000;

// --- CORS headers (required for Stremio) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

// --- Serve static files (logo, images) ---
app.use("/public", express.static(path.join(__dirname, "public")));

// --- Analytics ---
const STATS_FILE = path.join(__dirname, "stats.json");
let stats = { installs: 0, configures: 0, streams: 0, searches: 0, users: new Set(), startedAt: new Date().toISOString() };

try {
  const saved = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
  stats = { ...saved, users: new Set(saved.users || []) };
} catch (_) {}

function saveStats() {
  const toSave = { ...stats, users: [...stats.users] };
  fs.writeFileSync(STATS_FILE, JSON.stringify(toSave, null, 2));
}

setInterval(saveStats, 60000);
process.on("SIGTERM", saveStats);
process.on("SIGINT", () => { saveStats(); process.exit(0); });

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

// --- Base manifest (unconfigured) — Stremio shows the config form ---
const BASE_MANIFEST = {
  id: "community.streamvault.addon",
  version: "1.0.0",
  name: "StreamVault IPTV",
  description: "Stream IPTV via Xtream Codes or M3U playlist — live TV, VOD & series.",
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

// --- Parse config from URL path segment (supports base64url and legacy URL-encoded) ---
function parseConfigPath(configStr) {
  let params = {};

  // Detect base64url format (no & or = at start, starts with "ey" for JSON base64)
  if (configStr.startsWith("ey") || (!configStr.includes("%3D") && !configStr.includes("sourceType"))) {
    try {
      // Base64url decode
      const base64 = configStr.replace(/-/g, "+").replace(/_/g, "/");
      const json = Buffer.from(base64, "base64").toString("utf-8");
      const obj = JSON.parse(json);
      if (obj.t === "xtream") {
        return { type: "xtream", server: obj.s || "", username: obj.u || "", password: obj.p || "", country: obj.c || "" };
      } else {
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
    req.userConfig = parseConfigPath(req.params.config);
    next();
  } catch (e) {
    res.status(400).json({ error: "Invalid configuration." });
  }
}

// --- Serve configuration page for Stremio ---
app.get("/configure", (req, res) => {
  stats.configures++;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  console.log(`[CONFIGURE] ${ip} opened configure page`);
  res.sendFile(path.join(__dirname, "public", "configure.html"));
});
app.get("/:config/configure", (req, res) => {
  stats.configures++;
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  console.log(`[CONFIGURE] ${ip} opened configure page`);
  res.sendFile(path.join(__dirname, "public", "configure.html"));
});

// --- API: Fetch categories from provider ---
app.use(express.json());
app.post("/api/categories", async (req, res) => {
  try {
    const { server, username, password } = req.body;
    if (!server || !username || !password) {
      return res.status(400).json({ error: "Missing credentials" });
    }
    const config = { server: server.replace(/\/+$/, ""), username, password };
    const [live, vod, series] = await Promise.all([
      xtream.getLiveCategories(config).catch(() => []),
      xtream.getVodCategories(config).catch(() => []),
      xtream.getSeriesCategories(config).catch(() => []),
    ]);
    res.json({ live, vod, series });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const isNew = !stats.users.has(ip);
  if (isNew) {
    stats.users.add(ip);
    stats.installs++;
  }
  console.log(`[INSTALL] ${ip} ${isNew ? 'NEW install' : 'existing user'} — type: ${req.userConfig.type}`);
  const manifest = { ...BASE_MANIFEST, behaviorHints: { configurable: true } };
  res.json(manifest);
});

// --- Stats dashboard ---
app.get("/stats", (req, res) => {
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

    let metas = [];

    if (config.type === "xtream") {
      metas = await getXtreamCatalog(config, type);
    } else if (config.type === "m3u") {
      metas = await getM3UCatalog(config, type, search);
    }

    // Filter by preferred category if set (uses category_id from provider)
    // Note: category filtering is now done at the API level in getXtreamCatalog

    // Filter by search — all words must appear in the name (any order)
    if (search) {
      stats.searches++;
      const words = search.split(/\s+/).filter(w => w.length > 0);
      metas = metas.filter(m => {
        const name = m.name.toLowerCase();
        return words.every(word => name.includes(word));
      });
    }

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
  // Look up actual channel name from cached catalog
  const catalog = await getXtreamCatalog(config, type);
  const item = catalog.find(m => m.id === id);

  if (item) {
    return {
      id,
      type,
      name: item.name,
      poster: item.poster,
      posterShape: "square",
      description: `${type === "tv" ? "Live Channel" : type === "movie" ? "Movie" : "Series"} — StreamVault IPTV`,
    };
  }

  // Fallback: fetch from API if not in cache
  const streamId = id.replace(`iptv_${type}_`, "");
  try {
    let items = [];
    if (type === "tv") items = await xtream.getLiveStreams(config);
    else if (type === "movie") items = await xtream.getVodStreams(config);
    else if (type === "series") items = await xtream.getSeries(config);
    const found = items.find(i => String(i.stream_id || i.series_id) === streamId);
    if (found) {
      const name = found.name || found.title || `Stream ${streamId}`;
      const logo = found.stream_icon || found.cover || "";
      return {
        id, type, name,
        poster: logo || makePosterUrl(name),
        posterShape: "square",
        description: `${type === "tv" ? "Live Channel" : type === "movie" ? "Movie" : "Series"} — StreamVault IPTV`,
      };
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
    // Provide multiple format options for live — auto-retry with fallbacks
    streams.push(
      {
        title: "Live Stream (HLS)",
        url: `${server}/live/${config.username}/${config.password}/${streamId}.m3u8`,
        behaviorHints: { notWebReady: false },
      },
      {
        title: "Live Stream (TS)",
        url: `${server}/live/${config.username}/${config.password}/${streamId}.ts`,
        behaviorHints: { notWebReady: false },
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

async function getM3UCatalog(config, type, search) {
  const { channels } = await getCachedM3U(config.url);

  // Filter by type and search query
  let filtered = channels.filter((ch) => ch.type === type);
  if (search) {
    filtered = filtered.filter((ch) => ch.name.toLowerCase().includes(search));
  }

  return filtered.map((ch) => {
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

  return [
    {
      title: channel.name,
      url: channel.url,
      behaviorHints: { notWebReady: false },
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
app.listen(PORT, () => {
  console.log(`StreamVault IPTV running on port ${PORT}`);
});
