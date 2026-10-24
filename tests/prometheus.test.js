// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app } = require("../src/addon");

describe("Prometheus metrics", () => {
  const { buildMetricsText } = require("../src/addon");
  const metrics = require("../src/metrics");

  test("valid text format with memory, caches, today's counters and per-route requests", async () => {
    await request(app).get("/health");
    await request(app).get("/catalog/tv/iptv_live.json");
    const text = buildMetricsText();
    const SAMPLE = /^([a-zA-Z_:][\w:]*)(\{(?:[a-zA-Z_]\w*="(?:[^"\\]|\\.)*",?)*\})? (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|NaN|\+Inf)$/;
    for (const line of text.trim().split("\n")) {
      if (!line.startsWith("#")) expect(line).toMatch(SAMPLE);
    }
    for (const needle of [
      'streamvault_memory_bytes{kind="rss"}', 'streamvault_memory_bytes{kind="heap_used"}',
      "streamvault_cpu_seconds_total", "streamvault_event_loop_delay_seconds",
      'streamvault_cache_entries{cache="m3u"}', "streamvault_downloads_running", "streamvault_stable_links",
      "streamvault_installs_total", 'streamvault_today{counter="dau"}', 'streamvault_today{counter="unconfigured"}',
      'streamvault_http_requests_total{route="GET /health",status="200"}',
      'streamvault_http_request_duration_seconds_bucket{route="GET /health",le="+Inf"}',
    ]) expect(text).toContain(needle);
  });

  test("recent /stats lists are exported with snake_case labels and the event time", async () => {
    await request(app).get("/nothing/here.json").set("User-Agent", 'Odd "Agent"');
    const line = buildMetricsText().split("\n").find(l => l.startsWith("streamvault_recent_unknown_paths{") && l.includes("Odd"));
    expect(line).toContain('method="GET"');
    expect(line).toContain('user_agent="Odd \\"Agent\\""');
    const seconds = Number(line.split(" ").pop());
    expect(Math.abs(seconds - Date.now() / 1000)).toBeLessThan(60);
  });

  test("label values are escaped and histogram buckets are cumulative", () => {
    metrics.observeRequest('GET /x"y\\z', 200, 0.3);
    const w = metrics.createWriter();
    metrics.writeHttp(w);
    const text = w.text();
    expect(text).toContain('route="GET /x\\"y\\\\z"');
    const buckets = text.split("\n").filter(l => l.startsWith('streamvault_http_request_duration_seconds_bucket{route="GET /x'));
    const counts = buckets.map(l => Number(l.split(" ").pop()));
    expect(counts).toEqual([...counts].sort((a, b) => a - b)); // never decreasing
    expect(counts[0]).toBe(0);                                  // 0.3 s isn't <= 0.05
    expect(counts.at(-1)).toBe(1);                              // +Inf has it
  });
});
