// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app } = require("../src/addon");

// ─── Memory safety: shared downloads, no fallback refetch, telemetry ───

describe("memory safety", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("concurrent requests for one playlist share a single download", async () => {
    const spy = jest.spyOn(m3u, "parseM3U").mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      return m3u.parseM3UContent(`#EXTM3U\n#EXTINF:-1 tvg-id="a",A\nhttp://example.com/a.m3u8`);
    });
    const cfg = enc({ t: "m3u", m: "http://dedupe-test.example.com/list.m3u" });
    const results = await Promise.all([
      request(app).get(`/${cfg}/catalog/tv/iptv_live.json`),
      request(app).get(`/${cfg}/meta/tv/iptv_tv_a.json`),
      request(app).get(`/${cfg}/stream/tv/iptv_tv_a.json`),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(results[0].body.metas).toHaveLength(1);
    expect(results[2].body.streams).toHaveLength(1);
  });

  test("Xtream meta for an unknown channel does not refetch the full stream list", async () => {
    const streams = jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 1, name: "One" }]);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    const cfg = enc({ t: "xtream", s: "http://no-refetch.example.com", u: "u", p: "p", c: "" });
    const res = await request(app).get(`/${cfg}/meta/tv/iptv_tv_999.json`);
    expect(res.body.meta.name).toBe("Stream 999");
    expect(streams).toHaveBeenCalledTimes(1); // catalog load only
  });

  test("/stats exposes memory and cache usage", async () => {
    const res = await request(app).get("/stats");
    expect(res.body.memory.heapUsedMB).toBeGreaterThan(0);
    expect(res.body.memory).toHaveProperty("heapPeakMB");
    expect(res.body.caches.m3u).toMatch(/^\d+\/\d+$/);
    expect(res.body.caches).toHaveProperty("inflightDownloads");
  });

  test("refuses to start on Fly without CONFIG_SECRET", () => {
    const { spawnSync } = require("child_process");
    const env = { ...process.env, FLY_APP_NAME: "test" };
    delete env.CONFIG_SECRET;
    const r = spawnSync(process.execPath, ["-e", "require('./addon')"], { cwd: require("path").join(__dirname, "..", "src"), env, encoding: "utf8", timeout: 10000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CONFIG_SECRET is not set");
  });
});

// ─── Memory watchdog ───

describe("memory watchdog", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
  const { checkMemory } = require("../src/addon");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const caches = async () => (await request(app).get("/stats")).body.caches;
  const used = (value) => Number(value.split("/")[0]);
  afterEach(() => jest.restoreAllMocks());

  test("warn level evicts the oldest half of BOTH the M3U and Xtream caches; crit clears all; it logs the heap after collecting", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent("#EXTM3U\n#EXTINF:-1,One\nhttp://example.com/1.m3u8"));
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 1, name: "One" }]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 6; i++) {
      await request(app).get(`/${enc({ t: "m3u", m: `http://wd-${i}.example.com/l.m3u` })}/catalog/tv/iptv_live.json`);
      await request(app).get(`/${enc({ t: "xtream", s: `http://wd-xt-${i}.example.com`, u: "u", p: "p" })}/catalog/tv/iptv_live.json`);
    }
    const full = await caches();
    expect(used(full.m3u)).toBeGreaterThanOrEqual(6);
    expect(used(full.xtream)).toBeGreaterThanOrEqual(6);

    checkMemory(460); // above warn (450), below crit (550)
    const half = await caches();
    expect(used(half.m3u)).toBe(Math.floor(used(full.m3u) / 2));
    expect(used(half.xtream)).toBe(Math.floor(used(full.xtream) / 2));
    expect(warn.mock.calls.at(-1)[0]).toMatch(/^\[MEM\] heap 460 MB — evicted the oldest half of the M3U and Xtream caches; \d+ MB after collection$/);

    checkMemory(560);
    const none = await caches();
    expect([used(none.m3u), used(none.xtream), used(none.accounts), used(none.epg)]).toEqual([0, 0, 0, 0]);
    expect(warn.mock.calls.at(-1)[0]).toMatch(/cleared all caches; \d+ MB after collection$/);

    const before = warn.mock.calls.length;
    checkMemory(300); // healthy: nothing happens, nothing logged
    expect(warn.mock.calls).toHaveLength(before);
  });

  test("a full cache drops the least recently USED list, not the first one added", async () => {
    const parses = {};
    jest.spyOn(m3u, "parseM3U").mockImplementation(async (url) => {
      parses[url] = (parses[url] || 0) + 1;
      return m3u.parseM3UContent("#EXTM3U\n#EXTINF:-1,One\nhttp://example.com/1.m3u8");
    });
    const url = (i) => `http://lru-${i}.example.com/l.m3u`;
    const open = (i) => request(app).get(`/${enc({ t: "m3u", m: url(i) })}/catalog/tv/iptv_live.json`);
    for (let i = 0; i < 15; i++) await open(i); // fills all 15 slots; list 0 was added first
    await open(0);                               // …but is used again
    await open(15);                              // one more list: something has to go
    await open(0);
    expect(parses[url(0)]).toBe(1);              // busy list kept (old rule: thrown out first)
    await open(1);
    expect(parses[url(1)]).toBe(2);              // untouched list 1 was the one removed
  });

  test("cache sizes are back to the proven 15 M3U / 25 Xtream lists", async () => {
    const c = await caches();
    expect(c.m3u.split("/")[1]).toBe("15");
    expect(c.xtream.split("/")[1]).toBe("25");
  });
});

// ─── Global download limit ───

describe("parallel download limit", () => {
  const m3u = require("../src/m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("at most 4 playlist downloads run at once; the rest wait and still finish", async () => {
    let running = 0, peak = 0;
    jest.spyOn(m3u, "parseM3U").mockImplementation(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 60));
      running--;
      return m3u.parseM3UContent(`#EXTM3U\n#EXTINF:-1 tvg-id="x",X\nhttp://example.com/x.m3u8`);
    });
    // 10 different users' playlists at the same moment (different URLs → no sharing)
    const reqs = Array.from({ length: 10 }, (_, i) =>
      request(app).get(`/${enc({ t: "m3u", m: `http://example.com/slots-${i}.m3u` })}/catalog/tv/iptv_live.json`));
    const results = await Promise.all(reqs);

    expect(peak).toBe(4);
    expect(results.every(r => r.body.metas.length === 1)).toBe(true);
    const stats = (await request(app).get("/stats")).body;
    expect(stats.caches.downloadsRunning).toBe("0/4");
    expect(stats.caches.downloadsWaiting).toBe(0);

    // per-day counters: every download, the ones that waited, and the longest wait
    const today = stats.history.find(h => h.date === new Date().toISOString().slice(0, 10));
    expect(today.downloads).toBeGreaterThanOrEqual(10);
    expect(today.downloadsQueued).toBeGreaterThanOrEqual(6);
    expect(today.longestDownloadWaitMs).toBeGreaterThanOrEqual(50);
  });

  test("a failing download frees its slot", async () => {
    jest.spyOn(m3u, "parseM3U").mockRejectedValue(new Error("Request failed with status code 503"));
    const reqs = Array.from({ length: 6 }, (_, i) =>
      request(app).get(`/${enc({ t: "m3u", m: `http://example.com/slots-fail-${i}.m3u` })}/catalog/tv/iptv_live.json`));
    await Promise.all(reqs);
    expect((await request(app).get("/stats")).body.caches.downloadsRunning).toBe("0/4");
  });
});

// ─── Speed: stale-while-refresh, TV guide cache, kept-alive connections ───

describe("speed", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
  const urlguard = require("../src/urlguard");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const playlist = (name) => m3u.parseM3UContent(`#EXTM3U\n#EXTINF:-1,${name}\nhttp://example.com/1.m3u8`);
  let offset = 0;
  beforeEach(() => {
    offset = 0;
    const realNow = Date.now;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  });
  afterEach(() => jest.restoreAllMocks());

  test("an expired playlist is answered at once and refreshed in the background", async () => {
    let version = "Old";
    const parse = jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist(version));
    const cfg = enc({ t: "m3u", m: "http://swr.example.com/list.m3u" });
    const names = async () => (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);

    expect(await names()).toEqual(["Old"]);
    version = "New";
    offset = 11 * 60 * 1000;                 // past the 10-minute TTL
    expect(await names()).toEqual(["Old"]);  // no waiting for the download
    await settle();
    expect(await names()).toEqual(["New"]);  // refreshed copy
    expect(parse).toHaveBeenCalledTimes(2);

    version = "Newest";
    offset = 11 * 60 * 1000 + 61 * 60 * 1000; // older than TTL + stale window
    expect(await names()).toEqual(["Newest"]); // too old to show: waits for a fresh one
  });

  test("a failed background refresh keeps the previous channels", async () => {
    const parse = jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("Kept"));
    const cfg = enc({ t: "m3u", m: "http://swr-fail.example.com/list.m3u" });
    const names = async () => (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);
    expect(await names()).toEqual(["Kept"]);
    parse.mockRejectedValue(new Error("Request failed with status code 503"));
    offset = 11 * 60 * 1000;
    expect(await names()).toEqual(["Kept"]);
    await settle();
    expect(await names()).toEqual(["Kept"]); // not the "Provider not responding" tile
  });

  test("Xtream channel list: same, after 4 hours", async () => {
    let name = "Old";
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    const streams = jest.spyOn(xtream, "getLiveStreams").mockImplementation(async () => [{ stream_id: 1, name }]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const cfg = enc({ t: "xtream", s: "http://swr-xt.example.com", u: "swr", p: "p" });
    const names = async () => (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);
    expect(await names()).toEqual(["Old"]);
    name = "New";
    offset = 4.1 * 60 * 60 * 1000;
    expect(await names()).toEqual(["Old"]);
    await settle();
    expect(await names()).toEqual(["New"]);
    expect(streams).toHaveBeenCalledTimes(2);
  });

  test("the TV guide is reused for 3 minutes", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 7, name: "Seven" }]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const listing = { title: Buffer.from("News").toString("base64"), start: "2026-01-01 10:00:00", end: "2026-01-01 11:00:00" };
    const epg = jest.spyOn(xtream, "getShortEPG").mockResolvedValue([listing]);
    const cfg = enc({ t: "xtream", s: "http://epg-cache.example.com", u: "e", p: "p" });
    const open = async () => (await request(app).get(`/${cfg}/meta/tv/iptv_tv_7.json`)).body.meta.description;

    expect(await open()).toContain("News");
    expect(await open()).toContain("News");
    expect(epg).toHaveBeenCalledTimes(1);
    offset = 3.5 * 60 * 1000;
    await open();
    expect(epg).toHaveBeenCalledTimes(2);
  });

  test("the guide shows only the programme on now and the next one, picked by time", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 9, name: "Nine" }, { stream_id: 10, name: "Ten" }, { stream_id: 11, name: "Eleven" }]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const b64 = (s) => Buffer.from(s).toString("base64");
    const now = Math.floor(Date.now() / 1000);
    const show = (title, from, to) => ({ title: b64(title), start_timestamp: String(now + from * 60), stop_timestamp: String(now + to * 60) });
    const guide = async (id, listings) => {
      xtream.getShortEPG.mockResolvedValue(listings);
      const cfg = enc({ t: "xtream", s: `http://guide-${id}.example.com`, u: "g", p: "p", z: "UTC" });
      return (await request(app).get(`/${cfg}/meta/tv/iptv_tv_${id}.json`)).body.meta.description.split("\n\n")[0];
    };
    jest.spyOn(xtream, "getShortEPG");

    // shuffled, with one that already ended and two later ones
    const lines = (await guide(9, [show("Later", 60, 90), show("Ended", -90, -30), show("Next one", 30, 60), show("On now", -30, 30)])).split("\n");
    expect(lines[0]).toBe("📺 TV Guide:");
    expect(lines[1]).toMatch(/^▶ Now \d\d:\d\d - \d\d:\d\d On now$/);
    expect(lines[2]).toMatch(/^Next \d\d:\d\d - \d\d:\d\d Next one$/);
    expect(lines).toHaveLength(3);

    // nothing on now (gap): only the next one
    expect((await guide(10, [show("Tonight", 45, 90)])).split("\n").slice(1)).toEqual([expect.stringMatching(/^Next .* Tonight$/)]);

    // no timestamps: the first two as sent
    const plain = await guide(11, [{ title: b64("A") }, { title: b64("B") }, { title: b64("C") }]);
    expect(plain.split("\n").slice(1)).toEqual(["▶ Now A", "Next B"]);
  });

  test("a TV guide failure isn't kept", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 8, name: "Eight" }]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const epg = jest.spyOn(xtream, "getShortEPG").mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue([{ title: Buffer.from("Film").toString("base64") }]);
    const cfg = enc({ t: "xtream", s: "http://epg-fail.example.com", u: "e", p: "p" });
    const open = async () => (await request(app).get(`/${cfg}/meta/tv/iptv_tv_8.json`)).body.meta.description;
    expect(await open()).not.toContain("Film");
    expect(await open()).toContain("Film");
    expect(epg).toHaveBeenCalledTimes(2);
  });

  test("saving settings reloads the channel list (at most once per 2 minutes)", async () => {
    let version = "Old";
    const parse = jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist(version));
    const settings = { t: "m3u", m: "http://force-refresh.example.com/list.m3u" };
    const cfg = enc(settings);
    const names = async () => (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);
    const save = () => request(app).post("/api/link").send(settings);

    expect(await names()).toEqual(["Old"]);
    version = "New";
    expect(await names()).toEqual(["Old"]); // still cached
    expect((await save()).status).toBe(200);
    expect(await names()).toEqual(["New"]); // reloaded right after saving
    expect(parse).toHaveBeenCalledTimes(2);

    version = "Newer";
    await save(); // within 2 minutes: no second reload
    expect(await names()).toEqual(["New"]);
    offset = 2.5 * 60 * 1000;
    await save();
    expect(await names()).toEqual(["Newer"]);
    expect(parse).toHaveBeenCalledTimes(3);
  });

  test("saving an Xtream setup reloads its channels and account", async () => {
    let name = "Old";
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getLiveStreams").mockImplementation(async () => [{ stream_id: 1, name }]);
    const info = jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const settings = { t: "xtream", s: "http://force-xt.example.com/", u: "fx", p: "p", c: "" };
    const cfg = enc(settings);
    const names = async () => (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);
    expect(await names()).toEqual(["Old"]);
    name = "New";
    const calls = info.mock.calls.length;
    await request(app).post("/api/link").send(settings);
    expect(await names()).toEqual(["New"]);
    expect(info.mock.calls).toHaveLength(calls + 1); // account read again too
  });

  test("provider connections are kept alive with a short idle timeout", () => {
    for (const agent of Object.values(urlguard.guardedAgents)) {
      expect(agent.keepAlive).toBe(true);
      expect(agent.options.timeout).toBe(4000);
      expect(agent.maxSockets).toBe(16);
    }
  });

  test("a failed background refresh is logged once, however many requests waited on it", async () => {
    const parse = jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("Kept"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = enc({ t: "m3u", m: "http://refresh-log.example.com/list.m3u" });
    const get = () => request(app).get(`/${cfg}/catalog/tv/iptv_live.json`);
    await get();
    let fail;
    parse.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    offset = 11 * 60 * 1000;
    await Promise.all([get(), get(), get(), get()]); // all answered from the old copy
    fail(new Error("Request failed with status code 503"));
    await settle();
    expect(warn.mock.calls.filter(c => String(c[0]).startsWith("[REFRESH]"))).toHaveLength(1);
  });

  test("only new installs are logged", async () => {
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("One"));
    const cfg = enc({ t: "m3u", m: "http://install-log.example.com/list.m3u" });
    const ip = "198.51.100.77";
    await request(app).get(`/${cfg}/manifest.json`).set("Fly-Client-IP", ip);
    await request(app).get(`/${cfg}/manifest.json`).set("Fly-Client-IP", ip);
    const lines = log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("[INSTALL]"));
    expect(lines).toEqual([expect.stringMatching(/NEW install — type: m3u$/)]);
  });

  test("a configure-page link with /manifest.json added works as the install link", async () => {
    jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("One"));
    const cfg = enc({ t: "m3u", m: "http://configure-manifest.example.com/list.m3u" });
    const res = await request(app).get(`/${cfg}/configure/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("community.streamvault.addon");
    expect(res.body.behaviorHints.configurationRequired).toBeUndefined();
  });

  test("a request on a connection the provider already closed is retried once", async () => {
    const reset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const flaky = jest.fn().mockRejectedValueOnce(reset).mockResolvedValue("ok");
    await expect(urlguard.retryOnClosedConnection(flaky)).resolves.toBe("ok");
    expect(flaky).toHaveBeenCalledTimes(2);

    const down = jest.fn().mockRejectedValue(reset);
    await expect(urlguard.retryOnClosedConnection(down)).rejects.toBe(reset);
    expect(down).toHaveBeenCalledTimes(2); // only one retry

    const timeout = Object.assign(new Error("timeout"), { code: "ECONNABORTED" });
    const slow = jest.fn().mockRejectedValue(timeout);
    await expect(urlguard.retryOnClosedConnection(slow)).rejects.toBe(timeout);
    expect(slow).toHaveBeenCalledTimes(1); // other errors aren't retried
  });
});
