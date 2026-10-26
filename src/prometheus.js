/**
 * prometheus.js — The /metrics text for Fly's Grafana (served on METRICS_PORT,
 * not public): process, caches, downloads, all-time and today's counters, and
 * the recent lists, as Prometheus gauges/counters.
 */

const fs = require("node:fs");
const metrics = require("./metrics");
const {
  STATS_DIR, stats, todayKey, recentErrors, recentUnknownPaths, recentEmptyStreams, recentUnconfigured,
  recentPlayRejects, recentBadLinks, recentTestFailures,
} = require("./stats");
const {
  m3uCache, M3U_CACHE_MAX, xtreamCache, XTREAM_CACHE_MAX, EPG_CACHE_MAX, epgCache, accountCache,
  inflight, MAX_PARALLEL_DOWNLOADS, downloadsRunningNow, downloadQueue, failCache, HEAP_WARN_MB,
  HEAP_CRIT_MB, memStats,
} = require("./cache");

// --- Metrics (Prometheus text) for Fly's built-in Grafana ---
// Same numbers as /stats, as gauges/counters Grafana can graph over time.
// Parts that live in addon.js are passed in: linkStore, genresCache, GENRES_CACHE_MAX
function buildMetricsText({ linkStore, genresCache, GENRES_CACHE_MAX }) {
  const w = metrics.createWriter();
  const g = (name, help, value, labels) => w.add(`streamvault_${name}`, "gauge", help, value, labels);
  const c = (name, help, value, labels) => w.add(`streamvault_${name}`, "counter", help, value, labels);

  // Process: memory, CPU, uptime, event loop
  const mem = process.memoryUsage();
  const heapLimit = require("node:v8").getHeapStatistics().heap_size_limit;
  g("memory_bytes", "Process memory", mem.rss, { kind: "rss" });
  g("memory_bytes", "Process memory", mem.heapUsed, { kind: "heap_used" });
  g("memory_bytes", "Process memory", mem.heapTotal, { kind: "heap_total" });
  g("memory_bytes", "Process memory", mem.external, { kind: "external" });
  g("memory_bytes", "Process memory", heapLimit, { kind: "heap_limit" });
  g("memory_threshold_bytes", "Heap watchdog thresholds", HEAP_WARN_MB * 1024 * 1024, { level: "warn" });
  g("memory_threshold_bytes", "Heap watchdog thresholds", HEAP_CRIT_MB * 1024 * 1024, { level: "crit" });
  c("memory_evictions_total", "Cache evictions by the heap watchdog", memStats.warnEvictions, { level: "warn" });
  c("memory_evictions_total", "Cache evictions by the heap watchdog", memStats.critEvictions, { level: "crit" });
  const cpu = process.cpuUsage();
  c("cpu_seconds_total", "CPU time used by the process", cpu.user / 1e6, { mode: "user" });
  c("cpu_seconds_total", "CPU time used by the process", cpu.system / 1e6, { mode: "system" });
  g("uptime_seconds", "Seconds since the process started", process.uptime());
  metrics.writeEventLoop(w);

  // Caches and downloads
  const cache = (name, size, max) => {
    g("cache_entries", "Entries in each in-memory cache", size, { cache: name });
    if (max) g("cache_capacity", "Maximum entries per cache", max, { cache: name });
  };
  cache("m3u", m3uCache.size, M3U_CACHE_MAX);
  cache("xtream", xtreamCache.size, XTREAM_CACHE_MAX);
  cache("accounts", accountCache.size, XTREAM_CACHE_MAX);
  cache("epg", epgCache.size, EPG_CACHE_MAX);
  cache("genres", genresCache.size, GENRES_CACHE_MAX);
  g("failed_providers", "Providers in the 2-minute failure cache", [...failCache.values()].filter(f => f.until > Date.now()).length);
  g("downloads_running", "Big provider downloads running now", downloadsRunningNow());
  g("downloads_capacity", "Big provider downloads allowed at once", MAX_PARALLEL_DOWNLOADS);
  g("downloads_waiting", "Big provider downloads waiting for a slot", downloadQueue.length);
  g("inflight_loads", "Shared in-flight loads (once())", inflight.size);
  g("stable_links", "Saved stable install links + edited old links (links.json)", linkStore.size());
  writeVolumeMetrics(g);

  // All-time usage (from stats.json, survives restarts)
  c("installs_total", "Installs (new users) since the start", stats.installs);
  c("configures_total", "Configure page visits since the start", stats.configures);
  c("reconfigures_total", "Configure opened from an installed StreamVault (all time)", stats.reconfigures);
  c("reinstalls_total", "Save changes pressed on the configure page (all time)", stats.reinstalls);
  for (const [from, n] of Object.entries(stats.kofiClicks)) {
    c("kofi_clicks_total", "Clicks on the Ko-fi link (all time, every click), by where", n, { from });
  }
  c("streams_total", "Stream requests since the start", stats.streams);
  c("searches_total", "Searches since the start", stats.searches);
  g("unique_users", "Unique users since the start", stats.users.size);
  for (const [type, n] of Object.entries(stats.streamsByType || {})) {
    c("streams_by_type_total", "Stream requests by type since the start", n, { type });
  }

  writeTodayMetrics(g);
  writeRecentMetrics(g);

  metrics.writeHttp(w);
  return w.text();
}

// Today (UTC) — every daily counter, the provider errors and our error responses
// Disk usage of the data folder (the /data volume on Fly): Fly doesn't export volume
// metrics for this app, so the server measures it itself. Skipped if it can't be read.
function writeVolumeMetrics(g) {
  let disk;
  try {
    disk = fs.statfsSync(STATS_DIR);
  } catch (_) {
    return; // no statfs on this system: the panel just stays empty
  }
  const help = "Disk space of the data folder (stats.json, links.json)";
  const total = disk.blocks * disk.bsize;
  const available = disk.bavail * disk.bsize;
  g("volume_bytes", help, total, { kind: "total" });
  g("volume_bytes", help, (disk.blocks - disk.bfree) * disk.bsize, { kind: "used" });
  g("volume_bytes", help, available, { kind: "available" });
}

function writeTodayMetrics(g) {
  const today = todayKey();
  const row = stats.history[today] || {};
  g("today", "Today's (UTC) daily counters, as in /stats history", stats.dailyActive[today]?.size || 0, { counter: "dau" });
  g("today", "Today's (UTC) daily counters, as in /stats history", stats.dailyViewers[today]?.size || 0, { counter: "viewers" });
  g("today", "Today's (UTC) daily counters, as in /stats history", stats.dailyBare[today]?.size || 0, { counter: "bareUsers" });
  for (const [counter, value] of Object.entries(row)) {
    if (typeof value === "number" && !["dau", "viewers", "bareUsers"].includes(counter)) g("today", "Today's (UTC) daily counters, as in /stats history", value, { counter });
  }
  for (const [where, codes] of Object.entries(row.providerErrors || {})) {
    for (const [code, n] of Object.entries(codes)) {
      g("today_provider_errors", "Today's provider failures by where and status/kind", n, { where, code });
    }
  }
  for (const [endpoint, codes] of Object.entries(row.responseErrors || {})) {
    for (const [status, n] of Object.entries(codes)) {
      g("today_response_errors", "Today's error responses we sent, by endpoint and status", n, { endpoint, status });
    }
  }
}

// Recent events (same masked lists as /stats, newest 20 each): one series per
// entry, fields as labels, value = event time — Grafana shows them as tables
function writeRecentMetrics(g) {
  const recentLists = {
    recent_errors: recentErrors,
    recent_test_failures: recentTestFailures,
    recent_bad_links: recentBadLinks,
    recent_play_rejects: recentPlayRejects,
    recent_empty_streams: recentEmptyStreams,
    recent_unknown_paths: recentUnknownPaths,
    recent_unconfigured: recentUnconfigured,
  };
  for (const [name, list] of Object.entries(recentLists)) {
    const help = `Latest ${name.replaceAll("_", " ")} as in /stats (value = event time, unix seconds)`;
    for (const entry of list) g(name, help, Date.parse(entry.at) / 1000, entryLabels(entry));
  }
}

// { userAgent: "x", missing: null } → { user_agent: "x" } (values capped at 200 chars)
function entryLabels(entry) {
  const labels = {};
  for (const [key, value] of Object.entries(entry)) {
    if (value != null) labels[key.replaceAll(/[A-Z]/g, (ch) => "_" + ch.toLowerCase())] = String(value).slice(0, 200);
  }
  return labels;
}

module.exports = { buildMetricsText };
