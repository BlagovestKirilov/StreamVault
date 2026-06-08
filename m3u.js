/**
 * m3u.js — M3U/M3U8 playlist parser.
 *
 * Streams and parses #EXTINF metadata, filtering to live channels only.
 * Stops after MAX_LIVE_CHANNELS to prevent OOM. No byte-size limit.
 */

const axios = require("axios");
const readline = require("readline");

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
 * Parse raw M3U content string (synchronous, for testing).
 * Does NOT filter by live/VOD — includes all entries.
 * @param {string} content - Raw M3U text
 * @returns {Object} { channels: [...], categories: { groupTitle: [...] } }
 */
function parseM3UContent(content) {
  const lines = content.split(/\r?\n/);
  const channels = [];
  const categories = {};
  let currentInfo = null;
  let channelIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXTINF:")) {
      currentInfo = parseExtInf(line);
    } else if (line && !line.startsWith("#") && currentInfo) {
      const channel = {
        id: currentInfo.tvgId || generateId(currentInfo.name, channelIndex),
        name: currentInfo.name,
        logo: currentInfo.tvgLogo || "",
        group: currentInfo.groupTitle || "Uncategorized",
        url: line,
        type: guessType(line, currentInfo.groupTitle),
      };

      channels.push(channel);

      if (!categories[channel.group]) {
        categories[channel.group] = [];
      }
      categories[channel.group].push(channel);
      channelIndex++;

      currentInfo = null;
    }
  }

  return { channels, categories };
}

/**
 * Fetch and stream-parse an M3U playlist from a URL, extracting live channels only.
 * @param {string} url - The M3U playlist URL
 * @returns {Object} { channels: [...], categories: { groupTitle: [...] } }
 */
async function parseM3U(url) {
  const response = await axios.get(url, {
    timeout: 30000,
    responseType: "stream",
  });

  return new Promise((resolve, reject) => {
    const channels = [];
    const categories = {};
    let pendingMeta = null;
    let channelIndex = 0;

    const rl = readline.createInterface({ input: response.data, crlfDelay: Infinity });

    rl.on("line", (raw) => {
      const line = raw.trim();

      if (line.startsWith("#EXTINF:")) {
        pendingMeta = parseExtInf(line);
      } else if (pendingMeta && line && !line.startsWith("#")) {
        // URL line following an EXTINF
        if (isLiveUrl(line)) {
          // URL already passed the live filter, so label it "tv" directly.
          // Do NOT use guessType here: it factors in group-title, which would
          // misclassify genuine live channels in groups named e.g. "Movies"
          // and cause them to be dropped by the catalog's tv-only filter.
          const channel = {
            id: pendingMeta.tvgId || generateId(pendingMeta.name, channelIndex),
            name: pendingMeta.name,
            logo: pendingMeta.tvgLogo || "",
            group: pendingMeta.groupTitle || "Uncategorized",
            url: line,
            type: "tv",
          };

          channels.push(channel);

          // Group by category
          if (!categories[channel.group]) {
            categories[channel.group] = [];
          }
          categories[channel.group].push(channel);
          channelIndex++;

          // Stop after hitting the cap
          if (channels.length >= MAX_LIVE_CHANNELS) {
            response.data.destroy();
            rl.close();
          }
        }
        pendingMeta = null;
      }
    });

    rl.on("close", () => resolve({ channels, categories }));
    rl.on("error", reject);
    response.data.on("error", (err) => {
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

module.exports = { parseM3U, parseM3UContent };
