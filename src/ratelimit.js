/**
 * ratelimit.js — client IP detection and per-IP request limits.
 *
 * In-memory fixed windows (one process, one machine). Over the limit a request
 * gets 429; StreamVault's response-code stats count those.
 */

// The client can't be trusted with X-Forwarded-For: anything it sends ends up at
// the front of that header (verified live: "X-Forwarded-For: 1.2.3.4" was logged
// as 1.2.3.4). Fly's proxy puts the address it accepted the connection from in
// Fly-Client-IP. Locally (no Fly proxy) the socket address is the client.
function getIp(req) {
  const fly = req.headers["fly-client-ip"];
  if (typeof fly === "string" && fly.trim()) return fly.trim();
  return req.socket?.remoteAddress || "unknown";
}

// IP for log lines: personal data, so only the network part is kept
// (203.0.113.45 → 203.0.113.x, 2a00:4804:d000:33d:58c5:… → 2a00:4804:d000:33d:x).
// Limits still use the full IP in memory (user counting: a one-way code of the
// IPv4 / the IPv6 /64, see stats.js userNetwork); it just isn't written to logs.
function maskIp(ip) {
  const s = String(ip || "").replace(/^::ffff:/i, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.replace(/\.\d{1,3}$/, ".x");
  if (s.includes(":")) return `${s.split(":").slice(0, 4).join(":")}:x`;
  return "unknown";
}

// Requests from this machine itself (local dev, tests, health probes) are never
// limited; production traffic always arrives through Fly's proxy with a client IP.
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- loopback addresses, not a remote host
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

    // ok:false so the configure page shows the message like any failed check
    res.status(429).json({ ok: false, error: "Too many requests" });
  };
}

module.exports = { getIp, maskIp, rateLimit };
