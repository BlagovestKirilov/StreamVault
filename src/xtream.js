/**
 * xtream.js — Xtream Codes API helper functions.
 *
 * Live TV only: VOD and series are intentionally not supported. Stremio covers
 * movies/series natively, and live-only keeps responses small and memory low.
 */

const { StringDecoder } = require("node:string_decoder");
const axios = require("axios");
const { reportBug } = require("./alerts");
const { assertExternalUrl, blockPrivateRedirects, guardedAgents, retryOnClosedConnection, PROVIDER_USER_AGENT, trimTrailingSlashes, withSchemeFallback } = require("./urlguard");

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
  get(url) {
    return withSchemeFallback(url, async (u) => {
      await assertExternalUrl(u);
      return retryOnClosedConnection(() => client.get(u));
    });
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
  const response = await withSchemeFallback(url, async (u) => {
    await assertExternalUrl(u);
    return retryOnClosedConnection(() => client.get(u, { responseType: "stream" }));
  });
  return readLiveStreamList(response.data);
}

// A provider's full channel list can be a 50 MB JSON array. Parsed in one go it
// briefly took 300–500 MB of memory (and crashed the 1 GB machine, 2026-11-21).
// Read as it downloads instead: each channel is parsed on its own and only the
// fields StreamVault uses are kept, so the peak is about the size of the result.
// Same answers as before: an array of channels; anything that isn't a JSON array
// (an error object, empty or broken JSON) gives what the parsed body was, or [].
const LIVE_FIELDS = ["stream_id", "name", "title", "stream_icon", "cover", "category_id", "tv_archive", "tv_archive_duration"];
const LIST_TIME_LIMIT_MS = 60000; // the whole list; the client's 15 s covers the start
function pickLiveFields(item) {
  if (!item || typeof item !== "object") return item;
  const kept = {};
  for (const key of LIVE_FIELDS) if (item[key] !== undefined) kept[key] = item[key];
  return kept;
}

function createArraySplitter(onItem) {
  const s = { mode: "start", other: "", depth: 0, inString: false, escaped: false, pending: "", start: -1 };
  const stringChar = (ch) => {
    if (s.escaped) s.escaped = false;
    else if (ch === "\\") s.escaped = true;
    else if (ch === '"') s.inString = false;
  };
  const structuralChar = (ch, i, text) => {
    if (ch === '"') {
      s.inString = true;
    } else if (ch === "{" || ch === "[") {
      if (s.depth === 1) s.start = i;
      s.depth++;
    } else if (ch === "}" || ch === "]") {
      s.depth--;
      if (s.depth === 1 && s.start >= 0) {
        onItem(s.pending + text.slice(s.start, i + 1));
        s.pending = "";
        s.start = -1;
      }
    }
  };
  // First non-space character: "[" starts the array, anything else isn't one.
  // Returns where scanning goes on, or -1 when the body isn't an array.
  const begin = (text) => {
    const i = text.search(/\S/);
    if (i < 0) return text.length;
    if (text[i] !== "[") {
      s.mode = "other";
      s.other = text.slice(i);
      return -1;
    }
    s.mode = "array";
    s.depth = 1;
    return i + 1;
  };
  return {
    push(text) {
      if (s.mode === "other") {
        s.other += text;
        return;
      }
      const from = s.mode === "start" ? begin(text) : 0;
      if (from < 0) return;
      for (let i = from; i < text.length; i++) {
        if (s.inString) stringChar(text[i]);
        else structuralChar(text[i], i, text);
      }
      if (s.start >= 0) {
        s.pending += text.slice(s.start);
        s.start = 0; // the channel goes on at the start of the next chunk
      }
    },
    get isArray() { return s.mode === "array"; },
    get other() { return s.other; },
  };
}

function readLiveStreamList(stream) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    const items = [];
    let broken = false; // a channel that isn't valid JSON: the list counts as unreadable
    const splitter = createArraySplitter((text) => {
      let channel;
      try {
        channel = JSON.parse(text);
      } catch {
        // A channel that isn't valid JSON: the provider's list is unreadable (as before)
        broken = true;
        return;
      }
      // Our own code, outside the guard: a bug here is reported, not taken for a broken list
      try {
        items.push(pickLiveFields(channel));
      } catch (e) {
        reportBug("reading an Xtream channel list", e);
        fail(`StreamVault could not read the channel list: ${e.message}`);
      }
    });
    let bytes = 0;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const fail = (message) => {
      stream.destroy();
      finish(reject, new Error(message));
    };
    // The list had started arriving, so the provider was reachable, just too slow
    const timer = setTimeout(() => {
      stream.destroy();
      finish(reject, Object.assign(new Error(`timeout of ${LIST_TIME_LIMIT_MS}ms exceeded`), { providerConnected: true }));
    }, LIST_TIME_LIMIT_MS);

    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BYTES) return fail(`maxContentLength size of ${MAX_RESPONSE_BYTES} exceeded`);
      splitter.push(decoder.write(chunk));
    });
    stream.on("end", () => {
      splitter.push(decoder.end());
      if (splitter.isArray) return finish(resolve, broken ? [] : items);
      try {
        finish(resolve, JSON.parse(splitter.other) || []);
      } catch {
        // Not JSON: as before, the raw text (callers treat it as no list)
        finish(resolve, splitter.other || []);
      }
    });
    stream.on("error", (e) => finish(reject, e));
  });
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
  readLiveStreamList,
  getShortEPG,
  getEpgTable,
  serverUtcOffsetMin,
};
