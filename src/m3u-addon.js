/**
 * m3u-addon.js — M3U playlist installs: channel list, channel page and streams
 * (every version of a channel, best quality first).
 */

const { getCachedM3U } = require("./cache");
const {
  channelPoster, nameKey, cleanName, catalogView, channelTitle, sortChannels,
} = require("./catalog");

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

  const catalog = await getM3UCatalog(config, type);
  const item = catalog.find(m => m.id === id);
  const name = cleanName(item ? channelTitle(catalog, item) : channel.name);
  return {
    id,
    type,
    name,
    poster: channelPoster(channel.logo, name),
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

  // The same channel's other versions: same name apart from a quality tag (the
  // merged tile, best first), then entries sharing its tvg-id. A tvg-id shared
  // by many entries is junk (e.g. "0"), so those are skipped then.
  const catalog = await getM3UCatalog(config, "tv");
  const sameName = (catalogView(catalog).versionsById.get(id) || [])
    .map(v => channels.find(ch => `iptv_tv_${ch.id}` === v.id && ch.type === "tv"));
  let sameTvgId = [];
  if (channel.tvgId) {
    sameTvgId = channels.filter((ch) => ch.tvgId === channel.tvgId && ch.type === "tv");
    if (sameTvgId.length > MAX_M3U_VARIANTS + 1) sameTvgId = [];
  }
  const versions = [...new Set([channel, ...sameName, ...sameTvgId].filter(Boolean))];
  // Best quality first (stable: equal quality keeps the order above)
  const quality = (ch) => nameKey(ch.name).quality;
  return versions.toSorted((a, b) => quality(b) - quality(a)).map(m3uStream);
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
    title: ch.group ? `${cleanName(ch.name)}\n${ch.group}` : cleanName(ch.name),
    url: ch.url,
    behaviorHints,
  };
}

module.exports = { getM3UCatalog, getM3UMeta, getM3UStreams };
