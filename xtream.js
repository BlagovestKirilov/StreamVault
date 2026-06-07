/**
 * xtream.js — Xtream Codes API helper functions.
 */

const axios = require("axios");

// Shared client with a hard response-size ceiling. axios defaults to unlimited
// in Node, so a single huge get_vod_streams/get_series response can OOM the
// process. 50 MB is far above any legitimate category listing.
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB
const http = axios.create({
  timeout: 15000,
  maxContentLength: MAX_RESPONSE_BYTES,
  maxBodyLength: MAX_RESPONSE_BYTES,
});

/**
 * Build the base API URL for Xtream Codes.
 * @param {Object} config - { server, username, password }
 * @returns {string}
 */
function baseUrl(config) {
  // Remove trailing slash from server URL
  const server = config.server.replace(/\/+$/, "");
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
 * Fetch VOD categories.
 */
async function getVodCategories(config) {
  const url = `${baseUrl(config)}&action=get_vod_categories`;
  const { data } = await http.get(url);
  return data || [];
}

/**
 * Fetch VOD streams, optionally filtered by category.
 */
async function getVodStreams(config, categoryId) {
  let url = `${baseUrl(config)}&action=get_vod_streams`;
  if (categoryId) url += `&category_id=${categoryId}`;
  const { data } = await http.get(url);
  return data || [];
}

/**
 * Fetch series categories.
 */
async function getSeriesCategories(config) {
  const url = `${baseUrl(config)}&action=get_series_categories`;
  const { data } = await http.get(url);
  return data || [];
}

/**
 * Fetch series list, optionally filtered by category.
 */
async function getSeries(config, categoryId) {
  let url = `${baseUrl(config)}&action=get_series`;
  if (categoryId) url += `&category_id=${categoryId}`;
  const { data } = await http.get(url);
  return data || [];
}

/**
 * Fetch series info (episodes).
 */
async function getSeriesInfo(config, seriesId) {
  const url = `${baseUrl(config)}&action=get_series_info&series_id=${seriesId}`;
  const { data } = await http.get(url);
  return data || {};
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
 * Fetch full EPG for a specific stream.
 * @param {Object} config
 * @param {string|number} streamId
 */
async function getEPG(config, streamId) {
  const url = `${baseUrl(config)}&action=get_simple_data_table&stream_id=${streamId}`;
  const { data } = await http.get(url);
  return (data && data.epg_listings) || [];
}

/**
 * Build stream URL for live channel.
 */
function buildLiveStreamUrl(config, streamId) {
  const server = config.server.replace(/\/+$/, "");
  return `${server}/live/${config.username}/${config.password}/${streamId}.m3u8`;
}

/**
 * Build stream URL for VOD.
 */
function buildVodStreamUrl(config, streamId) {
  const server = config.server.replace(/\/+$/, "");
  return `${server}/movie/${config.username}/${config.password}/${streamId}.mp4`;
}

/**
 * Build stream URL for series episode.
 */
function buildSeriesStreamUrl(config, streamId) {
  const server = config.server.replace(/\/+$/, "");
  return `${server}/series/${config.username}/${config.password}/${streamId}.mkv`;
}

module.exports = {
  getLiveCategories,
  getLiveStreams,
  getVodCategories,
  getVodStreams,
  getSeriesCategories,
  getSeries,
  getSeriesInfo,
  getShortEPG,
  getEPG,
  buildLiveStreamUrl,
  buildVodStreamUrl,
  buildSeriesStreamUrl,
};
