/**
 * m3u.js — M3U/M3U8 playlist parser.
 *
 * Streams and parses #EXTINF metadata, filtering to live channels only.
 * Stops after MAX_LIVE_CHANNELS to prevent OOM. No byte-size limit.
 */

const axios = require("axios");
const readline = require("node:readline");
const { assertExternalUrl, blockPrivateRedirects, guardedAgents, PROVIDER_USER_AGENT } = require("./urlguard");

// Memory safety cap on live channels per playlist
const MAX_LIVE_CHANNELS = 10_000;

/**
 * Determine if a URL is a live channel (not VOD).
 */
function isLiveUrl(url) {
  const lower = url.toLowerCase();
  // Xtream-style VOD paths
  if (/\/(movie|series|vod)\//i.test(lower)) return false;
  // File extensions that indicate VOD
  if (/\.(mp4|mkv|avi|mov|wmv|flv|webm)(\?.*)?$/.test(lower)) return false;
  return true;
}

/**
 * Line-by-line M3U parser shared by the string and streaming entry points.
 *
 * - IDs are unique: entries reusing a tvg-id (HD/FHD/UHD variants) get a
 *   "_v2", "_v3" suffix; the first keeps the bare tvg-id so existing library
 *   entries still resolve. `tvgId` is kept so the stream handler can offer
 *   the variants together.
 * - Request headers from #EXTVLCOPT, #EXTHTTP and Kodi-style "url|Header=..."
 *   are attached as `headers` (only when present).
 * - `groups` keeps only those group-titles. IDs are assigned before filtering,
 *   so a channel keeps its id whichever groups the user picked.
 * - `countOnly` stores no channels, just { group -> count } (cheap group listing).
 *
 * @param {Object} opts
 * @param {boolean} opts.liveOnly - drop VOD URLs and label everything "tv"
 * @param {Set<string>} [opts.groups] - keep only these groups
 * @param {boolean} [opts.countOnly] - only count channels per group
 */
function createLineParser({ liveOnly, groups = null, countOnly = false }) {
  const channels = [];
  const categories = {};
  const groupCounts = new Map();
  const idCounts = new Map();
  let pendingMeta = null;
  let pendingHeaders = null;
  let channelIndex = 0;
  // What the file looked like — lets "no live channels" say why (only movies/
  // series, a web page instead of a playlist, or not an M3U at all)
  const shape = { lines: 0, extinf: 0, vod: 0, bareUrls: 0, html: false };

  // "#…" lines: EXTINF starts an entry, EXTVLCOPT/EXTHTTP add request headers
  // for it, anything else (#EXTM3U, comments) is skipped
  function addDirective(line) {
    if (line.startsWith("#EXTINF:")) {
      shape.extinf++;
      pendingMeta = parseExtInf(line);
    } else if (line.startsWith("#EXTVLCOPT:")) {
      pendingHeaders = parseVlcOpt(line, pendingHeaders);
    } else if (line.startsWith("#EXTHTTP:")) {
      pendingHeaders = parseExtHttp(line, pendingHeaders);
    }
  }

  function countGroup(group) {
    if (groupCounts.has(group) || groupCounts.size < MAX_GROUPS) {
      groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
    }
  }

  // Unique id: the first entry keeps the bare tvg-id, later copies get _v2, _v3
  function nextChannelId(meta) {
    const baseId = meta.tvgId || generateId(meta.name, channelIndex);
    const seen = idCounts.get(baseId) || 0;
    idCounts.set(baseId, seen + 1);
    channelIndex++;
    return seen === 0 ? baseId : `${baseId}_v${seen + 1}`;
  }

  function keepChannel(channel, headers) {
    if (headers && Object.keys(headers).length > 0) channel.headers = headers;
    channels.push(channel);
    if (!categories[channel.group]) categories[channel.group] = [];
    categories[channel.group].push(channel);
  }

  // The URL line that follows an EXTINF
  function addEntry(line) {
    const { url, headers: pipeHeaders } = splitPipeHeaders(line);
    const headers = pipeHeaders ? { ...pendingHeaders, ...pipeHeaders } : pendingHeaders;
    const meta = pendingMeta;
    pendingMeta = null;
    pendingHeaders = null;

    // Live filter already ran, so label it "tv" directly. Do NOT use guessType
    // here: it factors in group-title, which would misclassify genuine live
    // channels in groups named e.g. "Movies" and drop them from the catalog.
    if (liveOnly && !isLiveUrl(url)) {
      shape.vod++;
      return;
    }
    const group = meta.groupTitle || "Uncategorized";
    if (countOnly) {
      countGroup(group);
      return;
    }
    // Id assigned before the group filter, so it doesn't depend on the selection
    const id = nextChannelId(meta);
    if (groups && !groups.has(group)) return;

    keepChannel({
      id,
      tvgId: meta.tvgId,
      name: meta.name,
      logo: meta.tvgLogo || "",
      group,
      url,
      type: liveOnly ? "tv" : guessType(url, meta.groupTitle),
    }, headers);
  }

  function addLine(raw) {
    const line = raw.trim();
    if (!line) return;
    shape.lines++;
    if (shape.lines <= 20 && /^<(!doctype|html|head|body)/i.test(line)) shape.html = true;

    if (line.startsWith("#")) {
      addDirective(line);
    } else if (pendingMeta) {
      addEntry(line);
    } else {
      shape.bareUrls++; // a URL with no EXTINF before it
    }
  }

  return { addLine, channels, categories, groupCounts, shape };
}

// Cap on distinct groups reported by parseM3UGroups (the picker stays usable)
const MAX_GROUPS = 3000;

/**
 * Parse raw M3U content string (synchronous, for testing).
 * Does NOT filter by live/VOD — includes all entries.
 * @param {string} content - Raw M3U text
 * @returns {Object} { channels: [...], categories: { groupTitle: [...] } }
 */
function parseM3UContent(content, groups) {
  const parser = createLineParser({ liveOnly: false, groups: groups?.length ? new Set(groups) : null });
  content.split(/\r?\n/).forEach(parser.addLine);
  return { channels: parser.channels, categories: parser.categories };
}

async function fetchPlaylistStream(url) {
  // Playlist URL comes from the user's config — block internal targets
  await assertExternalUrl(url);
  const response = await axios.get(url, {
    timeout: 30000,
    responseType: "stream",
    headers: { "User-Agent": PROVIDER_USER_AGENT },
    beforeRedirect: blockPrivateRedirects,
    ...guardedAgents, // re-checks the address at connect time (DNS rebinding, redirects)
  });
  return response.data;
}

/**
 * List a playlist's live groups with channel counts, without keeping channels
 * in memory (used by the configure page's group picker).
 * @returns {Array<{name: string, count: number}>} in playlist order
 */
async function parseM3UGroups(url) {
  const stream = await fetchPlaylistStream(url);
  return new Promise((resolve, reject) => {
    const parser = createLineParser({ liveOnly: true, countOnly: true });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", parser.addLine);
    rl.on("close", () => {
      const groups = [...parser.groupCounts].map(([name, count]) => ({ name, count }));
      groups.shape = parser.shape; // extra info for the "no live channels" message
      resolve(groups);
    });
    rl.on("error", reject);
    stream.on("error", reject);
  });
}

/**
 * Fetch and stream-parse an M3U playlist from a URL, extracting live channels only.
 * @param {string} url - The M3U playlist URL
 * @param {string[]} [groups] - keep only these group-titles (empty = all)
 * @returns {Object} { channels: [...], categories: { groupTitle: [...] } }
 */
async function parseM3U(url, groups) {
  const stream = await fetchPlaylistStream(url);

  return new Promise((resolve, reject) => {
    const parser = createLineParser({ liveOnly: true, groups: groups?.length ? new Set(groups) : null });
    const { channels, categories } = parser;

    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on("line", (raw) => {
      if (channels.length >= MAX_LIVE_CHANNELS) return;
      parser.addLine(raw);
      // Stop after hitting the cap
      if (channels.length >= MAX_LIVE_CHANNELS) {
        stream.destroy();
        rl.close();
      }
    });

    rl.on("close", () => resolve({ channels, categories }));
    rl.on("error", reject);
    stream.on("error", (err) => {
      if (err.code !== "ERR_STREAM_DESTROYED") reject(err);
      // ERR_STREAM_DESTROYED is expected when we call destroy() after hitting the cap
    });
  });
}

/**
 * Parse a single #EXTINF line to extract metadata.
 * Format: #EXTINF:-1 tvg-id="..." tvg-name="..." tvg-logo="..." group-title="...",Channel Name
 */
function parseExtInf(line) {
  const info = {
    tvgId: "",
    tvgName: "",
    tvgLogo: "",
    groupTitle: "",
    name: "",
  };

  // Extract tvg-id
  const tvgIdMatch = line.match(/tvg-id="([^"]*)"/i);
  if (tvgIdMatch) info.tvgId = tvgIdMatch[1];

  // Extract tvg-name
  const tvgNameMatch = line.match(/tvg-name="([^"]*)"/i);
  if (tvgNameMatch) info.tvgName = tvgNameMatch[1];

  // Extract tvg-logo
  const tvgLogoMatch = line.match(/tvg-logo="([^"]*)"/i);
  if (tvgLogoMatch) info.tvgLogo = tvgLogoMatch[1];

  // Extract group-title
  const groupMatch = line.match(/group-title="([^"]*)"/i);
  if (groupMatch) info.groupTitle = groupMatch[1];

  // Extract channel name (after the last comma)
  const commaIdx = line.lastIndexOf(",");
  if (commaIdx !== -1) {
    info.name = line.substring(commaIdx + 1).trim();
  }

  // Fallback name
  if (!info.name) info.name = info.tvgName || info.tvgId || "Unknown";

  return info;
}

// Header names we pass on to the player; anything else in the playlist is ignored
const VLC_OPT_HEADERS = {
  "http-user-agent": "User-Agent",
  "http-referrer": "Referer",
  "http-referer": "Referer",
  "http-origin": "Origin",
};
const MAX_HEADER_VALUE = 512;

function setHeader(headers, name, value) {
  const v = String(value || "").trim();
  if (!v || v.length > MAX_HEADER_VALUE || /[\r\n]/.test(v)) return headers;
  return { ...headers, [name]: v };
}

/** #EXTVLCOPT:http-user-agent=Mozilla/5.0 */
function parseVlcOpt(line, headers) {
  const opt = line.slice("#EXTVLCOPT:".length);
  const idx = opt.indexOf("=");
  if (idx === -1) return headers;
  const name = VLC_OPT_HEADERS[opt.slice(0, idx).trim().toLowerCase()];
  return name ? setHeader(headers, name, opt.slice(idx + 1)) : headers;
}

/** #EXTHTTP:{"User-Agent":"...","Referer":"..."} */
function parseExtHttp(line, headers) {
  let obj;
  try {
    obj = JSON.parse(line.slice("#EXTHTTP:".length));
  } catch (_) {
    return headers; // malformed JSON: the line adds no headers
  }
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === "string" && /^[A-Za-z0-9-]{1,64}$/.test(k)) headers = setHeader(headers, k, v);
  }
  return headers;
}

// %-decoded text, or the raw text when the encoding is malformed
function decodeOrRaw(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    return value; // malformed %-encoding: keep it as written in the playlist
  }
}

/** Kodi-style "http://host/stream.m3u8|User-Agent=abc&Referer=http://x" */
function splitPipeHeaders(line) {
  const idx = line.indexOf("|");
  if (idx === -1) return { url: line, headers: null };
  let headers = null;
  for (const pair of line.slice(idx + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) continue;
    headers = setHeader(headers, key, decodeOrRaw(pair.slice(eq + 1)));
  }
  return { url: line.slice(0, idx), headers };
}

/**
 * Guess content type from URL extension or group title.
 */
function guessType(url, groupTitle) {
  const lower = url.toLowerCase();
  const groupLower = (groupTitle || "").toLowerCase();

  // VOD indicators
  if (lower.endsWith(".mp4") || lower.endsWith(".mkv") || lower.endsWith(".avi")) {
    return "movie";
  }
  if (groupLower.includes("vod") || groupLower.includes("movie") || groupLower.includes("film")) {
    return "movie";
  }
  if (groupLower.includes("series") || groupLower.includes("episode")) {
    return "series";
  }

  // Default to live TV
  return "tv";
}

/**
 * Generate a unique ID for a channel without tvg-id.
 */
function generateId(name, index) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return `m3u_${slug}_${index}`;
}

module.exports = { parseM3U, parseM3UContent, parseM3UGroups };
