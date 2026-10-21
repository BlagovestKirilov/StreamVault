/**
 * metrics.js — Prometheus text format for Fly's built-in metrics (fly-metrics.net).
 *
 * Served on a separate internal port (METRICS_PORT, default 9091) that fly.toml's
 * [metrics] section points Fly's scraper at; it is not exposed to the internet.
 * No dependencies: a tiny writer, a request-duration histogram and event-loop
 * delay from node:perf_hooks.
 */

const { monitorEventLoopDelay } = require("node:perf_hooks");

// --- text writer ---
const escapeLabel = (v) => String(v).replaceAll("\\", "\\\\").replaceAll("\n", String.raw`\n`).replaceAll("\"", String.raw`\"`);

function labelText(labels) {
  const parts = Object.entries(labels || {}).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length ? `{${parts.join(",")}}` : "";
}

function createWriter() {
  const lines = [];
  const declared = new Set();
  return {
    /** One sample; HELP/TYPE are written the first time a metric name appears */
    add(name, type, help, value, labels) {
      if (!Number.isFinite(value)) return;
      if (!declared.has(name)) {
        declared.add(name);
        lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      }
      lines.push(`${name}${labelText(labels)} ${value}`);
    },
    raw(text) {
      lines.push(text);
    },
    text: () => lines.join("\n") + "\n",
  };
}

// --- HTTP requests: count + duration histogram per route pattern and status ---
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const MAX_SERIES = 500; // route × status combinations; extra ones go to "other"
const requests = new Map(); // `${route}\u0001${status}` -> count
const durations = new Map(); // route -> { buckets: number[], sum, count }

function observeRequest(route, status, seconds) {
  let key = `${route}\u0001${status}`;
  if (!requests.has(key) && requests.size >= MAX_SERIES) key = `other\u0001${status}`;
  requests.set(key, (requests.get(key) || 0) + 1);

  let h = durations.get(route);
  if (!h) {
    if (durations.size >= MAX_SERIES) return;
    h = { buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
    durations.set(route, h);
  }
  for (let i = 0; i < BUCKETS.length; i++) if (seconds <= BUCKETS[i]) h.buckets[i]++;
  h.sum += seconds;
  h.count++;
}

function writeHttp(w) {
  for (const [key, count] of requests) {
    const [route, status] = key.split("\u0001");
    w.add("streamvault_http_requests_total", "counter", "Responses sent, by route pattern and status code", count, { route, status });
  }
  const name = "streamvault_http_request_duration_seconds";
  if (durations.size) {
    w.raw(`# HELP ${name} Time to answer a request, by route pattern`);
    w.raw(`# TYPE ${name} histogram`);
  }
  for (const [route, h] of durations) {
    BUCKETS.forEach((le, i) => w.raw(`${name}_bucket${labelText({ route, le })} ${h.buckets[i]}`));
    w.raw(`${name}_bucket${labelText({ route, le: "+Inf" })} ${h.count}`);
    w.raw(`${name}_sum${labelText({ route })} ${h.sum}`);
    w.raw(`${name}_count${labelText({ route })} ${h.count}`);
  }
}

// --- event loop delay (how long requests wait for the single JS thread) ---
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

function writeEventLoop(w) {
  const help = "Event loop delay since the previous scrape (seconds)";
  for (const [q, v] of [["0.5", loopDelay.percentile(50)], ["0.99", loopDelay.percentile(99)], ["max", loopDelay.max]]) {
    w.add("streamvault_event_loop_delay_seconds", "gauge", help, v / 1e9, { quantile: q });
  }
  loopDelay.reset(); // per scrape window
}

module.exports = { createWriter, observeRequest, writeHttp, writeEventLoop, BUCKETS };
