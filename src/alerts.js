/**
 * alerts.js — immediate Discord alerts for critical events (the daily report only
 * comes at 20:02). Sent to ALERT_WEBHOOK_URL (a Fly secret); without it nothing is
 * sent. Never blocks or fails a request: fire-and-forget, errors only logged.
 *
 * What is critical matches the daily report's NEEDS FIX rules:
 *   - a crash / out-of-memory kill (reported on the next start — see checkPreviousRun)
 *   - a [FATAL] unhandled rejection, a last-resort [ERROR] in a handler
 *   - a server freeze over 30 s, or the 21st freeze of the day
 *   - memory: all caches cleared, or the 4th "evicted the oldest half" of the day
 * At most one alert per kind every ALERT_EVERY_MS (no spam during a bad minute).
 * Texts are counts, kinds and masked errors only: no install links, logins,
 * provider addresses or user IPs.
 */

const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const { safeError } = require("./util");

const ALERT_EVERY_MS = 30 * 60 * 1000;
const lastSent = new Map(); // kind -> time sent

function alertUrl() {
  return process.env.ALERT_WEBHOOK_URL || "";
}

// Returns true when the alert was sent (or handed to `post` in tests)
function alert(kind, text, { now = Date.now(), post = defaultPost } = {}) {
  if (!alertUrl()) return false;
  if (now - (lastSent.get(kind) ?? -Infinity) < ALERT_EVERY_MS) return false;
  lastSent.set(kind, now);
  const content = `🔴 ${text}`.slice(0, 1900);
  void Promise.resolve(post(content)).catch(e => {
    // Never log the webhook URL: status / code only
    console.warn(`[ALERT] not sent (${kind}): ${e?.response?.status || e?.code || "error"}`);
  });
  return true;
}

function defaultPost(content) {
  // allowed_mentions: an error text can never ping @everyone
  return axios.post(alertUrl(), { content, allowed_mentions: { parse: [] } }, { timeout: 5000 });
}

// --- Bugs caught on purpose ---
// Where a failure is expected (provider down, bad input) the code falls back
// quietly; a mistake in our own code must not hide behind that fallback.
// isCodeBug: errors JavaScript raises for code mistakes ("x is not a function",
// "y is not defined"), as opposed to network/provider/input errors — those carry
// a code (ECONNRESET, ERR_INVALID_URL, …) or come from axios.
function isCodeBug(e) {
  if (!e || e.isAxiosError || e.code) return false;
  return e instanceof ReferenceError || e instanceof TypeError || e instanceof RangeError;
}

// Logged like the last-resort handler ([ERROR], counted by the daily report) + alert
function reportBug(where, e) {
  const text = `${where}: ${safeError(e)}`;
  console.error(`[ERROR] ${text}`);
  alert("error", `Unexpected error while ${text}`);
}

// --- Crash detection across restarts ---
// The process can't report an out-of-memory kill or a crash at that moment, so a
// marker file on the volume says "running" while it runs; a normal stop (deploy,
// Fly restart: SIGINT/SIGTERM) marks it "clean". If the next start still finds
// "running", the previous run ended without a normal stop. An uncaught exception
// writes its (masked) reason first so the next start can name it.
const MARKER = "run-state.json";

function readMarker(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8"));
  } catch {
    // First start, or unreadable: nothing to report
    return null;
  }
}

function writeMarker(dir, state) {
  try {
    fs.writeFileSync(path.join(dir, MARKER), JSON.stringify(state));
  } catch (e) {
    console.warn(`[ALERT] run state not saved: ${e.code || "error"}`);
  }
}

// On start: alert if the previous run didn't stop normally, then mark this one running
function checkPreviousRun(dir, now = new Date()) {
  const prev = readMarker(dir);
  writeMarker(dir, { state: "running", startedAt: now.toISOString() });
  if (!prev || prev.state !== "running" && prev.state !== "crashed") return null;
  const why = prev.state === "crashed"
    ? `crashed: ${prev.reason}`
    : "stopped without a normal shutdown (likely killed for using too much memory)";
  const text = `StreamVault restarted — the previous run (started ${prev.startedAt}) ${why}. Not a deploy.`;
  console.warn(`[ALERT] ${text}`);
  alert("crash", text);
  return text;
}

function markClean(dir) {
  writeMarker(dir, { state: "clean", stoppedAt: new Date().toISOString() });
}

function markCrashed(dir, err) {
  const prev = readMarker(dir);
  writeMarker(dir, { state: "crashed", startedAt: prev?.startedAt || "unknown", reason: safeError(err) });
}

module.exports = { alert, isCodeBug, reportBug, checkPreviousRun, markClean, markCrashed, ALERT_EVERY_MS, MARKER };
