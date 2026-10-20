/**
 * urlguard.js — SSRF protection for every outbound fetch to a user-supplied URL.
 *
 * Blocks private/internal addresses (incl. Fly's fdaa: 6PN network and cloud
 * metadata at 169.254.x), both as literal hosts and after DNS resolution.
 *
 * validateExternalUrl() is the early check (clear error before any download).
 * The guarantee is guardedAgents: every outbound connection re-checks the address
 * it is about to connect to, so a domain that resolves differently on the second
 * lookup (DNS rebinding), a redirect to a domain pointing inside, or a host
 * remembered in okHosts can't reach an internal address.
 */

const { URL } = require("node:url");
const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");

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

// DNS lookup used for the actual connection: refuse if any resolved address is
// private. Literal-IP hosts never reach a lookup; those are covered by
// validateExternalUrl (first URL) and blockPrivateRedirects (redirects).
// Node may ask for all addresses at once (autoSelectFamily) or just one.
function guardedLookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (addresses.length === 0 || addresses.some(a => isPrivateIp(a.address))) {
      return callback(Object.assign(new Error("Invalid or blocked URL"), { code: "EBLOCKED" }));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

// Pass to axios as { httpAgent, httpsAgent } — also used for redirects it follows
const guardedAgents = {
  httpAgent: new http.Agent({ lookup: guardedLookup }),
  httpsAgent: new https.Agent({ lookup: guardedLookup }),
};

// axios (follow-redirects) hook: reject redirects that jump to an internal host
function blockPrivateRedirects(options) {
  if (isBlockedHostname(options.hostname || "")) {
    throw new Error("Redirect to blocked host");
  }
}

// User-Agent for every request to a provider (playlists, Xtream API). Many IPTV
// panels / Cloudflare answer 403 to unknown clients like axios's default
// "axios/1.x"; identify as the player the streams are meant for.
const PROVIDER_USER_AGENT = "VLC/3.0.21 LibVLC/3.0.21";

// "http://host:8080///" → "http://host:8080". A loop instead of /\/+$/, whose
// backtracking makes a long run of slashes take quadratic time.
function trimTrailingSlashes(url) {
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") end--;
  return url.slice(0, end);
}

module.exports = {
  isPrivateIp, validateExternalUrl, assertExternalUrl, blockPrivateRedirects,
  guardedLookup, guardedAgents, PROVIDER_USER_AGENT, trimTrailingSlashes,
};
