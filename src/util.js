/**
 * util.js — Small shared helpers: project root, safe error text, request
 * details for logs/stats (User-Agent, masked paths), Stremio "extra" params.
 */

const path = require("node:path");

// Project root (the code lives in src/): public/ and local stats/links files are there
const ROOT = path.join(__dirname, "..");

// --- Helper: sanitize error messages (never leak URLs/credentials) ---
function safeError(e) {
  const msg = e.message || "Unknown error";
  if (msg.includes("://")) return "Connection failed";
  if (msg.length > 100) return msg.slice(0, 100);
  return msg;
}

// Which app/browser sent the request (to tell e.g. an old Stremio TV build from a bot)
function userAgent(req) {
  return String(req.get("user-agent") || "none").slice(0, 150);
}

// Path for logs/stats with install links hidden: any segment that is a user's
// config ("e-<hex>", base64 "ey...") or just very long becomes "<config>"
function maskPath(p) {
  return p.split("/").map(seg => (/^(e-|ey|s-)/.test(seg) || seg.length > 40 ? "<config>" : seg))
    .join("/").slice(0, 150);
}

/**
 * Parse Stremio extra params string like "skip=100&genre=Action"
 */
function parseExtra(extraStr) {
  const cleaned = extraStr.replace(/\.json$/, "");
  const params = {};
  cleaned.split("&").forEach((pair) => {
    const idx = pair.indexOf("=");
    const key = idx === -1 ? pair : pair.slice(0, idx);
    const val = idx === -1 ? "" : pair.slice(idx + 1);
    if (key) params[safeDecode(key)] = safeDecode(val);
  });
  return params;
}

// A "%" that isn't valid URL encoding (e.g. a category named "100% Sport" sent
// unencoded) made decodeURIComponent throw "URI malformed" and broke the catalog.
// Keep the raw text instead.
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (_) {
    return s; // malformed %-encoding: keep the raw text
  }
}

// The promise's value, or `fallback` if it fails or takes longer than `ms`
async function withinMs(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); });
  try {
    return await Promise.race([promise.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { ROOT, safeError, userAgent, parseExtra, maskPath, withinMs };
