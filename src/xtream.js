/**
 * xtream.js — Xtream Codes API helper functions.
 *
 * Live TV only: VOD and series are intentionally not supported. Stremio covers
 * movies/series natively, and live-only keeps responses small and memory low.
 */

const axios = require("axios");
const { assertExternalUrl, blockPrivateRedirects, guardedAgents, retryOnClosedConnection, PROVIDER_USER_AGENT, trimTrailingSlashes } = require("./urlguard");

// Shared client with a hard response-size ceiling. axios defaults to unlimited
// in Node. Live-only responses are small, but the cap stays as a safety net.
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB
const client = axios.create({
  timeout: 15000,
  headers: { "User-Agent": PROVIDER_USER_AGENT },
  maxContentLength: MAX_RESPONSE_BYTES,
  maxBodyLength: MAX_RESPONSE_BYTES,
  beforeRedirect: blockPrivateRedirects,
  ...guardedAgents, // re-checks the address at connect time (DNS rebinding, redirects)
});

// Server URL comes from the user's config, so every call is SSRF-checked
const http = {
  async get(url) {
    await assertExternalUrl(url);
    return retryOnClosedConnection(() => client.get(url));
  },
};

/**
 * Build the base API URL for Xtream Codes.
 * @param {Object} config - { server, username, password }
 * @returns {string}
 */
function baseUrl(config) {
  // Remove trailing slash from server URL
  const server = trimTrailingSlashes(config.server);
  return `${server}/player_api.php?username=${encodeURIComponent(config.username)}&password=${encodeURIComponent(config.password)}`;
}

/**
 * Fetch live TV categories.
 */
async function getLiveCategories(config) {
  const url = `${baseUrl(config)}&action=get_live_categories`;
  const { data } = await http.get(url);
  return data || [];
}

/**
 * Fetch live streams for a given category.
 * @param {Object} config
 * @param {string|number} categoryId
 */
async function getLiveStreams(config, categoryId) {
  let url = `${baseUrl(config)}&action=get_live_streams`;
  if (categoryId) url += `&category_id=${categoryId}`;
  const { data } = await http.get(url);
  return data || [];
}

/**
 * Fetch short EPG for a specific stream (current/next program).
 * @param {Object} config
 * @param {string|number} streamId
 */
async function getShortEPG(config, streamId) {
  const url = `${baseUrl(config)}&action=get_short_epg&stream_id=${streamId}`;
  const { data } = await http.get(url);
  return data?.epg_listings || [];
}

/**
 * Fetch the full TV guide table for a channel (past programmes too, each with
 * "has_archive" = 1 when it can be watched again through /timeshift/).
 * @param {Object} config
 * @param {string|number} streamId
 */
async function getEpgTable(config, streamId) {
  const url = `${baseUrl(config)}&action=get_simple_data_table&stream_id=${streamId}`;
  const { data } = await http.get(url);
  return Array.isArray(data?.epg_listings) ? data.epg_listings : [];
}

/**
 * Fetch account details (player_api.php with no action → { user_info, server_info }).
 * @returns {Object|null} user_info: status, exp_date (unix secs or null), max_connections, active_cons, is_trial
 */
async function getAccountInfo(config) {
  const { data } = await http.get(baseUrl(config));
  const info = data?.user_info;
  if (!info || typeof info !== "object") return null;
  const offset = serverUtcOffsetMin(data.server_info);
  return offset === null ? info : { ...info, serverUtcOffsetMin: offset };
}

/**
 * The provider's clock offset from UTC in minutes, from server_info's local
 * "time_now" ("2026-10-27 21:00:00") and "timestamp_now" (unix secs). Catch-up
 * links need start times in the provider's local time. Rounded to 15 minutes;
 * null when either is missing or the offset is impossible.
 */
function serverUtcOffsetMin(serverInfo) {
  const local = Date.parse(`${String(serverInfo?.time_now || "").replace(" ", "T")}Z`);
  const utc = Number(serverInfo?.timestamp_now) * 1000;
  if (!Number.isFinite(local) || !utc) return null;
  const minutes = Math.round((local - utc) / 60000 / 15) * 15;
  return Math.abs(minutes) <= 14 * 60 ? minutes : null;
}

module.exports = {
  getAccountInfo,
  getLiveCategories,
  getLiveStreams,
  getShortEPG,
  getEpgTable,
  serverUtcOffsetMin,
};
