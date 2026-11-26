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
  /^172\.(1[6-9]|2\d|3[01])\./,
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

// The parsed http(s) URL when the address itself is acceptable (scheme, length,
// not a literal private/internal host), else null. No DNS lookup.
function parseExternalUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string") return null;
  if (urlStr.length > 2048) return null;
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (_) {
    return null; // not a URL: refused like any other bad address
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return isBlockedHostname(parsed.hostname) ? null : parsed;
}

// For addresses StreamVault only hands to the viewer's player (the /play
// redirect): the server never connects to them, so a DNS check adds nothing —
// and a passing DNS hiccup used to block playback.
function isExternalUrlSyntax(urlStr) {
  return parseExternalUrl(urlStr) !== null;
}

// Why an address can or can't be used, so Test Connection can say it plainly:
// "ok", "malformed" (not an http(s) URL / too long), "private" (localhost, a
// local-network or internal address, or a name that resolves to one) or
// "not_found" (the name doesn't resolve: a typo or a provider domain that's gone).
async function checkExternalUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string" || urlStr.length > 2048) return "malformed";
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (_) {
    return "malformed";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "malformed";
  const hostname = parsed.hostname;
  if (isBlockedHostname(hostname)) return "private";
  const okUntil = okHosts.get(hostname);
  if (okUntil && okUntil > Date.now()) return "ok";
  let addresses;
  try {
    addresses = await dns.promises.lookup(hostname, { all: true });
  } catch (_) {
    return "not_found"; // name doesn't resolve: there's nothing to connect to
  }
  if (addresses.length === 0) return "not_found";
  // Check every resolved address — one private A/AAAA record is enough to reject
  if (addresses.some(a => isPrivateIp(a.address))) return "private";
  okHosts.set(hostname, Date.now() + OK_HOST_TTL);
  if (okHosts.size > 1000) okHosts.delete(okHosts.keys().next().value);
  return "ok";
}

async function validateExternalUrl(urlStr) {
  return (await checkExternalUrl(urlStr)) === "ok";
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

// Pass to axios as { httpAgent, httpsAgent } — also used for redirects it follows.
// Keep-alive: connections to a provider are reused (no new TCP/TLS setup per
// request); idle ones close after 4 s (sooner if the server says so) and at most
// 16 per provider. Every new connection still goes through guardedLookup.
const AGENT_OPTIONS = { lookup: guardedLookup, keepAlive: true, timeout: 4000, maxSockets: 16, maxFreeSockets: 4 };
const guardedAgents = {
  httpAgent: markConnects(new http.Agent(AGENT_OPTIONS)),
  httpsAgent: markConnects(new https.Agent(AGENT_OPTIONS)),
};

// Marks each socket once the provider's server accepted the connection, so a
// timeout can be told apart afterwards (stats.timeoutKind, logs only): never
// connected = blocked or down; connected = the provider was just too slow.
// axios keeps the socket on its timeout error (error.request.socket).
function markConnects(agent) {
  const create = agent.createConnection.bind(agent);
  agent.createConnection = (...args) => {
    const socket = create(...args);
    socket?.once?.("connect", () => { socket.providerConnected = true; });
    return socket;
  };
  return agent;
}

// A kept-alive connection the provider had already closed fails at once with
// ECONNRESET/EPIPE before the request reaches it; GETs are safe to send again,
// so retry once on a fresh connection.
const STALE_CONNECTION_CODES = new Set(["ECONNRESET", "EPIPE"]);
async function retryOnClosedConnection(request) {
  try {
    return await request();
  } catch (e) {
    if (!STALE_CONNECTION_CODES.has(e?.code)) throw e;
    return request();
  }
}

// --- Wrong scheme in a saved address (http ↔ https) ---
// Test Connection tries both schemes and saves the one that works, but setups saved
// before that (2026-11-14), or providers that switched since, still carry the wrong
// one — and every channel list then failed until the user saved again. Now a
// request that fails in a way that means "wrong scheme" is tried once with the
// other one; if that works, the scheme is remembered for that server (in memory,
// until restart) so later requests — and the play links built from the address
// (extractConfig applies preferredUrl) — go straight to it.
//   https:// on a plain-http server → TLS "wrong version number" (EPROTO)
//   http:// on an https-only server → 400 "plain HTTP request sent to HTTPS port",
//   497, or connection refused on port 80 (no port in the address)
const SCHEME_MEMORY_MAX = 2000;
const schemeMemory = new Map(); // "host:port" (port as typed, "" if none) -> "http:" | "https:"
const schemeKey = (u) => `${u.hostname}:${u.port}`;

function otherScheme(url) {
  const u = new URL(url);
  u.protocol = u.protocol === "https:" ? "http:" : "https:";
  return u.toString();
}

// The address with the scheme that worked last time for its server, if one is known
function preferredUrl(url) {
  try {
    const u = new URL(url);
    const known = schemeMemory.get(schemeKey(u));
    if (!known || known === u.protocol) return url;
    const swapped = otherScheme(url);
    // URL() adds a "/" to a bare origin; keep the address as it was written
    return url.endsWith("/") ? swapped : swapped.replace(/\/$/, "");
  } catch (_) {
    return url; // not a URL: left as it is
  }
}

function looksLikeWrongScheme(e, url) {
  const isHttps = /^https:/i.test(url);
  if (isHttps) return /EPROTO|wrong version number|SSL routines/i.test(String(e?.message)) || e?.code === "EPROTO";
  const status = e?.response?.status;
  if (status === 400 || status === 497) return true;
  return e?.code === "ECONNREFUSED" && !new URL(url).port;
}

function rememberScheme(url) {
  const u = new URL(url);
  schemeMemory.delete(schemeKey(u));
  schemeMemory.set(schemeKey(u), u.protocol);
  if (schemeMemory.size > SCHEME_MEMORY_MAX) schemeMemory.delete(schemeMemory.keys().next().value);
}

// request(url) → promise. Tries the remembered (or given) scheme, then once the other
// one on a wrong-scheme failure. Both fail → the first error, as before.
async function withSchemeFallback(url, request) {
  const first = preferredUrl(url);
  try {
    return await request(first);
  } catch (e) {
    if (!looksLikeWrongScheme(e, first)) throw e;
    const second = otherScheme(first);
    let result;
    try {
      result = await request(second);
    } catch (_) {
      throw e;
    }
    rememberScheme(second);
    require("./stats").countToday("schemeSwitches");
    return result;
  }
}

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
  isPrivateIp, checkExternalUrl, validateExternalUrl, isExternalUrlSyntax, assertExternalUrl, blockPrivateRedirects,
  guardedLookup, guardedAgents, retryOnClosedConnection, PROVIDER_USER_AGENT, trimTrailingSlashes,
  withSchemeFallback, preferredUrl,
};
