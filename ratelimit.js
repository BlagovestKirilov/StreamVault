/**
 * ratelimit.js — client IP detection and per-IP request limits.
 *
 * In-memory fixed windows (one process, one machine). Over the limit a request
 * gets 429 + Retry-After; StreamVault's response-code stats count those.
 */

// The client can't be trusted with X-Forwarded-For: anything it sends ends up at
// the front of that header (verified live: "X-Forwarded-For: 1.2.3.4" was logged
// as 1.2.3.4). Fly's proxy puts the address it accepted the connection from in
// Fly-Client-IP. Locally (no Fly proxy) the socket address is the client.
function getIp(req) {
  const fly = req.headers["fly-client-ip"];
  if (typeof fly === "string" && fly.trim()) return fly.trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

// Requests from this machine itself (local dev, tests, health probes) are never
// limited; production traffic always arrives through Fly's proxy with a client IP.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const MAX_KEYS = 50_000; // a flood of (fake) IPs can't grow memory past this
const windows = new Map(); // "<name>|<ip>" -> { count, resetAt }

setInterval(() => {
  const now = Date.now();
  for (const [key, w] of windows) {
    if (w.resetAt <= now) windows.delete(key);
  }
}, 60 * 1000).unref();

/**
 * Express middleware allowing `max` requests per IP per `windowMs` for this group.
 * @param {string} name - limit group (separate counters per group)
 */
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const ip = getIp(req);
    if (LOOPBACK.has(ip)) return next();

    const key = `${name}|${ip}`;
    const now = Date.now();
    let w = windows.get(key);
    if (!w || w.resetAt <= now) {
      if (windows.size >= MAX_KEYS) windows.clear();
      w = { count: 0, resetAt: now + windowMs };
      windows.set(key, w);
    }
    w.count++;
    if (w.count <= max) return next();

    const retryAfter = Math.max(1, Math.ceil((w.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    // ok:false so the configure page shows the message like any failed check
    res.status(429).json({ ok: false, error: `Too many requests — try again in ${retryAfter} seconds` });
  };
}

module.exports = { getIp, rateLimit };
