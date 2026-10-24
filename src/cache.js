/**
 * cache.js — In-memory caches (playlists, Xtream lists, accounts, TV guide) in
 * least-recently-used order, stale-while-refresh, shared in-flight loads, the
 * provider download slots, the failure cache, and the memory watchdog.
 */

const m3u = require("./m3u");
const { safeError } = require("./util");
const { countToday, dayRow, recordError } = require("./stats");

// --- In-memory caches ---
const m3uCache = new Map();
const M3U_CACHE_TTL = 10 * 60 * 1000;
// A full (10k-channel cap) playlist ≈ 2–5 MB parsed, ~1.5× that with its sorted
// catalog + merged view. 15 is proven (heap peaked ~125 MB); 40 (with Xtream at 50)
// drove the heap to 591 MB and 43 clear-all evictions in one evening (2026-10-22)
const M3U_CACHE_MAX = 15;
const xtreamCache = new Map();
const XTREAM_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours
// Xtream lists have no channel cap (big panels: 30k+ channels) — keep this small
const XTREAM_CACHE_MAX = 25;
// Account info (expiry date) is one tiny request: re-read often so a renewal
// clears the expiry notice quickly, and retry a failed lookup after a few minutes
const ACCOUNT_CACHE_TTL = 30 * 60 * 1000;
const ACCOUNT_RETRY_MS = 3 * 60 * 1000;
// After its TTL an entry is still answered at once for this long while one
// background load refreshes it (usableEntry), so users don't wait for re-downloads
const M3U_STALE_MS = 50 * 60 * 1000;
const XTREAM_STALE_MS = 4 * 60 * 60 * 1000;
const ACCOUNT_STALE_MS = 6 * 60 * 60 * 1000;
// TV guide per channel, briefly: reopening a channel page (apps often ask twice)
// doesn't wait for the provider again. Keyed by panel + stream, not the user.
const EPG_CACHE_TTL = 3 * 60 * 1000;
const EPG_CACHE_MAX = 1000;
const epgCache = new Map();
// Xtream account info (expiry) per login — see getXtreamAccount in addon.js
const accountCache = new Map();

// Caches are kept in least-recently-used order (a Map keeps insertion order):
// storing an entry or using it (touch) moves it to the end, so when a cache is
// full the entry nobody used for the longest goes first — not a busy one that
// happened to be added early.
function setCapped(cache, key, value, max) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > max) {
    cache.delete(cache.keys().next().value); // least recently used
  }
}

// A cache read that counts as a use (moves the entry to the end)
function touch(cache, key) {
  const entry = cache.get(key);
  if (entry !== undefined) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

// Concurrent cache misses for the same key share one download instead of each
// fetching + parsing it (catalog/meta/stream/manifest often arrive together)
const inflight = new Map();

function once(key, load) {
  if (inflight.has(key)) return inflight.get(key);
  const p = load().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// At most this many large provider downloads (whole playlists / full Xtream
// channel lists) run at the same time across all users; the rest wait their
// turn. Per-IP limits can't stop many users downloading at once on 1 shared CPU.
const MAX_PARALLEL_DOWNLOADS = 4;
let downloadsRunning = 0;
const downloadsRunningNow = () => downloadsRunning; // live value for /stats and /metrics
const downloadQueue = []; // resolve callbacks of waiting downloads, in order

async function withDownloadSlot(download) {
  countToday("downloads");
  if (downloadsRunning >= MAX_PARALLEL_DOWNLOADS) {
    // All slots busy: count it and how long this one waited (stats history)
    countToday("downloadsQueued");
    const waitStart = Date.now();
    await new Promise(resolve => downloadQueue.push(resolve));
    const row = dayRow();
    row.longestDownloadWaitMs = Math.max(row.longestDownloadWaitMs || 0, Date.now() - waitStart);
  } else {
    downloadsRunning++;
  }
  try {
    return await download();
  } finally {
    // Hand the slot straight to the next waiter (running count unchanged), or free it
    const next = downloadQueue.shift();
    if (next) next();
    else downloadsRunning--;
  }
}

// Negative cache: a provider that just failed (down, refusing, timing out) is not
// asked again for FAIL_TTL — requests in that window fail at once with the same
// error. Without it every catalog/channel page of a dead provider re-downloaded
// (one day: 171× "521" from a single down server), each holding a download slot.
const FAIL_TTL = 2 * 60 * 1000;
const FAIL_CACHE_MAX = 500;
const failCache = new Map(); // key -> { message, until }

async function withFailureCache(key, load) {
  const failed = failCache.get(key);
  if (failed?.until > Date.now()) {
    // Answered from memory: the provider was NOT contacted. Marked so handlers
    // don't log/count it as another provider failure (one app opening 57
    // channel pages of a dead provider used to log 57 errors).
    failed.repeats++;
    const err = new Error(failed.message);
    err.fromFailureCache = true;
    throw err;
  }
  if (failed?.repeats > 0) {
    console.log(`[FAILCACHE] ${failed.repeats} more request(s) were answered from cache after: ${safeError(failed)}`);
  }
  try {
    const data = await load();
    failCache.delete(key);
    return data;
  } catch (e) {
    // Only the message is kept (the original error can hold request details)
    setCapped(failCache, key, { message: e?.message || "Unknown error", until: Date.now() + FAIL_TTL, repeats: 0 }, FAIL_CACHE_MAX);
    throw e;
  }
}

// Requests that waited for the same download (once()) all get the same error
// object: the provider was contacted once, so the failure is counted once
const reportedErrors = new WeakSet();

// Catalog/meta/stream handlers: log + count a real provider failure, or just
// count a repeat (answered from the failure cache, or a shared download)
function handleProviderError(where, req, e) {
  const shared = e !== null && typeof e === "object";
  if (e?.fromFailureCache || (shared && reportedErrors.has(e))) {
    countToday("cachedFailures");
    return;
  }
  if (shared) reportedErrors.add(e);
  console.error(`${where[0].toUpperCase()}${where.slice(1)} error:`, e.message);
  recordError(where, req.userConfig, e);
}

// Cache entry → fresh: use it. Expired but within `staleFor`: use it anyway and
// refresh it in the background (once() keeps that to one load, download slots
// and the failure cache still apply), so nobody waits for a re-download; a failed
// refresh keeps the old copy. Older or missing: null — the caller loads and waits.
const reportedRefreshErrors = new WeakSet();
function usableEntry(entry, ttl, staleFor, refresh) {
  if (!entry) return null;
  const age = Date.now() - entry.ts;
  if (age < ttl) return entry;
  if (age >= ttl + staleFor) return null;
  refresh().catch((e) => {
    // Requests sharing one refresh (once()) get the same error object: log it once
    if (e?.fromFailureCache || reportedRefreshErrors.has(e)) return;
    if (e !== null && typeof e === "object") reportedRefreshErrors.add(e);
    console.warn(`[REFRESH] kept the previous copy: ${safeError(e)}`);
  });
  return entry;
}

// Same playlist with a different group selection is a different (smaller) entry
function m3uCacheKey(config) {
  const groups = config.groups || [];
  return groups.length ? `${config.url}\u0001${groups.join("\u0001")}` : config.url;
}

async function getCachedM3U(config) {
  const groups = config.groups || [];
  const key = m3uCacheKey(config);
  const load = () => once(`m3u:${key}`, () => withFailureCache(`m3u:${key}`, async () => {
    const data = await withDownloadSlot(() => m3u.parseM3U(config.url, groups));
    setCapped(m3uCache, key, { data, ts: Date.now() }, M3U_CACHE_MAX);
    return data;
  }));
  const cached = usableEntry(touch(m3uCache, key), M3U_CACHE_TTL, M3U_STALE_MS, load);
  return cached ? cached.data : load();
}

// --- Cache eviction (runs every 10 min) ---
setInterval(() => {
  const now = Date.now();
  // Entries stay usable (stale) for a while after their TTL — see usableEntry
  for (const [key, val] of m3uCache) {
    if (now - val.ts > M3U_CACHE_TTL + M3U_STALE_MS) m3uCache.delete(key);
  }
  for (const [key, val] of xtreamCache) {
    if (now - val.ts > XTREAM_CACHE_TTL + XTREAM_STALE_MS) xtreamCache.delete(key);
  }
  for (const [key, val] of accountCache) {
    if (now - val.ts > ACCOUNT_CACHE_TTL + ACCOUNT_STALE_MS) accountCache.delete(key);
  }
  for (const [key, val] of epgCache) {
    if (now - val.ts > EPG_CACHE_TTL) epgCache.delete(key);
  }
}, 10 * 60 * 1000);

// --- Memory pressure eviction (runs every 10s) ---
// Thresholds sit below the --max-old-space-size=640 ceiling (see fly.toml) so
// the safety net clears caches with headroom to spare before the hard cap.
const HEAP_WARN_MB = 450;
const HEAP_CRIT_MB = 550;
// Surfaced in /stats so cache sizes can be tuned from real numbers (since last restart)
const memStats = { heapPeakMB: 0, rssPeakMB: 0, warnEvictions: 0, critEvictions: 0, lastEviction: null };
// After evicting, collect garbage at once so the next check sees the real heap:
// without it heapUsed stays high until V8 collects on its own, and the watchdog
// kept clearing every cache every 10 s for minutes. Enabled at runtime (no
// startup flag: a flag Node rejected would stop the server from starting).
const collectGarbage = (() => {
  try {
    require("node:v8").setFlagsFromString("--expose-gc");
    return require("node:vm").runInNewContext("gc");
  } catch (e) {
    console.warn(`[MEM] manual GC unavailable (${e.message}) — the watchdog relies on V8's own collection`);
    return null;
  }
})();

// Least recently used half of a cache (see setCapped/touch)
function evictOldestHalf(cache) {
  const keys = [...cache.keys()];
  keys.slice(0, Math.ceil(keys.length / 2)).forEach(k => cache.delete(k));
}

setInterval(() => {
  const { heapUsed, rss } = process.memoryUsage();
  memStats.rssPeakMB = Math.max(memStats.rssPeakMB, Math.round(rss / 1024 / 1024));
  checkMemory(heapUsed / 1024 / 1024);
}, 10 * 1000);

// Watchdog step for a measured heap size (MB)
function checkMemory(mb) {
  memStats.heapPeakMB = Math.max(memStats.heapPeakMB, Math.round(mb));
  if (mb > HEAP_CRIT_MB) {
    m3uCache.clear();
    xtreamCache.clear();
    accountCache.clear();
    epgCache.clear();
    memStats.critEvictions++;
  } else if (mb > HEAP_WARN_MB) {
    // Both big caches: Xtream lists are uncapped and can be the larger part
    evictOldestHalf(m3uCache);
    evictOldestHalf(xtreamCache);
    memStats.warnEvictions++;
  } else {
    return;
  }
  memStats.lastEviction = new Date().toISOString();
  collectGarbage?.();
  const after = process.memoryUsage().heapUsed / 1024 / 1024;
  const what = mb > HEAP_CRIT_MB ? "cleared all caches" : "evicted the oldest half of the M3U and Xtream caches";
  console.warn(`[MEM] heap ${mb.toFixed(0)} MB — ${what}; ${after.toFixed(0)} MB after collection`);
}

module.exports = {
  m3uCache, M3U_CACHE_MAX, xtreamCache, XTREAM_CACHE_TTL, XTREAM_CACHE_MAX, ACCOUNT_CACHE_TTL,
  ACCOUNT_RETRY_MS, XTREAM_STALE_MS, ACCOUNT_STALE_MS, EPG_CACHE_TTL, EPG_CACHE_MAX, epgCache,
  accountCache, setCapped, touch, inflight, once, MAX_PARALLEL_DOWNLOADS, downloadsRunningNow,
  downloadQueue, withDownloadSlot, failCache, withFailureCache, handleProviderError, usableEntry,
  m3uCacheKey, getCachedM3U, HEAP_WARN_MB, HEAP_CRIT_MB, memStats, checkMemory,
};
