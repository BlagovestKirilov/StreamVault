/**
 * stats.js — Usage statistics: counters saved in stats.json (all-time totals,
 * per-day history rows, unique users as one-way codes) and the in-memory
 * "recent" lists shown in /stats. Saved every minute and on shutdown.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const { ROOT, safeError } = require("./util");
const { CONFIG_SECRET } = require("./configlink");

// STATS_DIR env only for tests (a throwaway folder); production uses the /data volume
const STATS_DIR = process.env.STATS_DIR || (fs.existsSync("/data") ? "/data" : ROOT);
const STATS_FILE = path.join(STATS_DIR, "stats.json");
const stats = {
  installs: 0, configures: 0, streams: 0, searches: 0,
  reconfigures: 0, // Configure opened from an installed StreamVault (all time)
  reinstalls: 0,   // Save changes pressed there (all time)
  users: new Set(), startedAt: new Date().toISOString(),
  streamsByType: { tv: 0, movie: 0, series: 0 },
  configType: { xtream: 0, m3u: 0 },
  installsByType: { xtream: 0, m3u: 0 },
  kofiClicks: { dialog: 0, footer: 0, other: 0 }, // clicks on the Ko-fi link (all time, every click)
  catchupPlays: 0,  // catch-up programmes started (all time; TS only — HLS goes to the provider directly)
  dailyActive: {},  // { "2026-05-31": Set([user keys]) } — app loaded StreamVault
  dailyViewers: {}, // same, but users who opened a channel and got something to play
  dailyCatchup: {}, // same, users who started a catch-up programme
  dailyBare: {},    // same, users whose app loads StreamVault without settings (never set up)
  bareUsers: new Set(), // seen without settings and not set up since — bareConverted when they are
  history: {},      // { "2026-05-31": { launches, installs, ..., catalogErrors, dau, viewers } }
};

// Unique users are counted by a one-way code of the IP, never the IP itself, so
// stats.json holds no personal data. Keyed with a secret derived from
// CONFIG_SECRET: without it the codes can't be reversed by trying every IPv4.
const userKeySecret = crypto.createHash("sha256").update(`stats-users|${CONFIG_SECRET}`).digest();
const USER_KEY_RE = /^[0-9a-f]{16}$/;
function hmacKey(value) {
  return crypto.createHmac("sha256", userKeySecret).update(String(value)).digest("hex").slice(0, 16);
}
// Phones and PCs change the second half of their IPv6 address every few hours
// (privacy addresses), so one person kept turning into a "new" user. Count IPv6
// by its first half (/64, one home or phone network); IPv4 by the whole address.
function userNetwork(ip) {
  const s = String(ip || "").replace(/^::ffff:/i, "").split("%")[0];
  if (!net.isIPv6(s)) return s;
  const [head, tail = ""] = s.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  if (s.includes("::")) {
    const right = tail ? tail.split(":") : [];
    left.push(...new Array(8 - left.length - right.length).fill("0"));
  }
  return `${left.slice(0, 4).map(part => part.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
function userKey(ip) {
  return hmacKey(userNetwork(ip));
}
// Codes saved before the /64 change were made from the full IPv6 address: a
// returning user with such a code is moved over to the network code once, so the
// switch doesn't count every IPv6 user as a new install again
function knownUser(ip) {
  const user = userKey(ip);
  if (stats.users.has(user)) return user;
  const old = hmacKey(String(ip || "").replace(/^::ffff:/i, ""));
  if (old !== user) {
    for (const set of [stats.users, stats.bareUsers]) {
      if (set.delete(old)) set.add(user);
    }
  }
  return user;
}
// Entries saved before this change are plain IPs — convert them on load
function toUserKeys(list) {
  return new Set((list || []).map(v => (USER_KEY_RE.test(v) ? v : userKey(v))));
}

try {
  const saved = JSON.parse(fs.readFileSync(STATS_FILE, "utf-8"));
  const loaded = { ...saved, users: toUserKeys(saved.users) };
  // Other modules hold this same object: replace its contents, not the object
  for (const key of Object.keys(stats)) delete stats[key];
  Object.assign(stats, loaded);
  if (!stats.streamsByType) stats.streamsByType = { tv: 0, movie: 0, series: 0 };
  if (!stats.configType) stats.configType = { xtream: 0, m3u: 0 };
  if (!stats.installsByType) stats.installsByType = { xtream: 0, m3u: 0 };
  if (!stats.kofiClicks) stats.kofiClicks = { dialog: 0, footer: 0, other: 0 };
  if (!stats.dailyActive) stats.dailyActive = {};
  if (!stats.dailyViewers) stats.dailyViewers = {};
  if (!stats.dailyCatchup) stats.dailyCatchup = {};
  if (typeof stats.catchupPlays !== "number") stats.catchupPlays = 0;
  if (!stats.dailyBare) stats.dailyBare = {};
  stats.bareUsers = toUserKeys(saved.bareUsers);
  if (!stats.history) stats.history = {};
  // All-time totals started after the daily counters: seed them from the rows
  for (const counter of ["reconfigures", "reinstalls"]) {
    if (typeof stats[counter] !== "number") {
      stats[counter] = Object.values(stats.history).reduce((sum, row) => sum + (row[counter] || 0), 0);
    }
  }
  // Restore the per-day Sets
  for (const daily of [stats.dailyActive, stats.dailyViewers, stats.dailyCatchup, stats.dailyBare]) {
    for (const day of Object.keys(daily)) daily[day] = toUserKeys(daily[day]);
  }
} catch (_) {
  // No stats.json yet (first start) or unreadable: start counting from zero
}

const MAX_TRACKED_USERS = 10000;

function saveStatsData() {
  // Cap users Set to prevent unbounded growth
  if (stats.users.size > MAX_TRACKED_USERS) {
    const arr = [...stats.users];
    stats.users = new Set(arr.slice(arr.length - MAX_TRACKED_USERS));
  }
  if (stats.bareUsers.size > MAX_TRACKED_USERS) {
    stats.bareUsers = new Set([...stats.bareUsers].slice(-MAX_TRACKED_USERS));
  }
  // Keep 90 days of per-day rows; freeze each day's unique-user counts into its
  // row so they survive after the per-day lists (30 days) are dropped
  const historyCutoff = new Date();
  historyCutoff.setDate(historyCutoff.getDate() - HISTORY_DAYS);
  const history = {};
  for (const [day, row] of Object.entries(stats.history)) {
    if (new Date(day) < historyCutoff) continue;
    history[day] = { ...row, ...uniqueCounts(day) };
  }
  stats.history = history;
  return {
    ...stats, users: [...stats.users], bareUsers: [...stats.bareUsers],
    dailyActive: lastDays(stats.dailyActive, 30), dailyViewers: lastDays(stats.dailyViewers, 30),
    dailyCatchup: lastDays(stats.dailyCatchup, 30),
    dailyBare: lastDays(stats.dailyBare, 30),
  };
}

// Only the last `days` days of a { day: Set } map, as arrays (for stats.json)
function lastDays(daily, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const kept = {};
  for (const [day, keys] of Object.entries(daily)) {
    if (new Date(day) >= cutoff) kept[day] = [...keys];
  }
  return kept;
}

// { dau, viewers, catchupUsers, bareUsers } for a day still in the per-day lists (older days: {})
function uniqueCounts(day) {
  const counts = {};
  if (stats.dailyActive[day]) counts.dau = stats.dailyActive[day].size;
  if (stats.dailyViewers[day]) counts.viewers = stats.dailyViewers[day].size;
  if (stats.dailyCatchup[day]) counts.catchupUsers = stats.dailyCatchup[day].size;
  if (stats.dailyBare[day]) counts.bareUsers = stats.dailyBare[day].size;
  return counts;
}

function addDailyUser(daily, user) {
  const today = todayKey();
  if (!daily[today]) daily[today] = new Set();
  daily[today].add(user);
}

// Does setting up after the "Set up StreamVault first" tile work? A user whose app
// loads StreamVault without settings, and who never loaded a configured one, is
// counted per day (bareUsers); if they later install a configured StreamVault,
// that's one bareConverted. By IP code like dau, so a new IP looks like a new user.
function noteBareUser(user) {
  if (stats.users.has(user)) return; // has a configured StreamVault (an extra empty one)
  stats.bareUsers.add(user);
  addDailyUser(stats.dailyBare, user);
}

function noteSetupDone(user) {
  if (stats.bareUsers.delete(user)) countToday("bareConverted");
}

// --- Per-day history (trends) + failures (provider problems) ---
const HISTORY_DAYS = 90;
const MAX_RECENT_ERRORS = 20;
// In memory only (reset on restart), newest first, never URLs/credentials:
const recentErrors = [];        // provider failures
const recentUnknownPaths = [];  // requests StreamVault answered 404 (paths masked)
const recentEmptyStreams = [];  // stream requests that returned nothing, and why
const recentUnconfigured = [];  // requests from installs without settings (+ which app)
const recentPlayRejects = [];   // /play redirects refused, and which check failed
const recentBadLinks = [];      // install links refused (manifest/catalog/meta/stream), and why
const recentTestFailures = [];  // failed Test Connections: error + address shape (private parts hidden)

function noteRecent(list, entry) {
  list.unshift({ at: new Date().toISOString(), ...entry });
  if (list.length > MAX_RECENT_ERRORS) list.pop();
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function dayRow() {
  const day = todayKey();
  if (!stats.history[day]) {
    stats.history[day] = {
      launches: 0, installs: 0, configures: 0, searches: 0, streams: 0,
      catalogErrors: 0, metaErrors: 0, streamErrors: 0, emptyStreams: 0,
      // what users' providers returned, by where it happened: { catalog: { "503": 2 } }
      providerErrors: {},
      // what StreamVault answered with status >= 400, by endpoint: { "POST /api/test": { "429": 3 } }
      responseErrors: {},
    };
  }
  return stats.history[day];
}


function countToday(field) {
  const row = dayRow();
  row[field] = (row[field] || 0) + 1;
}

// Per-day count by where + code: row[mapName][where][code]. Each level only takes
// so many distinct keys, so random status codes can't bloat stats.json — extras
// go to "other".
const MAX_KEYS_PER_LEVEL = 30;
function boundedKey(obj, key) {
  return obj[key] !== undefined || Object.keys(obj).length < MAX_KEYS_PER_LEVEL ? key : "other";
}
function countCode(mapName, where, code) {
  const row = dayRow();
  const map = row[mapName] || (row[mapName] = {}); // rows from before error tracking have none
  const w = boundedKey(map, where);
  const codes = map[w] || (map[w] = {});
  const c = boundedKey(codes, code);
  codes[c] = (codes[c] || 0) + 1;
}

// Provider failure → HTTP status ("503") or, without one, what went wrong
function providerErrorKey(e) {
  const msg = String(e?.message || "");
  const status = (/status code (\d{3})/.exec(msg) || [])[1];
  if (status) return status;
  // https:// address on a server that only speaks plain http on that port
  if (/EPROTO|wrong version number|SSL routines/i.test(msg)) return "https_mismatch";
  if (/Invalid or blocked URL|ENOTFOUND|EAI_AGAIN|ECONNREFUSED/i.test(msg)) return "bad_address";
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up/i.test(msg)) return "timeout";
  return "other";
}

// where = "catalog" | "meta" | "stream"
function recordError(where, config, e) {
  countToday(`${where}Errors`);
  countCode("providerErrors", `${where} (${config?.type || "unknown"})`, providerErrorKey(e));
  noteRecent(recentErrors, { where, source: config?.type, error: safeError(e) });
}

// Saves write a temp file and rename it over stats.json. A rename is all-or-nothing,
// so a crash/deploy mid-save leaves the previous stats.json intact instead of a
// half-written file (which would fail to load and reset all stats to zero).
let saving = false;

function saveStats() {
  if (saving) return; // previous save still running — the next interval saves again
  let data;
  try {
    data = JSON.stringify(saveStatsData(), null, 2);
  } catch (_) {
    return; // nothing started, so the flag is never left stuck on
  }
  saving = true;
  const tmp = `${STATS_FILE}.tmp`;
  fs.promises.writeFile(tmp, data)
    .then(() => fs.promises.rename(tmp, STATS_FILE))
    .catch(() => { /* disk error: the old stats.json stays; the next interval tries again */ })
    .finally(() => { saving = false; });
}

// On shutdown: sync (the process exits right after) and its own temp file, since an
// async save may be writing stats.json.tmp at this very moment
function saveStatsSync() {
  try {
    const tmp = `${STATS_FILE}.exit.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(saveStatsData(), null, 2));
    fs.renameSync(tmp, STATS_FILE);
  } catch (_) {
    // Shutting down anyway; at worst the last minute of stats is lost
  }
}

setInterval(saveStats, 60000);

module.exports = {
  STATS_DIR, stats, userKey, knownUser, userNetwork, uniqueCounts, addDailyUser, noteBareUser, noteSetupDone, todayKey,
  dayRow, countToday, countCode, providerErrorKey, recordError, noteRecent, saveStats,
  saveStatsSync, recentErrors, recentUnknownPaths, recentEmptyStreams, recentUnconfigured,
  recentPlayRejects, recentBadLinks, recentTestFailures,
};
