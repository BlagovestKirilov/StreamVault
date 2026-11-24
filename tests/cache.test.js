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

    checkMemory(460, () => 460); // above warn (450), below crit (550), still after collecting
    const half = await caches();
    expect(used(half.m3u)).toBe(Math.floor(used(full.m3u) / 2));
    expect(used(half.xtream)).toBe(Math.floor(used(full.xtream) / 2));
    expect(warn.mock.calls.at(-1)[0]).toMatch(/^\[MEM\] heap 460 MB — evicted the oldest half of the M3U and Xtream caches; \d+ MB after collection$/);

    checkMemory(560, () => 560);
    const none = await caches();
    expect([used(none.m3u), used(none.xtream), used(none.accounts), used(none.epg)]).toEqual([0, 0, 0, 0]);
    expect(warn.mock.calls.at(-1)[0]).toMatch(/cleared all caches; \d+ MB after collection$/);

    const before = warn.mock.calls.length;
    checkMemory(300); // healthy: nothing happens, nothing logged
    expect(warn.mock.calls).toHaveLength(before);
  });

  test("over the warning level but mostly garbage: collected, caches kept", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 1, name: "One" }]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 4; i++) {
      await request(app).get(`/${enc({ t: "xtream", s: `http://gc-${i}.example.com`, u: "u", p: "p" })}/catalog/tv/iptv_live.json`);
    }
    const before = used((await caches()).xtream);
    checkMemory(494, () => 26); // the 2026-11-24 readings: 494 MB, 26 MB after collecting
    expect(used((await caches()).xtream)).toBe(before);
    expect(warn.mock.calls.at(-1)[0]).toBe("[MEM] heap 494 MB — garbage collected, 26 MB after; caches kept");
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

  test("a TV guide without programme times is reused for 10 minutes", async () => {
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
    offset = 3.5 * 60 * 1000; // was the old limit: still reused now
    await open();
    expect(epg).toHaveBeenCalledTimes(1);
    offset = 10.5 * 60 * 1000;
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

  test("setups in use are counted once per day per install link, not per network", async () => {
    jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("One"));
    const { stats, todayKey } = require("../src/stats");
    const day = todayKey();
    const before = stats.dailySetups[day]?.size || 0;
    const one = enc({ t: "m3u", m: "http://setups-a.example.com/list.m3u" });
    const two = enc({ t: "m3u", m: "http://setups-b.example.com/list.m3u" });
    await request(app).get(`/${one}/manifest.json`).set("Fly-Client-IP", "198.51.100.81");
    await request(app).get(`/${one}/manifest.json`).set("Fly-Client-IP", "198.51.100.82"); // same setup, other network
    await request(app).get(`/${two}/manifest.json`).set("Fly-Client-IP", "198.51.100.81");
    expect(stats.dailySetups[day].size).toBe(before + 2);
    // one-way codes only: the links themselves are never kept
    expect(JSON.stringify([...stats.dailySetups[day]])).not.toMatch(/setups-a|setups-b/);
  });

  test("a configure-page link with /manifest.json added works as the install link", async () => {
    jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("One"));
    const cfg = enc({ t: "m3u", m: "http://configure-manifest.example.com/list.m3u" });
    const res = await request(app).get(`/${cfg}/configure/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("community.streamvault.addon");
    expect(res.body.behaviorHints.configurationRequired).toBeUndefined();
  });

  test("an install link with an extra /manifest (Nuvio beta) works as the install link", async () => {
    jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("One"));
    const cfg = enc({ t: "m3u", m: "http://nuvio-manifest.example.com/list.m3u" });
    const res = await request(app).get(`/${cfg}/manifest/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("community.streamvault.addon");
    expect(res.body.behaviorHints.configurationRequired).toBeUndefined();
  });

  test("an install link cut off while copying still works", async () => {
    jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("One"));
    const cfg = enc({ t: "m3u", m: "http://cut-link.example.com/list.m3u" });
    for (const path of [`/${cfg}/manifest.jso`, `/${cfg}/manifest.`, `/${cfg}/manifest.jso/manifest.json`, `/${cfg}/manifest./manifest.json`]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe("community.streamvault.addon");
    }
    const res = await request(app).get(`/${cfg}/manifest.jso/catalog/tv/iptv_live.json`);
    expect(res.body.metas.map(m => m.name)).toEqual(["One"]);
    // A subtitle probe next to the link stays a 404
    expect((await request(app).get(`/${cfg}/manifest.srt`)).status).toBe(404);
  });

  test("channel lists asked through that extra /manifest work too", async () => {
    jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("One"));
    const cfg = enc({ t: "m3u", m: "http://nuvio-manifest-catalog.example.com/list.m3u" });
    const res = await request(app).get(`/${cfg}/manifest/catalog/tv/iptv_live.json?x=1`);
    expect(res.status).toBe(200);
    expect(res.body.metas.map(m => m.name)).toEqual(["One"]);
  });

  test("channel pages and play options through an extra /manifest (or a cut-off one) work too", async () => {
    jest.spyOn(m3u, "parseM3U").mockImplementation(async () => playlist("One"));
    const cfg = enc({ t: "m3u", m: "http://nuvio-manifest-meta.example.com/list.m3u" });
    const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;
    const id = metas[0].id;
    for (const prefix of ["manifest", "manifest.jso", "manifest."]) {
      const meta = await request(app).get(`/${cfg}/${prefix}/meta/tv/${encodeURIComponent(id)}.json`);
      expect(meta.status).toBe(200);
      expect(meta.body.meta.name).toBe("One");
      const stream = await request(app).get(`/${cfg}/${prefix}/stream/tv/${encodeURIComponent(id)}.json`);
      expect(stream.status).toBe(200);
      expect(stream.body.streams.length).toBeGreaterThan(0);
    }
    // only a "manifest" part is dropped: anything else before the route stays a 404
    expect((await request(app).get(`/${cfg}/other/meta/tv/${encodeURIComponent(id)}.json`)).status).toBe(404);
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

// ─── Xtream channel lists read as they download (2026-11-21 out-of-memory crash) ───

describe("Xtream channel lists are read channel by channel", () => {
  const { Readable } = require("node:stream");
  const { readLiveStreamList } = require("../src/xtream");
  const { providerErrorKey } = require("../src/stats");
  // A body cut into small pieces, so channels, strings and multi-byte letters are split
  const chunked = (text, size = 7) => {
    const buf = Buffer.from(text);
    const parts = [];
    for (let i = 0; i < buf.length; i += size) parts.push(buf.subarray(i, i + size));
    return Readable.from(parts);
  };
  const channel = (i) => ({
    num: i, name: `Ch ${i} "q" {a} [b] \\ é 😀`, stream_type: "live", stream_id: i, stream_icon: `http://x/${i}.png`,
    epg_channel_id: null, category_id: String(i % 3), tv_archive: i % 2, tv_archive_duration: 3, extra: { nested: [1, { s: "]}" }] },
  });
  const kept = ({ stream_id, name, stream_icon, category_id, tv_archive, tv_archive_duration }) =>
    ({ stream_id, name, stream_icon, category_id, tv_archive, tv_archive_duration });

  test("gives the same channels as reading the whole list, keeping only the fields used", async () => {
    const list = Array.from({ length: 300 }, (_, i) => channel(i));
    for (const size of [1, 7, 64, 100000]) {
      expect(await readLiveStreamList(chunked(JSON.stringify(list), size))).toEqual(list.map(kept));
    }
  });

  test("whatever isn't a JSON array is answered as before", async () => {
    expect(await readLiveStreamList(chunked(""))).toEqual([]);
    expect(await readLiveStreamList(chunked(" [ ] "))).toEqual([]);
    expect(await readLiveStreamList(chunked('{"user_info":{"auth":0}}'))).toEqual({ user_info: { auth: 0 } });
    expect(await readLiveStreamList(chunked("<html>blocked</html>"))).toBe("<html>blocked</html>");
    expect(await readLiveStreamList(chunked('[{"stream_id":1}, {broken}]'))).toEqual([]); // unreadable list = no list
  });

  test("a list over 50 MB is refused with the usual 'too big' error", async () => {
    const huge = Readable.from((function* () { // 51 MB, never held in memory at once
      yield Buffer.from("[");
      const piece = Buffer.from(`${JSON.stringify(channel(1))},`.repeat(500));
      for (let sent = 0; sent < 51 * 1024 * 1024; sent += piece.length) yield piece;
    })());
    const error = await readLiveStreamList(huge).catch(e => e);
    expect(error.message).toMatch(/maxContentLength/);
    expect(providerErrorKey(error)).toBe("too_big");
  });
});

describe("big downloads wait while memory is high", () => {
  const { waitForMemory } = require("../src/cache");
  const { dayRow } = require("../src/stats");
  const MB = 1024 * 1024;
  afterEach(() => jest.restoreAllMocks());

  test("starts at once when memory is normal", async () => {
    jest.spyOn(process, "memoryUsage").mockReturnValue({ heapUsed: 200 * MB, external: 10 * MB, rss: 300 * MB });
    const before = dayRow().memoryWaits || 0;
    const started = Date.now();
    await waitForMemory();
    expect(Date.now() - started).toBeLessThan(100);
    expect(dayRow().memoryWaits || 0).toBe(before);
  });

  test("waits until memory is back under the warning level (heap and Buffers count)", async () => {
    let high = true;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(process, "memoryUsage").mockImplementation(() => (high
      ? { heapUsed: 300 * MB, external: 200 * MB, rss: 800 * MB } // 500 MB in use: over 450
      : { heapUsed: 150 * MB, external: 10 * MB, rss: 600 * MB }));
    const before = dayRow().memoryWaits || 0;
    let done = false;
    const waiting = waitForMemory().then(() => { done = true; });
    await new Promise(r => setTimeout(r, 700));
    expect(done).toBe(false);
    high = false;
    await waiting;
    expect(dayRow().memoryWaits).toBe(before + 1);
  });
});

// ─── Channel budget across the M3U and Xtream caches ───

describe("cached channel lists share a channel budget", () => {
  const { setCappedList, CHANNEL_BUDGET, m3uCache, xtreamCache } = require("../src/cache");
  const xtList = (n) => ({ data: new Array(n).fill({ id: "x" }), ts: Date.now() });
  const m3uList = (n) => ({ data: { channels: new Array(n).fill({}) }, ts: Date.now() });
  beforeEach(() => { m3uCache.clear(); xtreamCache.clear(); });

  test("many small lists all stay", () => {
    for (let i = 0; i < 25; i++) setCappedList(xtreamCache, `x${i}`, xtList(2000), 25);
    for (let i = 0; i < 15; i++) setCappedList(m3uCache, `m${i}`, m3uList(2000), 15);
    expect(xtreamCache.size).toBe(25);
    expect(m3uCache.size).toBe(15);
  });

  test("over the budget the least recently used lists go first, never the new one", () => {
    const big = Math.floor(CHANNEL_BUDGET / 3);
    setCappedList(xtreamCache, "old", xtList(big), 25);
    setCappedList(xtreamCache, "mid", xtList(big), 25);
    setCappedList(m3uCache, "m", m3uList(Math.floor(big / 2)), 15); // counts double
    expect([...xtreamCache.keys()]).toEqual(["old", "mid"]);
    setCappedList(xtreamCache, "new", xtList(big), 25);
    expect([...xtreamCache.keys()]).toEqual(["mid", "new"]);
    expect(m3uCache.has("m")).toBe(true);
  });

  test("a single list bigger than the budget is still kept", () => {
    setCappedList(xtreamCache, "small", xtList(10), 25);
    setCappedList(xtreamCache, "huge", xtList(CHANNEL_BUDGET + 1), 25);
    expect([...xtreamCache.keys()]).toEqual(["huge"]);
  });
});
