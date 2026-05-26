/**
 * m3u.js — M3U/M3U8 playlist parser.
 *
 * Parses #EXTINF metadata and groups channels by group-title.
 */

const axios = require("axios");

/**
 * Fetch and parse an M3U playlist from a URL.
 * @param {string} url - The M3U playlist URL
 * @returns {Object} { channels: [...], categories: { groupTitle: [...] } }
 */
async function parseM3U(url) {
  const { data } = await axios.get(url, { timeout: 30000, responseType: "text" });
  return parseM3UContent(data);
}

/**
 * Parse raw M3U content string.
 * @param {string} content - Raw M3U text
 * @returns {Object} { channels: [...], categories: { groupTitle: [...] } }
 */
function parseM3UContent(content) {
  const lines = content.split(/\r?\n/);
  const channels = [];
  const categories = {};

  let currentInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXTINF:")) {
      // Parse the EXTINF line
      currentInfo = parseExtInf(line);
    } else if (line && !line.startsWith("#") && currentInfo) {
      // This is the stream URL line following an EXTINF
      const channel = {
        id: currentInfo.tvgId || generateId(currentInfo.name, i),
        name: currentInfo.name,
        logo: currentInfo.tvgLogo || "",
        group: currentInfo.groupTitle || "Uncategorized",
        url: line,
        // Determine type based on extension or group hints
        type: guessType(line, currentInfo.groupTitle),
      };

      channels.push(channel);

      // Group by category
      if (!categories[channel.group]) {
        categories[channel.group] = [];
      }
      categories[channel.group].push(channel);

      currentInfo = null;
    }
  }

  return { channels, categories };
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
