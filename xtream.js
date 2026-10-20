/**
 * xtream.js — Xtream Codes API helper functions.
 *
 * Live TV only: VOD and series are intentionally not supported. Stremio covers
 * movies/series natively, and live-only keeps responses small and memory low.
 */

const axios = require("axios");
const { assertExternalUrl, blockPrivateRedirects, guardedAgents, PROVIDER_USER_AGENT, trimTrailingSlashes } = require("./urlguard");

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
    return client.get(url);
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
  return (data && data.epg_listings) || [];
}

/**
 * Fetch account details (player_api.php with no action → { user_info, server_info }).
 * @returns {Object|null} user_info: status, exp_date (unix secs or null), max_connections, active_cons, is_trial
 */
async function getAccountInfo(config) {
  const { data } = await http.get(baseUrl(config));
  return (data && data.user_info) || null;
}

module.exports = {
  getAccountInfo,
  getLiveCategories,
  getLiveStreams,
  getShortEPG,
};
