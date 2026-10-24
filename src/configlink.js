/**
 * configlink.js — Install link settings: encryption of the settings in a link,
 * the link formats (encrypted, base64url, legacy query string) and cleanup of
 * what users type (playlist links, full Xtream links).
 */

const crypto = require("node:crypto");

// --- Encryption for config URLs ---
// The fallback is for local dev only: in production it would let anyone decrypt
// users' provider credentials from their install URLs. Fly sets FLY_APP_NAME.
const IS_PRODUCTION = !!process.env.FLY_APP_NAME || process.env.NODE_ENV === "production";
if (IS_PRODUCTION && !process.env.CONFIG_SECRET) {
  console.error("[FATAL] CONFIG_SECRET is not set — refusing to start in production");
  process.exit(1);
}
const CONFIG_SECRET = process.env.CONFIG_SECRET || "dev-secret";
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

// Config "g" = JSON array of M3U group-titles the user picked (empty/invalid = all)
const MAX_SELECTED_GROUPS = 300;
function parseGroups(g) {
  if (!g) return [];
  try {
    const arr = JSON.parse(g);
    if (!Array.isArray(arr)) return [];
    return arr.filter(x => typeof x === "string" && x).slice(0, MAX_SELECTED_GROUPS);
  } catch (_) {
    return []; // not valid JSON: treat as "all groups"
  }
}

// Settings object (short keys) → config the handlers use; null if not a StreamVault setup
function configFromSettings(obj) {
  if (!obj) return null;
  if (obj.t === "xtream") {
    return { type: "xtream", server: obj.s || "", username: obj.u || "", password: obj.p || "", country: obj.c || "", timezone: obj.z || "" };
  }
  if (obj.t === "m3u") {
    return { type: "m3u", url: obj.m || "", country: obj.c || "", timezone: obj.z || "", groups: parseGroups(obj.g) };
  }
  return null;
}

// "e-<hex>": AES-256-GCM encrypted settings; null if it doesn't decrypt
function settingsFromEncrypted(configStr) {
  if (!/^e-[0-9a-f]+$/i.test(configStr)) return null;
  try {
    return decryptConfig(configStr.slice(2));
  } catch (_) {
    return null; // tampered or not ours — try the other formats
  }
}

// "ey…": base64url JSON (legacy); null if it doesn't decode
function settingsFromBase64(configStr) {
  if (!/^ey[A-Za-z0-9_-]+$/.test(configStr)) return null;
  try {
    const base64 = configStr.replaceAll("-", "+").replaceAll("_", "/");
    return JSON.parse(Buffer.from(base64, "base64").toString("utf-8"));
  } catch (_) {
    return null; // not JSON — fall through to the oldest format
  }
}

// Oldest format: URL-encoded key=value&key2=value2
function configFromQueryString(configStr) {
  const params = {};
  for (const pair of decodeURIComponent(configStr).split("&")) {
    const idx = pair.indexOf("=");
    if (idx > -1) params[pair.substring(0, idx)] = pair.substring(idx + 1);
  }
  if (params.sourceType === "xtream") {
    return {
      type: "xtream",
      server: decodeURIComponent(params.server || ""),
      username: decodeURIComponent(params.username || ""),
      password: decodeURIComponent(params.password || ""),
      country: decodeURIComponent(params.country || ""),
    };
  }
  return {
    type: "m3u",
    url: decodeURIComponent(params.m3uUrl || ""),
    country: decodeURIComponent(params.country || ""),
  };
}

// An M3U playlist link ("…/index.m3u", or a bare "http://name.m3u") typed into
// the Xtream server field — player_api.php can't exist under it, so the test
// would only fail with 404. Query/hash ignored ("list.m3u8?token=…" counts).
function isPlaylistLink(url) {
  try {
    const u = new URL(url);
    return /\.m3u8?$/i.test(u.pathname === "/" ? u.hostname : u.pathname);
  } catch (_) {
    return false; // not a URL at all — validation reports that separately
  }
}

// Users often paste their provider's full link into "Server address", e.g.
// "http://provider.com:8080/get.php?username=abc&password=123&type=m3u_plus".
// Xtream needs just the server (scheme + host + port): take that, and fill an
// empty username/password from the link. Anything else is left unchanged.
function normalizeXtreamLogin(server, username, password) {
  const out = {
    server: String(server || "").trim(),
    username: String(username || "").trim(),
    password: String(password || "").trim(),
  };
  try {
    const u = new URL(out.server);
    const isFullLink = /\/(get|player_api|xmltv|panel_api)\.php$/i.test(u.pathname) || u.searchParams.has("username");
    if (isFullLink) {
      if (!out.username) out.username = u.searchParams.get("username") || "";
      if (!out.password) out.password = u.searchParams.get("password") || "";
      out.server = u.origin;
    }
  } catch (_) {
    return out; // not a URL: left as typed — validation reports it
  }
  return out;
}

module.exports = {
  CONFIG_SECRET, encryptConfig, decryptConfig, configFromSettings, settingsFromEncrypted,
  settingsFromBase64, configFromQueryString, isPlaylistLink, normalizeXtreamLogin,
};
