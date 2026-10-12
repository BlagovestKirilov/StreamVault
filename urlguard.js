/**
 * urlguard.js — SSRF protection for every outbound fetch to a user-supplied URL.
 *
 * Blocks private/internal addresses (incl. Fly's fdaa: 6PN network and cloud
 * metadata at 169.254.x), both as literal hosts and after DNS resolution.
 */

const { URL } = require("url");
const dns = require("dns");

const PRIVATE_IP_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^::$/,
];

function isPrivateIp(ip) {
  // URL hostnames keep IPv6 brackets; IPv4-mapped IPv6 hides an IPv4 inside
  const bare = String(ip).replace(/^\[|\]$/g, "").replace(/^::ffff:/i, "");
  return PRIVATE_IP_RANGES.some(r => r.test(bare));
}

function isBlockedHostname(hostname) {
  return isPrivateIp(hostname) ||
    hostname === "localhost" || hostname.endsWith(".local") || hostname.endsWith(".internal");
}

// Hosts that already passed DNS validation — avoids a lookup on every EPG/stream call
const OK_HOST_TTL = 5 * 60 * 1000;
const okHosts = new Map();

async function validateExternalUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return false;
  if (urlStr.length > 2048) return false;
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (_) {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const hostname = parsed.hostname;
  if (isBlockedHostname(hostname)) return false;
  const okUntil = okHosts.get(hostname);
  if (okUntil && okUntil > Date.now()) return true;
  try {
    // Check every resolved address — one private A/AAAA record is enough to reject
    const addresses = await dns.promises.lookup(hostname, { all: true });
    if (addresses.length === 0 || addresses.some(a => isPrivateIp(a.address))) return false;
  } catch (_) {
    return false;
  }
  okHosts.set(hostname, Date.now() + OK_HOST_TTL);
  if (okHosts.size > 1000) okHosts.delete(okHosts.keys().next().value);
  return true;
}

async function assertExternalUrl(urlStr) {
  if (!(await validateExternalUrl(urlStr))) {
    throw new Error("Invalid or blocked URL");
  }
}

// axios (follow-redirects) hook: reject redirects that jump to an internal host
function blockPrivateRedirects(options) {
  if (isBlockedHostname(options.hostname || "")) {
    throw new Error("Redirect to blocked host");
  }
}

module.exports = { isPrivateIp, validateExternalUrl, assertExternalUrl, blockPrivateRedirects };
