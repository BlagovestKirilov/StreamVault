// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app, parseConfigPath, parseExtra, makePosterUrl, encryptConfig, decryptConfig, isPrivateIp, validateExternalUrl, safeError, formatAccountInfo, epgTimeRange } = require("../addon");
const { parseM3UContent } = require("../m3u");

// ─── parseConfigPath ───

describe("parseConfigPath", () => {
  test("decodes base64url xtream config", () => {
    const config = { t: "xtream", s: "http://example.com:8080", u: "user1", p: "pass1", c: "5" };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = parseConfigPath(encoded);
    expect(result.type).toBe("xtream");
    expect(result.server).toBe("http://example.com:8080");
    expect(result.username).toBe("user1");
    expect(result.password).toBe("pass1");
    expect(result.country).toBe("5");
  });

  test("decodes base64url m3u config", () => {
    const config = { t: "m3u", m: "http://example.com/playlist.m3u", c: "" };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = parseConfigPath(encoded);
    expect(result.type).toBe("m3u");
    expect(result.url).toBe("http://example.com/playlist.m3u");
  });

  test("decodes legacy URL-encoded xtream config", () => {
    const configStr = "sourceType=xtream&server=http%3A%2F%2Fexample.com&username=user1&password=pass1&country=5";
    const result = parseConfigPath(configStr);
    expect(result.type).toBe("xtream");
    expect(result.server).toBe("http://example.com");
    expect(result.username).toBe("user1");
    expect(result.password).toBe("pass1");
  });

  test("decodes legacy URL-encoded m3u config", () => {
    const configStr = "sourceType=m3u&m3uUrl=http%3A%2F%2Fexample.com%2Fplaylist.m3u";
    const result = parseConfigPath(configStr);
    expect(result.type).toBe("m3u");
    expect(result.url).toBe("http://example.com/playlist.m3u");
  });

  test("rejects garbage base64 that doesn't start with 'ey'", () => {
    const result = parseConfigPath("favicon");
    // Should fall through to legacy and return m3u with empty url
    expect(result.type).toBe("m3u");
    expect(result.url).toBe("");
  });

  test("decodes encrypted xtream config", () => {
    const config = { t: "xtream", s: "http://example.com:8080", u: "user1", p: "pass1", c: "5" };
    const encrypted = "e-" + encryptConfig(config);
    const result = parseConfigPath(encrypted);
    expect(result.type).toBe("xtream");
    expect(result.server).toBe("http://example.com:8080");
    expect(result.username).toBe("user1");
    expect(result.password).toBe("pass1");
  });

  test("decodes encrypted m3u config", () => {
    const config = { t: "m3u", m: "http://example.com/list.m3u", c: "" };
    const encrypted = "e-" + encryptConfig(config);
    const result = parseConfigPath(encrypted);
    expect(result.type).toBe("m3u");
    expect(result.url).toBe("http://example.com/list.m3u");
  });
});

// ─── parseExtra ───

describe("parseExtra", () => {
  test("parses search parameter", () => {
    const result = parseExtra("search=hello%20world");
    expect(result.search).toBe("hello world");
  });

  test("parses skip parameter", () => {
    const result = parseExtra("skip=100");
    expect(result.skip).toBe("100");
  });

  test("parses multiple parameters", () => {
    const result = parseExtra("search=test&skip=50");
    expect(result.search).toBe("test");
    expect(result.skip).toBe("50");
  });

  test("strips .json suffix", () => {
    const result = parseExtra("search=test.json");
    expect(result.search).toBe("test");
  });
});

// ─── makePosterUrl ───

describe("makePosterUrl", () => {
  test("returns a valid URL", () => {
    const url = makePosterUrl("Test Channel");
    expect(url).toContain("ui-avatars.com");
    expect(url).toContain("Test%20Channel");
  });

  test("truncates long names to 30 chars", () => {
    const longName = "A".repeat(50);
    const url = makePosterUrl(longName);
    expect(url).toContain("A".repeat(30));
    expect(url).not.toContain("A".repeat(31));
  });
});

// ─── M3U parser ───

describe("parseM3UContent", () => {
  test("parses valid M3U content", () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-id="ch1" tvg-name="Channel 1" tvg-logo="http://logo.png" group-title="News",Channel 1
http://stream1.example.com/live.m3u8
#EXTINF:-1 tvg-id="ch2" tvg-name="Channel 2" group-title="Sports",Channel 2
http://stream2.example.com/live.m3u8`;

    const { channels, categories } = parseM3UContent(content);
    expect(channels).toHaveLength(2);
    expect(channels[0].name).toBe("Channel 1");
    expect(channels[0].logo).toBe("http://logo.png");
    expect(channels[0].group).toBe("News");
    expect(channels[0].url).toBe("http://stream1.example.com/live.m3u8");
    expect(channels[1].name).toBe("Channel 2");
    expect(channels[1].group).toBe("Sports");
    expect(Object.keys(categories)).toHaveLength(2);
    expect(categories["News"]).toHaveLength(1);
    expect(categories["Sports"]).toHaveLength(1);
  });

  test("handles empty content", () => {
    const { channels } = parseM3UContent("");
    expect(channels).toHaveLength(0);
  });

  test("handles missing group-title", () => {
    const content = `#EXTM3U
#EXTINF:-1,No Group Channel
http://stream.example.com/live.m3u8`;
    const { channels } = parseM3UContent(content);
    expect(channels).toHaveLength(1);
    expect(channels[0].group).toBe("Uncategorized");
  });

  test("detects VOD by file extension", () => {
    const content = `#EXTM3U
#EXTINF:-1,Movie Title
http://example.com/movie.mp4`;
    const { channels } = parseM3UContent(content);
    expect(channels[0].type).toBe("movie");
  });

  test("detects series by group title", () => {
    const content = `#EXTM3U
#EXTINF:-1 group-title="Series",My Show S01E01
http://example.com/show.m3u8`;
    const { channels } = parseM3UContent(content);
    expect(channels[0].type).toBe("series");
  });

  test("gives entries sharing a tvg-id unique ids, first keeps the bare id", () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-id="btv.bg",bTV HD
http://example.com/btv_hd.m3u8
#EXTINF:-1 tvg-id="btv.bg",bTV FHD
http://example.com/btv_fhd.m3u8
#EXTINF:-1 tvg-id="btv.bg",bTV UHD
http://example.com/btv_uhd.m3u8`;
    const { channels } = parseM3UContent(content);
    expect(channels.map(c => c.id)).toEqual(["btv.bg", "btv.bg_v2", "btv.bg_v3"]);
    expect(channels.every(c => c.tvgId === "btv.bg")).toBe(true);
  });

  test("captures #EXTVLCOPT headers for the next entry only", () => {
    const content = `#EXTM3U
#EXTINF:-1,Channel A
#EXTVLCOPT:http-user-agent=MyAgent/1.0
#EXTVLCOPT:http-referrer=http://ref.example.com/
#EXTVLCOPT:network-caching=1000
http://example.com/a.m3u8
#EXTINF:-1,Channel B
http://example.com/b.m3u8`;
    const { channels } = parseM3UContent(content);
    expect(channels[0].headers).toEqual({ "User-Agent": "MyAgent/1.0", Referer: "http://ref.example.com/" });
    expect(channels[1].headers).toBeUndefined();
  });

  test("captures #EXTHTTP JSON headers", () => {
    const content = `#EXTM3U
#EXTINF:-1,Channel A
#EXTHTTP:{"User-Agent":"Agent","Referer":"http://r.example.com"}
http://example.com/a.m3u8`;
    const { channels } = parseM3UContent(content);
    expect(channels[0].headers).toEqual({ "User-Agent": "Agent", Referer: "http://r.example.com" });
  });

  test("splits Kodi-style pipe headers off the URL", () => {
    const content = `#EXTM3U
#EXTINF:-1,Channel A
http://example.com/a.m3u8|User-Agent=Agent%2F2&Referer=http://r.example.com`;
    const { channels } = parseM3UContent(content);
    expect(channels[0].url).toBe("http://example.com/a.m3u8");
    expect(channels[0].headers).toEqual({ "User-Agent": "Agent/2", Referer: "http://r.example.com" });
  });

  test("ignores header values containing line breaks", () => {
    const content = `#EXTM3U
#EXTINF:-1,Channel A
#EXTHTTP:{"User-Agent":"bad\\r\\nX-Injected: 1"}
http://example.com/a.m3u8`;
    const { channels } = parseM3UContent(content);
    expect(channels[0].headers).toBeUndefined();
  });
});

// ─── M3U streams (variants + labels + headers) ───

describe("M3U stream handler", () => {
  const m3u = require("../m3u");
  const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="btv.bg" group-title="BG",bTV HD
http://example.com/btv_hd.m3u8
#EXTINF:-1 tvg-id="btv.bg" group-title="BG",bTV FHD
#EXTVLCOPT:http-user-agent=Agent
http://example.com/btv_fhd.ts`;
  const configPath = () => Buffer.from(JSON.stringify({ t: "m3u", m: "http://playlist.example.com/list.m3u" }))
    .toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  beforeEach(() => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(playlist));
  });
  afterEach(() => jest.restoreAllMocks());

  test("returns the picked channel first, then its quality variants, labelled", async () => {
    const res = await request(app).get(`/${configPath()}/stream/tv/iptv_tv_btv.bg_v2.json`);
    expect(res.status).toBe(200);
    const { streams } = res.body;
    expect(streams.map(s => s.url)).toEqual(["http://example.com/btv_fhd.ts", "http://example.com/btv_hd.m3u8"]);
    expect(streams[0].name).toBe("StreamVault\nTS");
    expect(streams[0].title).toBe("bTV FHD\nBG");
    expect(streams[0].behaviorHints.proxyHeaders).toEqual({ request: { "User-Agent": "Agent" } });
    expect(streams[1].name).toBe("StreamVault\nHLS");
    expect(streams[1].behaviorHints.proxyHeaders).toBeUndefined();
  });

  test("a saved duplicate id (_v3) that no longer exists falls back to the channel", async () => {
    const res = await request(app).get(`/${configPath()}/stream/tv/iptv_tv_btv.bg_v3.json`);
    expect(res.body.streams[0].url).toBe("http://example.com/btv_hd.m3u8");
  });
});

// ─── Category (genre) filter ───

describe("category filter", () => {
  const m3u = require("../m3u");
  const xtream = require("../xtream");
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("M3U: manifest lists playlist groups, catalog filters by genre", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 group-title="Sports & News",Diema Sport
http://example.com/1.m3u8
#EXTINF:-1 group-title="Bulgaria",bTV
http://example.com/2.m3u8
#EXTINF:-1 group-title="Sports & News",Ring
http://example.com/3.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://genre-test.example.com/list.m3u" });

    const man = await request(app).get(`/${cfg}/manifest.json`);
    const genre = man.body.catalogs[0].extra.find(e => e.name === "genre");
    expect(genre.options).toEqual(["Sports & News", "Bulgaria"]);

    const cat = await request(app).get(`/${cfg}/catalog/tv/iptv_live/genre=${encodeURIComponent("Sports & News")}.json`);
    expect(cat.body.metas.map(m => m.name)).toEqual(["Diema Sport", "Ring"]);
  });

  test("Xtream: category names become genre options", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([
      { category_id: "1", category_name: "BG | Sport" },
      { category_id: "2", category_name: "BG | Kids" },
    ]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([
      { stream_id: 10, name: "Diema Sport", category_id: "1" },
      { stream_id: 11, name: "Nickelodeon", category_id: 2 },
    ]);
    const cfg = enc({ t: "xtream", s: "http://genre-xtream.example.com", u: "u", p: "p", c: "" });

    const man = await request(app).get(`/${cfg}/manifest.json`);
    const genre = man.body.catalogs[0].extra.find(e => e.name === "genre");
    expect(genre.options).toEqual(["BG | Sport", "BG | Kids"]);

    const cat = await request(app).get(`/${cfg}/catalog/tv/iptv_live/genre=${encodeURIComponent("BG | Kids")}.json`);
    expect(cat.body.metas.map(m => m.name)).toEqual(["Nickelodeon"]);
  });

  test("empty and set-up installs are told apart by their description", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1,One
http://example.com/1.m3u8`));
    const bare = await request(app).get("/manifest.json");
    expect(bare.body.description).toMatch(/^Not connected yet/);
    expect(bare.body.description).toBe("Not connected yet. Open Configure to add your Xtream Codes account or M3U playlist. Already have a connected StreamVault? Delete this one.");
    const m3uMan = await request(app).get(`/${enc({ t: "m3u", m: "http://desc.example.com/list.m3u" })}/manifest.json`);
    expect(m3uMan.body.description).toBe("✓ Connected to your M3U playlist. If another StreamVault only shows “Set up StreamVault first”, delete that one.");
    expect(m3uMan.body.name).toBe(bare.body.name); // same name keeps listings unchanged
  });

  test("single group → no genre dropdown", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1,Only Channel
http://example.com/1.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://genre-single.example.com/list.m3u" });
    const man = await request(app).get(`/${cfg}/manifest.json`);
    expect(man.body.catalogs[0].extra.map(e => e.name)).toEqual(["search", "skip"]);
  });
});

// ─── Memory safety: shared downloads, no fallback refetch, telemetry ───

describe("memory safety", () => {
  const m3u = require("../m3u");
  const xtream = require("../xtream");
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
    const r = spawnSync(process.execPath, ["-e", "require('./addon')"], { cwd: require("path").join(__dirname, ".."), env, encoding: "utf8", timeout: 10000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CONFIG_SECRET is not set");
  });
});

// ─── M3U group selection ───

describe("M3U group selection", () => {
  const m3u = require("../m3u");
  const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="a" group-title="Sports",A
http://example.com/a.m3u8
#EXTINF:-1 group-title="News",B
http://example.com/b.m3u8
#EXTINF:-1 group-title="Sports",C
http://example.com/c.m3u8`;
  afterEach(() => jest.restoreAllMocks());

  test("parser keeps only selected groups with the same ids as unfiltered", () => {
    const all = m3u.parseM3UContent(playlist).channels;
    const sports = m3u.parseM3UContent(playlist, ["Sports"]).channels;
    expect(sports.map(c => c.name)).toEqual(["A", "C"]);
    expect(sports.map(c => c.id)).toEqual([all[0].id, all[2].id]);
  });

  test("config g round-trips through /api/encrypt and parseConfigPath", async () => {
    const res = await request(app).post("/api/encrypt").send({ t: "m3u", m: "http://example.com/x.m3u", g: JSON.stringify(["Sports", "A, B & C"]) });
    expect(parseConfigPath(res.body.config).groups).toEqual(["Sports", "A, B & C"]);
  });

  test("invalid or missing g means all groups", () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(parseConfigPath(enc({ t: "m3u", m: "http://e.com/x", g: "{not json" })).groups).toEqual([]);
    expect(parseConfigPath(enc({ t: "m3u", m: "http://e.com/x" })).groups).toEqual([]);
  });

  test("/api/encrypt rejects a group list that would be truncated", async () => {
    const g = JSON.stringify(Array.from({ length: 200 }, (_, i) => `Group number ${i}`));
    const res = await request(app).post("/api/encrypt").send({ t: "m3u", m: "http://example.com/x.m3u", g });
    expect(res.status).toBe(400);
  });

  test("catalog and genre options only contain the selected groups", async () => {
    const spy = jest.spyOn(m3u, "parseM3U").mockImplementation(async (url, groups) => m3u.parseM3UContent(playlist, groups));
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const cfg = enc({ t: "m3u", m: "http://groups-test.example.com/x.m3u", g: JSON.stringify(["Sports"]) });
    const cat = await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`);
    expect(cat.body.metas.map(m => m.name)).toEqual(["A", "C"]);
    expect(spy).toHaveBeenCalledWith("http://groups-test.example.com/x.m3u", ["Sports"]);
  });

  test("POST /api/m3u-groups returns groups with counts", async () => {
    jest.spyOn(m3u, "parseM3UGroups").mockResolvedValue([{ name: "Sports", count: 2 }, { name: "News", count: 1 }]);
    const res = await request(app).post("/api/m3u-groups").send({ m3uUrl: "http://example.com/x.m3u" });
    expect(res.body.groups).toEqual([{ name: "Sports", count: 2 }, { name: "News", count: 1 }]);
  });

  test("POST /api/m3u-groups blocks private URLs", async () => {
    const res = await request(app).post("/api/m3u-groups").send({ m3uUrl: "http://192.168.1.1/x.m3u" });
    expect(res.status).toBe(400);
  });
});

// ─── Configure page: one-step check + edit installed setup ───

describe("configure page API", () => {
  const m3u = require("../m3u");
  const xtream = require("../xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("M3U test returns the groups (one download for test + picker)", async () => {
    const spy = jest.spyOn(m3u, "parseM3UGroups").mockResolvedValue([{ name: "Sports", count: 2 }, { name: "News", count: 1 }]);
    const parse = jest.spyOn(m3u, "parseM3U");
    const res = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "http://example.com/check-test.m3u" });
    expect(res.body).toEqual({ ok: true, message: "Connected! Found 3 channels.", groups: [{ name: "Sports", count: 2 }, { name: "News", count: 1 }] });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(parse).not.toHaveBeenCalled(); // no full channel list held for a test
  });

  test("M3U test fails clearly for a playlist without live channels", async () => {
    jest.spyOn(m3u, "parseM3UGroups").mockResolvedValue([]);
    const res = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "http://example.com/empty-test.m3u" });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/No live channels/);
  });

  test("Xtream test returns its categories", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([{ category_id: 7, category_name: "Sport" }]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const res = await request(app).post("/api/test").send({ type: "xtream", server: "http://example.com", username: "u", password: "p" });
    expect(res.body.ok).toBe(true);
    expect(res.body.categories).toEqual([{ category_id: 7, category_name: "Sport" }]);
  });

  test("GET /api/config returns an install's settings for editing", async () => {
    const xt = await request(app).post("/api/encrypt").send({ t: "xtream", s: "http://example.com", u: "u", p: "p", c: "1,2" });
    const r1 = await request(app).get(`/api/config/${xt.body.config}`);
    expect(r1.headers["cache-control"]).toBe("no-store");
    expect(r1.body).toEqual({ type: "xtream", server: "http://example.com", username: "u", password: "p", categories: ["1", "2"] });

    const r2 = await request(app).get(`/api/config/${enc({ t: "m3u", m: "http://e.com/x.m3u", g: JSON.stringify(["News"]) })}`);
    expect(r2.body).toEqual({ type: "m3u", m3uUrl: "http://e.com/x.m3u", categories: ["News"] });
  });

  test("GET /api/config rejects an invalid link", async () => {
    const res = await request(app).get("/api/config/garbage");
    expect(res.status).toBe(400);
  });

  test("the use-http:// hint only goes to https:// addresses", async () => {
    const sslError = new Error("write EPROTO error:0A00010B:SSL routines:tls_validate_record_header:wrong version number");
    jest.spyOn(m3u, "parseM3UGroups").mockRejectedValue(sslError);
    const https = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "https://example.com/hint-ssl.m3u" });
    expect(https.body.error).toMatch(/start with http:\/\/ instead of https:\/\//);
    const http = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "http://example.com/hint-ssl2.m3u" });
    expect(http.body.error).toMatch(/secure-connection \(SSL\) problem/);
    expect(http.body.error).not.toMatch(/instead of https/);
  });

  test("a 403 Test Connection explains the provider refused StreamVault's server", async () => {
    jest.spyOn(m3u, "parseM3UGroups").mockRejectedValue(new Error("Request failed with status code 403"));
    const res = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "http://example.com/hint-403.m3u" });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/refused the connection from StreamVault's server/);
  });

  test("an oversized request gets a short JSON answer, counted under its route", async () => {
    const huge = "#EXTINF:-1,Channel\nhttp://example.com/1.m3u8\n".repeat(600); // ~27 KB of pasted playlist
    const res = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: huge });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ ok: false, error: expect.stringMatching(/paste the playlist link/) });
    const today = new Date().toISOString().slice(0, 10);
    const row = (await request(app).get("/stats")).body.history.find(r => r.date === today);
    expect(row.responseErrors["POST /api/test"]["413"]).toBeGreaterThanOrEqual(1);
  });

  test("an Xtream selection too long to store is refused, not cut off", async () => {
    const ids = Array.from({ length: 500 }, (_, i) => 10000 + i).join(",");
    const res = await request(app).post("/api/encrypt").send({ t: "xtream", s: "http://example.com", u: "u", p: "p", c: ids });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Too many categories/);
  });
});

// ─── Requests to providers identify as a player ───

// ─── SSRF: the address is re-checked when connecting ───

describe("connect-time address check (DNS rebinding)", () => {
  const dns = require("dns");
  const http = require("http");
  const { guardedLookup } = require("../urlguard");
  afterEach(() => jest.restoreAllMocks());

  const lookupWith = (addresses) =>
    jest.spyOn(dns, "lookup").mockImplementation((host, opts, cb) => cb(null, addresses));
  const run = (opts) => new Promise(res => guardedLookup("x.example", opts, (...a) => res(a)));

  test("refuses a host that resolves to a private address, passes public ones", async () => {
    lookupWith([{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    expect((await run({}))[0].message).toBe("Invalid or blocked URL");
    jest.restoreAllMocks();

    lookupWith([{ address: "93.184.215.14", family: 4 }]);
    expect(await run({})).toEqual([null, "93.184.215.14", 4]);
    expect(await run({ all: true })).toEqual([null, [{ address: "93.184.215.14", family: 4 }]]);
  });

  test("a domain that passes the early check but then resolves inside is never connected to", async () => {
    let hits = 0;
    const server = http.createServer((req, res) => { hits++; res.end("[]"); });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      // Early check (validateExternalUrl) sees a public address...
      jest.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
      // ...the connection's own lookup gets 127.0.0.1 (rebinding)
      lookupWith([{ address: "127.0.0.1", family: 4 }]);
      const xtream = require("../xtream");
      await expect(xtream.getLiveCategories({ server: `http://rebind.example:${port}`, username: "u", password: "p" }))
        .rejects.toThrow("Invalid or blocked URL");
      await expect(require("../m3u").parseM3UGroups(`http://rebind.example:${port}/list.m3u`))
        .rejects.toThrow("Invalid or blocked URL");
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });
});

describe("Prometheus metrics", () => {
  const { buildMetricsText } = require("../addon");
  const metrics = require("../metrics");

  test("valid text format with memory, caches, today's counters and per-route requests", async () => {
    await request(app).get("/health");
    await request(app).get("/catalog/tv/iptv_live.json");
    const text = buildMetricsText();
    const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(?:[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*",?)*\})? (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|NaN|\+Inf)$/;
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

describe("Sonar fixes", () => {
  test("trailing slashes are trimmed in linear time (no regex backtracking)", () => {
    const { trimTrailingSlashes } = require("../urlguard");
    expect(trimTrailingSlashes("http://a:8080///")).toBe("http://a:8080");
    expect(trimTrailingSlashes("http://a")).toBe("http://a");
    const start = Date.now();
    trimTrailingSlashes("http://a" + "/".repeat(200000) + "x");
    expect(Date.now() - start).toBeLessThan(50);
  });

  test("responses don't advertise Express", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("provider User-Agent", () => {
  const axios = require("axios");
  afterEach(() => jest.restoreAllMocks());

  test("playlist downloads send a VLC User-Agent (axios's default gets 403 from many panels)", async () => {
    const get = jest.spyOn(axios, "get").mockRejectedValue(new Error("stop"));
    await expect(require("../m3u").parseM3UGroups("http://93.184.215.14/ua.m3u")).rejects.toThrow("stop");
    expect(get.mock.calls[0][1].headers["User-Agent"]).toMatch(/^VLC\//);
  });
});

// ─── Ids that aren't this install's channels ───

describe("foreign ids", () => {
  const m3u = require("../m3u");
  const xtream = require("../xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("an Xtream install offers no (unplayable) streams for an M3U-style id", async () => {
    const streams = jest.spyOn(xtream, "getLiveStreams");
    const cfg = enc({ t: "xtream", s: "http://foreign-xt.example.com", u: "u", p: "p", c: "" });
    for (const id of ["mzansimagic.za", "Moja.Love.HD.za (src05)"]) {
      const res = await request(app).get(`/${cfg}/stream/tv/iptv_tv_${encodeURIComponent(id)}.json`);
      expect(res.body).toEqual({ streams: [] });
    }
    expect(streams).not.toHaveBeenCalled(); // answered without touching the provider
  });

  test("an Xtream install still answers its own ids", async () => {
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 42, name: "Own", category_id: "1" }]);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    const cfg = enc({ t: "xtream", s: "http://own-xt.example.com", u: "u", p: "p", c: "" });
    const res = await request(app).get(`/${cfg}/stream/tv/iptv_tv_42.json`);
    expect(res.body.streams).toHaveLength(2);
  });

  test("another addon's iptv_ id is not looked up in the playlist", async () => {
    const parse = jest.spyOn(m3u, "parseM3U");
    const cfg = enc({ t: "m3u", m: "http://example.com/foreign-ids.m3u" });
    const res = await request(app).get(`/${cfg}/stream/tv/iptv_a02ed40f856b05bd.json`);
    expect(res.body).toEqual({ streams: [] });
    expect(parse).not.toHaveBeenCalled();
  });
});

// ─── Xtream account validation + subscription expiry ───

describe("Xtream account checks", () => {
  const xtream = require("../xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const test_ = (account, cats = [{ category_id: 1, category_name: "Sport" }]) => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue(cats);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(account);
    return request(app).post("/api/test").send({ type: "xtream", server: "http://example.com", username: "u", password: "p" });
  };
  const future = Math.floor(Date.now() / 1000) + 30 * 86400;
  const past = Math.floor(Date.now() / 1000) - 86400;
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ["wrong login", { auth: 0 }, [], "Wrong username or password"],
    ["expired status", { auth: 1, status: "Expired" }, undefined, "Your account is expired"],
    ["banned status", { auth: 1, status: "Banned" }, undefined, "Your account is banned"],
    ["past expiry date", { auth: 1, status: "Active", exp_date: String(past) }, undefined, "Your account expired on"],
    ["no categories", { auth: 1, status: "Active", exp_date: String(future) }, [], "No live channels on this account"],
    ["empty list, no account info", null, [], "No live channels on this account"],
  ])("fails for %s", async (_, account, cats, error) => {
    const res = await test_(account, cats);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toContain(error);
  });

  test("passes for an active account, and when the provider reports no account info", async () => {
    expect((await test_({ auth: 1, status: "Active", exp_date: String(future) })).body.ok).toBe(true);
    jest.restoreAllMocks();
    expect((await test_(null)).body.ok).toBe(true);
  });

  test("channel page shows when the subscription expires", async () => {
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 5, name: "Diema" }]);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue({ auth: 1, status: "Active", exp_date: "1796083200" });
    const cfg = enc({ t: "xtream", s: "http://example.com", u: "expiry-user", p: "p" });
    const res = await request(app).get(`/${cfg}/meta/tv/iptv_tv_5.json`);
    expect(res.body.meta.description).toContain("🗓 Subscription expires 2026-12-01");
  });

  test("channel page warns when the subscription has expired", async () => {
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 5, name: "Diema" }]);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue({ auth: 1, status: "Active", exp_date: String(past) });
    const cfg = enc({ t: "xtream", s: "http://example.com", u: "expired-user", p: "p" });
    const res = await request(app).get(`/${cfg}/meta/tv/iptv_tv_5.json`);
    expect(res.body.meta.description).toMatch(/⚠️ Subscription expired on \d{4}-\d{2}-\d{2}/);
  });
});

// ─── Error tiles instead of an empty catalog ───

describe("catalog error tiles", () => {
  const m3u = require("../m3u");
  const xtream = require("../xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ["Request failed with status code 503", "iptv_notice_provider_down", "Provider not responding"],
    ["Request failed with status code 512", "iptv_notice_provider_down", "Provider not responding"],
    ["Request failed with status code 403", "iptv_notice_provider_refused", "Provider refused access"],
    ["Request failed with status code 404", "iptv_notice_not_found", "Playlist not found"],
    ["Invalid or blocked URL", "iptv_notice_bad_address", "Address doesn't work"],
    ["timeout of 30000ms exceeded", "iptv_notice_provider_down", "Provider not responding"],
    ["something odd", "iptv_notice_unknown", "Couldn't load channels"],
  ])("'%s' shows the %s tile", async (message, id, name) => {
    jest.spyOn(m3u, "parseM3U").mockRejectedValue(new Error(message));
    const cfg = enc({ t: "m3u", m: `http://example.com/tile-${id}-${message.length}.m3u` });
    const res = await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`);
    expect(res.body.metas).toHaveLength(1);
    expect(res.body.metas[0]).toMatchObject({ id, name: `⚠️ ${name}`, type: "tv" });
  });

  test("no tile on later pages", async () => {
    jest.spyOn(m3u, "parseM3U").mockRejectedValue(new Error("Request failed with status code 503"));
    const cfg = enc({ t: "m3u", m: "http://example.com/tile-page2.m3u" });
    const res = await request(app).get(`/${cfg}/catalog/tv/iptv_live/skip=100.json`);
    expect(res.body.metas).toEqual([]);
  });

  test("opening a tile explains it and it has no streams", async () => {
    const cfg = enc({ t: "m3u", m: "http://example.com/x.m3u" });
    const meta = await request(app).get(`/${cfg}/meta/tv/iptv_notice_provider_down.json`);
    expect(meta.body.meta.description).toMatch(/usually temporary/);
    const streams = await request(app).get(`/${cfg}/stream/tv/iptv_notice_provider_down.json`);
    expect(streams.body.streams).toEqual([]);
  });

  test("an expired Xtream account with an empty list shows the account tile", async () => {
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([]);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue({ auth: 1, status: "Expired" });
    const cfg = enc({ t: "xtream", s: "http://example.com", u: "tile-expired", p: "p" });
    const cat = await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`);
    expect(cat.body.metas).toEqual([expect.objectContaining({ id: "iptv_notice_account", name: "⚠️ Your account is expired" })]);
    const meta = await request(app).get(`/${cfg}/meta/tv/iptv_notice_account.json`);
    expect(meta.body.meta.description).toMatch(/^Your account is expired\. Renew/);
  });
});

// ─── Rate limiting ───

describe("rate limiting", () => {
  const { getIp } = require("../ratelimit");
  const testBody = { type: "m3u" }; // fails validation fast (400), no network

  test("11th provider check from one IP in a minute gets 429; other groups unaffected", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 10; i++) {
      const ok = await request(app).post("/api/test").set("Fly-Client-IP", ip).send(testBody);
      expect(ok.status).toBe(400);
    }
    const blocked = await request(app).post("/api/test").set("Fly-Client-IP", ip).send(testBody);
    expect(blocked.status).toBe(429);
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.error).toBe("Too many requests");

    // same group, other endpoint → also blocked; other group → fine
    expect((await request(app).post("/api/m3u-groups").set("Fly-Client-IP", ip).send({})).status).toBe(429);
    expect((await request(app).post("/api/encrypt").set("Fly-Client-IP", ip).send({ t: "m3u", m: "http://example.com/x" })).status).toBe(200);
  });

  test("each client IP has its own budget; a forged X-Forwarded-For doesn't get a new one", async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < 10; i++) await request(app).post("/api/test").set("Fly-Client-IP", ip).send(testBody);
    const forged = await request(app).post("/api/test").set("Fly-Client-IP", ip).set("X-Forwarded-For", "9.9.9.9").send(testBody);
    expect(forged.status).toBe(429);
    const otherIp = await request(app).post("/api/test").set("Fly-Client-IP", "203.0.113.21").send(testBody);
    expect(otherIp.status).toBe(400);
  });

  test("/health is never limited", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await request(app).get("/health").set("Fly-Client-IP", "203.0.113.30")).status).toBe(200);
    }
  });

  test("getIp prefers Fly-Client-IP and ignores X-Forwarded-For", () => {
    const req = (headers, remoteAddress = "10.0.0.1") => ({ headers, socket: { remoteAddress } });
    expect(getIp(req({ "fly-client-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4" }))).toBe("198.51.100.7");
    expect(getIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe("10.0.0.1");
  });
});

// ─── Error codes per day ───

describe("per-day error codes", () => {
  const m3u = require("../m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const today = () => new Date().toISOString().slice(0, 10);
  const row = async () => (await request(app).get("/stats")).body.history.find(r => r.date === today()) || {};
  const n = (map, where, code) => (map && map[where] && map[where][code]) || 0;
  afterEach(() => jest.restoreAllMocks());

  test("provider errors are counted by status code or kind", async () => {
    const before = await row();
    jest.spyOn(m3u, "parseM3U").mockRejectedValueOnce(new Error("Request failed with status code 503"));
    await request(app).get(`/${enc({ t: "m3u", m: "http://example.com/codes-503.m3u" })}/catalog/tv/iptv_live.json`);
    jest.spyOn(m3u, "parseM3U").mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND nowhere.example"));
    await request(app).get(`/${enc({ t: "m3u", m: "http://example.com/codes-dns.m3u" })}/catalog/tv/iptv_live.json`);
    jest.spyOn(m3u, "parseM3UGroups").mockRejectedValueOnce(new Error("Request failed with status code 403"));
    await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "http://example.com/codes-403.m3u" });

    const after = await row();
    const diff = (where, code) => n(after.providerErrors, where, code) - n(before.providerErrors, where, code);
    expect(diff("catalog (m3u)", "503")).toBe(1);
    expect(diff("catalog (m3u)", "bad_address")).toBe(1);
    expect(diff("test (m3u)", "403")).toBe(1);
  });

  test("StreamVault's own error responses are counted by status (400, 404, 429)", async () => {
    const before = await row();
    await request(app).get("/garbage/manifest.json");                 // 400 invalid config
    await request(app).get("/api/nope");                              // 404
    const ip = "203.0.113.40";
    for (let i = 0; i < 11; i++) await request(app).post("/api/test").set("Fly-Client-IP", ip).send({ type: "m3u" }); // 10×400 + 429
    const after = await row();
    const diff = (where, code) => n(after.responseErrors, where, code) - n(before.responseErrors, where, code);
    expect(diff("GET /:config/manifest.json", "400")).toBe(1);
    expect(diff("POST /api/test", "400")).toBe(10);
    expect(diff("POST /api/test", "429")).toBe(1);
    expect(diff("unknown path", "404")).toBe(1);
    // raw URLs (which can contain install links) are never stored
    expect(JSON.stringify(after.responseErrors)).not.toContain("garbage");
  });

  test("/stats allows 5 requests per minute per IP", async () => {
    const ip = "203.0.113.50";
    for (let i = 0; i < 5; i++) {
      expect((await request(app).get("/stats").set("Fly-Client-IP", ip)).status).toBe(200);
    }
    expect((await request(app).get("/stats").set("Fly-Client-IP", ip)).status).toBe(429);
  });
});

// ─── Stats file saving (atomic, no overlap) ───

describe("stats file saving", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { spawnSync } = require("child_process");
  const root = path.join(__dirname, "..");
  // Runs a snippet in a fresh Node process whose stats live in a throwaway folder.
  // FORCE_COLOR=0: IDE test runners set FORCE_COLOR, and console.log(42) would
  // then print colour codes around the number.
  const run = (dir, code) => spawnSync(process.execPath, ["-e", code], {
    cwd: root, env: { ...process.env, STATS_DIR: dir, FORCE_COLOR: "0" }, encoding: "utf8", timeout: 15000,
  });
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-stats-"));

  test("shutdown save writes a complete stats.json and leaves no temp files", () => {
    const dir = tmpDir();
    const r = run(dir, "require('./addon'); process.emit('SIGTERM');");
    expect(r.status).toBe(0);
    expect(fs.readdirSync(dir)).toEqual(["stats.json"]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "stats.json"), "utf8"));
    expect(saved).toHaveProperty("history");
  });

  test("a crash mid-save keeps the previous stats.json intact", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "stats.json"), JSON.stringify({ installs: 42, users: [], history: {} }));
    // Simulate dying half-way: only part of the temp file gets written, rename never happens
    fs.writeFileSync(path.join(dir, "stats.json.tmp"), '{"installs": 4');
    const r = run(dir, "const { app } = require('./addon'); require('supertest')(app).get('/stats').then(x => { console.log(x.body.installs); process.exit(0); });");
    expect(r.stdout.trim().split("\n").pop()).toBe("42");
  });

  test("today's row saved without error maps still counts errors", () => {
    const dir = tmpDir();
    const today = new Date().toISOString().slice(0, 10);
    // a row from before error-code tracking existed: no providerErrors/responseErrors
    fs.writeFileSync(path.join(dir, "stats.json"), JSON.stringify({ users: [], history: { [today]: { launches: 4 } } }));
    const r = run(dir, "const r = require('supertest'); const { app } = require('./addon'); r(app).get('/api/nope').then(() => r(app).get('/stats')).then(x => { console.log(JSON.stringify(x.body.history[0])); process.exit(0); });");
    const row = JSON.parse(r.stdout.trim().split("\n").pop());
    expect(row.launches).toBe(4);
    expect(row.responseErrors).toEqual({ "unknown path": { "404": 1 } });
  });

  test("users are saved as one-way codes, never IPs (old IP entries converted)", () => {
    const dir = tmpDir();
    const today = new Date().toISOString().slice(0, 10);
    // stats.json from before: plain IPs; the same user returns today
    fs.writeFileSync(path.join(dir, "stats.json"), JSON.stringify({
      installs: 1, users: ["203.0.113.9"], dailyActive: { [today]: ["203.0.113.9"] }, history: {},
    }));
    const cfg = Buffer.from(JSON.stringify({ t: "m3u", m: "http://example.com/u.m3u" })).toString("base64").replace(/=+$/, "");
    const r = run(dir, `
      const r = require('supertest'); const { app } = require('./addon');
      const m3u = require('./m3u'); m3u.parseM3UGroups = async () => [];
      r(app).get('/${cfg}/manifest.json').set('Fly-Client-IP', '203.0.113.9')
        .then(() => r(app).get('/${cfg}/manifest.json').set('Fly-Client-IP', '198.51.100.4'))
        .then(() => r(app).get('/stats'))
        .then(x => { console.log(JSON.stringify(x.body)); process.emit('SIGTERM'); });
    `);
    const body = JSON.parse(r.stdout.trim().split("\n").pop());
    expect(body.installs).toBe(2);       // returning user not counted again, new one is
    expect(body.uniqueUsers).toBe(2);
    const saved = fs.readFileSync(path.join(dir, "stats.json"), "utf8");
    expect(saved).not.toContain("203.0.113");
    expect(saved).not.toContain("198.51.100");
    const json = JSON.parse(saved);
    expect(json.users).toHaveLength(2);
    json.users.concat(json.dailyActive[today]).forEach(u => expect(u).toMatch(/^[0-9a-f]{16}$/));
  });

  test("overlapping saves are skipped, and the async save is atomic", () => {
    const dir = tmpDir();
    const r = run(dir, `
      const fs = require('fs');
      const { saveStats } = require('./addon');
      const writes = [], renames = [];
      const w = fs.promises.writeFile, rn = fs.promises.rename;
      fs.promises.writeFile = (...a) => { writes.push(a[0]); return w(...a); };
      fs.promises.rename = (...a) => { renames.push(a.map(p => require('path').basename(p))); return rn(...a); };
      saveStats(); saveStats(); saveStats();            // 2nd and 3rd overlap the 1st
      setTimeout(() => {
        saveStats();                                    // 1st finished → allowed again
        setTimeout(() => { console.log(JSON.stringify({ writes: writes.length, renames })); process.exit(0); }, 300);
      }, 300);
    `);
    const out = JSON.parse(r.stdout.trim().split("\n").pop());
    expect(out.writes).toBe(2);
    expect(out.renames).toEqual([["stats.json.tmp", "stats.json"], ["stats.json.tmp", "stats.json"]]);
    expect(fs.readdirSync(dir)).toEqual(["stats.json"]);
  });
});

// ─── Stable install links ("s-<id>") ───

describe("stable install links", () => {
  const m3u = require("../m3u");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { spawnSync } = require("child_process");
  const stats = async () => (await request(app).get("/stats")).body;
  const playlist = [
    "#EXTM3U",
    '#EXTINF:-1 tvg-id="n1" group-title="News",News One', "http://example.com/n1.m3u8",
    '#EXTINF:-1 tvg-id="s1" group-title="Sport",Sport One', "http://example.com/s1.m3u8",
  ].join("\n");
  // like the real parser: only the selected groups
  beforeEach(() => jest.spyOn(m3u, "parseM3U").mockImplementation(async (url, groups) => m3u.parseM3UContent(playlist, groups)));
  afterEach(() => jest.restoreAllMocks());
  const names = async (link) => (await request(app).get(`/${link}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);

  test("Install gives a stable link that works like an encrypted one", async () => {
    const res = await request(app).post("/api/link").send({ t: "m3u", m: "http://stable.example.com/a.m3u" });
    expect(res.body.updated).toBe(false);
    expect(res.body.config).toMatch(/^s-[a-z0-9]{12}$/);
    const man = await request(app).get(`/${res.body.config}/manifest.json`);
    expect(man.body.description).toMatch(/^✓ Connected to your M3U playlist\./);
    expect(await names(res.body.config)).toEqual(["News One", "Sport One"]);
    expect((await stats()).caches.links).toBeGreaterThanOrEqual(1);
  });

  test("editing a stable link keeps the same link and applies the new settings", async () => {
    const link = (await request(app).post("/api/link").send({ t: "m3u", m: "http://stable.example.com/b.m3u" })).body.config;
    const genresBefore = (await request(app).get(`/${link}/manifest.json`)).body.catalogs[0].extra.find(e => e.name === "genre");
    expect(genresBefore.options).toEqual(["News", "Sport"]);

    const before = (await stats()).history[0].reinstalls || 0;
    const edit = await request(app).post("/api/link")
      .send({ t: "m3u", m: "http://stable.example.com/b.m3u", g: JSON.stringify(["Sport"]), editing: link });
    expect(edit.body).toEqual({ config: link, updated: true, app: null });
    expect((await stats()).history[0].reinstalls).toBe(before + 1);

    expect(await names(link)).toEqual(["Sport One"]);
    // the category list isn't served from the old cache entry
    const man = await request(app).get(`/${link}/manifest.json`);
    expect(man.body.catalogs[0].extra.map(e => e.name)).toEqual(["search", "skip"]);
  });

  test("an older link is edited in place too (no second StreamVault)", async () => {
    const old = (await request(app).post("/api/encrypt").send({ t: "m3u", m: "http://stable.example.com/c.m3u" })).body.config;
    expect(old).toMatch(/^e-/);
    expect(await names(old)).toEqual(["News One", "Sport One"]);

    const res = await request(app).post("/api/link")
      .send({ t: "m3u", m: "http://stable.example.com/c.m3u", g: JSON.stringify(["News"]), editing: old });
    expect(res.body).toEqual({ config: old, updated: true, app: null });
    expect(await names(old)).toEqual(["News One"]);
    expect((await request(app).get(`/api/config/${old}`)).body.categories).toEqual(["News"]);

    // a second edit updates the same override
    await request(app).post("/api/link").send({ t: "m3u", m: "http://stable.example.com/c.m3u", editing: old });
    expect(await names(old)).toEqual(["News One", "Sport One"]);
  });

  test("after a save the page is told which app to restart, when the server is sure", async () => {
    const make = async (m) => (await request(app).post("/api/link").send({ t: "m3u", m })).body.config;
    const save = async (link) => (await request(app).post("/api/link").send({ t: "m3u", m: "http://apps.example.com/x.m3u", editing: link })).body;
    const visit = (link, ua) => request(app).get(`/${link}/catalog/tv/iptv_live.json`).set("User-Agent", ua);

    const nuvio = await make("http://apps.example.com/n.m3u");
    await visit(nuvio, "Nuvio/1.1.0-beta.7");
    expect(await save(nuvio)).toMatchObject({ updated: true, app: "Nuvio" });

    const stremio = await make("http://apps.example.com/s.m3u");
    await visit(stremio, "Mozilla/5.0 Stremio/5.0");
    expect((await save(stremio)).app).toBe("Stremio");

    const both = await make("http://apps.example.com/b.m3u");
    await visit(both, "Nuvio/1.0 (webOS)");
    await visit(both, "Stremio/4.4");
    expect((await save(both)).app).toBeNull();

    // unknown apps, the configure page itself (/api) and the player (/play) teach nothing
    const unknown = await make("http://apps.example.com/u.m3u");
    await visit(unknown, "okhttp/5.3.2");
    await request(app).get(`/api/config/${unknown}`).set("User-Agent", "Nuvio/1.0");
    expect((await save(unknown)).app).toBeNull();

    // older links too
    const old = (await request(app).post("/api/encrypt").send({ t: "m3u", m: "http://apps.example.com/o.m3u" })).body.config;
    await visit(old, "Nuvio/1.1.0");
    expect(await save(old)).toMatchObject({ config: old, updated: true, app: "Nuvio" });
  });

  test("an editing value that isn't a real StreamVault link can't store anything", async () => {
    const res = await request(app).post("/api/link").send({ t: "m3u", m: "http://stable.example.com/d.m3u", editing: "garbage-link" });
    expect(res.body.updated).toBe(false);
    expect(res.body.config).toMatch(/^s-/); // a normal new link instead
  });

  test("a stable link that doesn't exist is refused clearly", async () => {
    const res = await request(app).get("/s-zzzzzzzzzzzz/catalog/tv/iptv_live.json");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no longer exists/);
    const prefill = await request(app).get("/api/config/s-zzzzzzzzzzzz");
    expect(prefill.status).toBe(400);
  });

  test("opening Configure from an installed StreamVault counts as a reconfigure", async () => {
    const before = (await stats()).history[0].reconfigures || 0;
    await request(app).get("/s-abcdefghijkl/configure").set("Fly-Client-IP", "198.51.100.90");
    await request(app).get("/configure").set("Fly-Client-IP", "198.51.100.91");
    expect((await stats()).history[0].reconfigures).toBe(before + 1);
  });

  test("stable links are hidden in logged paths", async () => {
    await request(app).get("/s-abcdefghijkl/subtitles2/x.json");
    const paths = (await stats()).recentUnknownPaths.map(p => p.path).join(" ");
    expect(paths).not.toContain("s-abcdefghijkl");
  });

  test("links survive a restart; a corrupt file falls back to the backup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-links-"));
    const run = (code) => spawnSync(process.execPath, ["-e", code], {
      cwd: path.join(__dirname, ".."), env: { ...process.env, STATS_DIR: dir, FORCE_COLOR: "0" }, encoding: "utf8", timeout: 15000,
    });
    const last = (r) => r.stdout.trim().split("\n").pop();
    // 1st run: create, edit (2 saves → a .bak exists), shut down
    const r1 = run(`
      const r = require('supertest'); const { app } = require('./addon');
      r(app).post('/api/link').send({ t: 'm3u', m: 'http://persist.example.com/a.m3u' })
        .then(x => r(app).post('/api/link').send({ t: 'm3u', m: 'http://persist.example.com/b.m3u', editing: x.body.config }).then(() => x))
        .then(x => setTimeout(() => { console.log(x.body.config); process.emit('SIGTERM'); }, 300));
    `);
    const link = last(r1);
    expect(link).toMatch(/^s-/);
    expect(fs.existsSync(path.join(dir, "links.json"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "links.json"), "utf8")).not.toContain("persist.example.com"); // encrypted only

    const read = `const r = require('supertest'); const { app } = require('./addon');
      r(app).get('/api/config/${link}').then(x => { console.log(x.body.m3uUrl); process.exit(0); });`;
    expect(last(run(read))).toBe("http://persist.example.com/b.m3u");

    // main file corrupted → kept aside, the backup (previous version) is used
    fs.writeFileSync(path.join(dir, "links.json"), "{ not json");
    expect(last(run(read))).toBe("http://persist.example.com/a.m3u");
    expect(fs.readdirSync(dir).some(f => f.startsWith("links.json.corrupt-"))).toBe(true);
  });

  test("without links.json an edited older link falls back to the settings inside it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-links-"));
    const run = (code) => spawnSync(process.execPath, ["-e", code], {
      cwd: path.join(__dirname, ".."), env: { ...process.env, STATS_DIR: dir, FORCE_COLOR: "0" }, encoding: "utf8", timeout: 15000,
    });
    const last = (r) => r.stdout.trim().split("\n").pop();
    const old = encryptConfig({ t: "m3u", m: "http://fallback.example.com/original.m3u" });
    const r1 = run(`
      const r = require('supertest'); const { app } = require('./addon');
      r(app).post('/api/link').send({ t: 'm3u', m: 'http://fallback.example.com/edited.m3u', editing: 'e-${old}' })
        .then(x => setTimeout(() => { console.log(x.body.updated); process.emit('SIGTERM'); }, 300));
    `);
    expect(last(r1)).toBe("true");
    const read = `const r = require('supertest'); const { app } = require('./addon');
      r(app).get('/api/config/e-${old}').then(x => { console.log(x.body.m3uUrl); process.exit(0); });`;
    expect(last(run(read))).toBe("http://fallback.example.com/edited.m3u");
    for (const f of fs.readdirSync(dir)) if (f.startsWith("links.json")) fs.unlinkSync(path.join(dir, f));
    expect(last(run(read))).toBe("http://fallback.example.com/original.m3u");
  });
});

// ─── Channel posters ───

describe("channel posters", () => {
  const m3u = require("../m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("logos are fitted into a square (whole logo visible); no logo → name tile", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 tvg-id="a" tvg-logo="http://cdn.example.com/logos/a wide.png",With Logo
http://example.com/a.m3u8
#EXTINF:-1 tvg-id="b",No Logo
http://example.com/b.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://example.com/posters.m3u" });
    const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;

    const poster = new URL(metas[0].poster);
    expect(poster.origin).toBe("https://wsrv.nl");
    expect(poster.searchParams.get("url")).toBe("http://cdn.example.com/logos/a wide.png");
    expect(poster.searchParams.get("fit")).toBe("contain");
    expect(poster.searchParams.get("w")).toBe("256");
    expect(poster.searchParams.get("h")).toBe("256");
    // dead logo link → the generated name tile instead of a broken image
    expect(poster.searchParams.get("default")).toMatch(/^https:\/\/ui-avatars\.com\/api\/\?name=With%20Logo/);

    expect(metas[1].poster).toMatch(/^https:\/\/ui-avatars\.com\//);

    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_tv_a.json`)).body.meta;
    expect(meta.poster).toBe(metas[0].poster);
  });

  test("Xtream: same posters for Stremio, raw logo only kept internally", async () => {
    const xtream = require("../xtream");
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([{ category_id: 1, category_name: "Sport" }]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([
      { stream_id: 7, name: "Diema Sport", stream_icon: "http://cdn.example.com/diema.png", category_id: 1 },
      { stream_id: 8, name: "No Icon", category_id: 1 },
    ]);
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const cfg = enc({ t: "xtream", s: "http://example.com", u: "poster-user", p: "p" });

    const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;
    expect(metas[0]).toEqual({
      id: "iptv_tv_7", type: "tv", name: "Diema Sport", genres: ["Sport"], posterShape: "square",
      poster: expect.stringMatching(/^https:\/\/wsrv\.nl\/\?url=http%3A%2F%2Fcdn\.example\.com%2Fdiema\.png&/),
    });
    expect(metas[0]).not.toHaveProperty("logo");
    expect(metas[1].poster).toMatch(/^https:\/\/ui-avatars\.com\//);

    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_tv_7.json`)).body.meta;
    expect(meta.poster).toBe(metas[0].poster);
    expect(meta).not.toHaveProperty("logo");
  });
});

// ─── Global download limit ───

describe("parallel download limit", () => {
  const m3u = require("../m3u");
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

// ─── Fixes from live stats (2026-10-14) ───

describe("live-stats fixes", () => {
  const m3u = require("../m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const stats = async () => (await request(app).get("/stats")).body;
  afterEach(() => jest.restoreAllMocks());

  test("an emoji at the name cut-off no longer breaks the catalog (was 'URI malformed')", async () => {
    // 29 characters, then an emoji: the old substring(0, 30) cut it in half
    const name = "Sport Channel HD Premium 4K S📺 extra";
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 tvg-id="e1" tvg-logo="https://cdn.example.com/e1.png",${name}
http://example.com/1.m3u8
#EXTINF:-1 tvg-id="e2",${name}
http://example.com/2.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://example.com/emoji-names.m3u" });
    const res = await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`);
    expect(res.body.metas.map(m => m.name)).toEqual([name, name]);
    expect(res.body.metas[1].poster).toMatch(/^https:\/\/ui-avatars\.com\//);
  });

  test("broken % encoding in a catalog extra is kept as text instead of throwing", () => {
    expect(parseExtra("genre=100% Sport&skip=0.json")).toEqual({ genre: "100% Sport", skip: "0" });
    expect(parseExtra("genre=100%25%20Sport.json")).toEqual({ genre: "100% Sport" });
    expect(parseExtra("search=a=b.json")).toEqual({ search: "a=b" });
  });

  test("a failed provider isn't asked again for 2 minutes, and repeats count once (negative cache)", async () => {
    const spy = jest.spyOn(m3u, "parseM3U").mockRejectedValue(new Error("Request failed with status code 521"));
    const cfg = enc({ t: "m3u", m: "http://example.com/dead-provider.m3u" });
    const today = () => new Date().toISOString().slice(0, 10);
    const before = (await stats()).history.find(h => h.date === today()) || {};
    const errLog = jest.spyOn(console, "error").mockImplementation(() => {});

    for (let i = 0; i < 5; i++) {
      const res = await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`);
      expect(res.body.metas[0].id).toBe("iptv_notice_provider_down"); // users still see why
    }
    expect(spy).toHaveBeenCalledTimes(1);

    const s = await stats();
    const after = s.history.find(h => h.date === today());
    expect(s.caches.failedProviders).toBeGreaterThanOrEqual(1);
    // one real provider failure (logged + counted), four answered from memory
    expect(after.catalogErrors - (before.catalogErrors || 0)).toBe(1);
    expect(after.cachedFailures - (before.cachedFailures || 0)).toBe(4);
    expect(errLog.mock.calls.filter(c => String(c[0]).startsWith("Catalog error")).length).toBe(1);
  });

  test("https/http mix-up and provider 429 get their own tiles", async () => {
    jest.spyOn(m3u, "parseM3U")
      .mockRejectedValueOnce(new Error("write EPROTO D05DB5D3327F0000:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number"))
      .mockRejectedValueOnce(new Error("Request failed with status code 429"));
    const tls = await request(app).get(`/${enc({ t: "m3u", m: "https://example.com/tls.m3u" })}/catalog/tv/iptv_live.json`);
    expect(tls.body.metas[0]).toMatchObject({ id: "iptv_notice_https_mismatch", name: "⚠️ Use http:// not https://" });
    const limited = await request(app).get(`/${enc({ t: "m3u", m: "http://example.com/limited.m3u" })}/catalog/tv/iptv_live.json`);
    expect(limited.body.metas[0]).toMatchObject({ id: "iptv_notice_provider_limited", name: "⚠️ Provider is limiting requests" });
    const meta = await request(app).get(`/${enc({ t: "m3u", m: "http://example.com/x.m3u" })}/meta/tv/iptv_notice_https_mismatch.json`);
    expect(meta.body.meta.description).toMatch(/start with http:\/\//);
  });

  test("Test Connection explains the https/http mix-up and provider 429", async () => {
    jest.spyOn(m3u, "parseM3UGroups")
      .mockRejectedValueOnce(new Error("write EPROTO ...:SSL routines:tls_validate_record_header:wrong version number"))
      .mockRejectedValueOnce(new Error("Request failed with status code 429"));
    const a = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "https://example.com/test-tls.m3u" });
    expect(a.body.error).toBe("Your server address should probably start with http:// instead of https://");
    const b = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "http://example.com/test-429.m3u" });
    expect(b.body.error).toBe("Your provider is limiting requests — try again in a few minutes");
  });

  test("unknown paths are listed with install links hidden", async () => {
    await request(app).get("/e-0123456789abcdef0123456789abcdef0123456789/addon_catalog/tv/tt1.json");
    const entry = (await stats()).recentUnknownPaths[0];
    expect(entry).toMatchObject({ method: "GET", path: "/<config>/addon_catalog/tv/tt1.json" });
    expect(JSON.stringify((await stats()).recentUnknownPaths)).not.toContain("0123456789abcdef");
  });

  test("empty stream results are listed with the reason", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U\n#EXTINF:-1 tvg-id="here",Here\nhttp://example.com/1.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://example.com/empty-streams.m3u" });
    await request(app).get(`/${cfg}/stream/tv/iptv_tv_gone.json`);
    expect((await stats()).recentEmptyStreams[0]).toMatchObject({
      source: "m3u", type: "tv", id: "iptv_tv_gone", reason: expect.stringMatching(/no longer in the user's playlist/),
    });
  });

  test("other addons' items (IMDb movies/series) are answered without downloading the playlist", async () => {
    const spy = jest.spyOn(m3u, "parseM3U");
    const cfg = enc({ t: "m3u", m: "http://example.com/foreign-ids.m3u" });
    const today = () => new Date().toISOString().slice(0, 10);
    const before = ((await stats()).history.find(h => h.date === today()) || {}).foreignRequests || 0;

    expect((await request(app).get(`/${cfg}/stream/series/tt33539520:1:1.json`)).body).toEqual({ streams: [] });
    expect((await request(app).get(`/${cfg}/stream/movie/tt30796986.json`)).body).toEqual({ streams: [] });
    expect((await request(app).get(`/${cfg}/stream/tv/tt123.json`)).body).toEqual({ streams: [] });
    expect((await request(app).get(`/${cfg}/meta/series/tt33539520.json`)).body.meta.name).toBe("Unknown");

    expect(spy).not.toHaveBeenCalled();
    const after = (await stats()).history.find(h => h.date === today()).foreignRequests;
    expect(after - before).toBe(4);
  });
});

// ─── Fixes from live stats (2026-10-15, evening) ───

describe("live-stats fixes 2", () => {
  const m3u = require("../m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("a channel without tvg-id is still found after the playlist order changed", async () => {
    // saved when "Fox News Now" was the 3rd entry (…_2); now a channel was added above it
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1,New Channel
http://example.com/new.m3u8
#EXTINF:-1,Alpha
http://example.com/a.m3u8
#EXTINF:-1,Beta
http://example.com/b.m3u8
#EXTINF:-1,Fox News Now
http://example.com/fox.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://example.com/reordered.m3u" });
    const streams = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_m3u_fox_news_now_2.json`)).body.streams;
    expect(streams.map(s => s.url)).toEqual(["http://example.com/fox.m3u8"]);
    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_tv_m3u_fox_news_now_2.json`)).body.meta;
    expect(meta.name).toBe("Fox News Now");
    // a name that isn't in the playlist anymore still returns nothing
    expect((await request(app).get(`/${cfg}/stream/tv/iptv_tv_m3u_gone_channel_5.json`)).body.streams).toEqual([]);
  });

  test("apps that keep manifest.json in the path still work", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U\n#EXTINF:-1 tvg-id="a",Alpha\nhttp://example.com/a.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://example.com/manifest-path.m3u" });
    const cat = await request(app).get(`/${cfg}/manifest.json/catalog/tv/iptv_live.json`);
    expect(cat.body.metas.map(m => m.name)).toEqual(["Alpha"]);
    const meta = await request(app).get(`/${cfg}/manifest.json/meta/tv/iptv_tv_a.json`);
    expect(meta.body.meta.name).toBe("Alpha");
    // the manifest itself is unchanged
    expect((await request(app).get(`/${cfg}/manifest.json`)).body.id).toBe("community.streamvault.addon");
  });

  test("Stremio routes allow bursts of 1500 requests per minute per IP", async () => {
    const ip = "203.0.113.90";
    const statuses = [];
    for (let i = 0; i < 400; i++) statuses.push((await request(app).get("/manifest.json").set("Fly-Client-IP", ip)).status);
    expect(statuses.every(s => s === 200)).toBe(true); // 400 > old limit of 300
  }, 60000);
});

// ─── Privacy + setup help (2026-10-16) ───

describe("IP masking, Xtream link paste, no-channel reasons, bad link log", () => {
  const m3u = require("../m3u");
  const xtream = require("../xtream");
  const { maskIp } = require("../ratelimit");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const stats = async () => (await request(app).get("/stats")).body;
  afterEach(() => jest.restoreAllMocks());

  test("IPs are masked in log lines", async () => {
    expect(maskIp("203.0.113.45")).toBe("203.0.113.x");
    expect(maskIp("::ffff:198.51.100.7")).toBe("198.51.100.x");
    expect(maskIp("2a00:4804:d000:33d:58c5:cf7a:67b9:7037")).toBe("2a00:4804:d000:33d:x");
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    await request(app).get("/configure").set("Fly-Client-IP", "203.0.113.77");
    await request(app).get(`/${enc({ t: "m3u", m: "http://example.com/mask.m3u" })}/manifest.json`).set("Fly-Client-IP", "203.0.113.78");
    const lines = log.mock.calls.map(c => String(c[0])).filter(l => /^\[(CONFIGURE|INSTALL)\]/.test(l));
    expect(lines.join("\n")).toContain("203.0.113.x");
    expect(lines.join("\n")).not.toMatch(/203\.0\.113\.7[78]/);
  });

  test("a full Xtream link pasted as the server is split into server + login", async () => {
    const cats = jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([{ category_id: 1, category_name: "Sport" }]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const res = await request(app).post("/api/test").send({
      type: "xtream", server: "http://example.com:8080/get.php?username=abc&password=123&type=m3u_plus&output=ts", username: "", password: "",
    });
    expect(res.body.ok).toBe(true);
    expect(cats).toHaveBeenCalledWith(expect.objectContaining({ server: "http://example.com:8080", username: "abc", password: "123" }));
  });

  test("an installed link with a full Xtream link as server still loads channels", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    const streams = jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 1, name: "One" }]);
    const cfg = enc({ t: "xtream", s: "http://example.com:8080/player_api.php?username=u1&password=p1", u: "", p: "" });
    const cat = await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`);
    expect(cat.body.metas.map(m => m.name)).toEqual(["One"]);
    expect(streams).toHaveBeenCalledWith(expect.objectContaining({ server: "http://example.com:8080", username: "u1", password: "p1" }));
  });

  test("the parser records what a playlist looked like", () => {
    const shapeOf = (content) => {
      const { Readable } = require("stream");
      const axios = require("axios");
      const urlguard = require("../urlguard");
      jest.spyOn(urlguard, "assertExternalUrl").mockResolvedValue();
      jest.spyOn(axios, "get").mockResolvedValue({ data: Readable.from([content]) });
      return m3u.parseM3UGroups("http://example.com/x.m3u").then(g => { jest.restoreAllMocks(); return g.shape; });
    };
    return (async () => {
      const html = await shapeOf("<!DOCTYPE html>\n<html><body>Login</body></html>");
      const vod = await shapeOf("#EXTM3U\n#EXTINF:-1,Film\nhttp://example.com/movie/1.mp4\n#EXTINF:-1,Show\nhttp://example.com/series/2.mkv");
      const bare = await shapeOf("http://example.com/a.ts\nhttp://example.com/b.ts");
      expect(html.html).toBe(true);
      expect(vod).toMatchObject({ vod: 2, extinf: 2 });
      expect(bare).toMatchObject({ extinf: 0, bareUrls: 2 });
    })();
  });

  test.each([
    [{ html: true, lines: 3 }, /web page, not a playlist/, "no_channels_web_page"],
    [{ vod: 120, extinf: 120, lines: 241 }, /only has movies\/series \(120\)/, "no_channels_vod_only"],
    [{ lines: 0 }, /empty/, "no_channels_empty"],
    [{ lines: 2, extinf: 0, bareUrls: 2 }, /doesn't look like an M3U/, "no_channels_not_m3u"],
  ])("Test Connection explains a playlist without live TV (%j)", async (shape, message, kind) => {
    const groups = [];
    groups.shape = shape;
    jest.spyOn(m3u, "parseM3UGroups").mockResolvedValue(groups);
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: `http://example.com/no-live-${kind}.m3u` });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(message);
    const row = (await stats()).history.find(h => h.date === today);
    expect(row.providerErrors["test (m3u)"][kind]).toBeGreaterThanOrEqual(1);
  });

  test("refused install links are listed with the reason", async () => {
    await request(app).get("/garbage/manifest.json").set("User-Agent", "OldStremio/0.1");
    expect((await stats()).recentBadLinks[0]).toMatchObject({
      route: "/:config/manifest.json", reason: expect.stringMatching(/install link/), userAgent: "OldStremio/0.1",
    });
  });
});

// ─── Failed Test Connection: address shape ───

describe("failed tests record the address shape (private parts hidden)", () => {
  const m3u = require("../m3u");
  const xtream = require("../xtream");
  const lastFailure = async () => (await request(app).get("/stats")).body.recentTestFailures[0];
  afterEach(() => jest.restoreAllMocks());

  test("Xtream 404 with a path in the server address", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockRejectedValue(new Error("Request failed with status code 404"));
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    await request(app).post("/api/test").send({ type: "xtream", server: "http://example.com:8080/myuser/c/", username: "secretuser", password: "secretpass" });
    const f = await lastFailure();
    expect(f).toMatchObject({ source: "xtream", error: "404", address: "http://<host>:8080/<seg>/<seg>/" });
    expect(JSON.stringify(f)).not.toMatch(/example\.com|myuser|secret/);
  });

  test("M3U link: known file names kept, tokens and query hidden", async () => {
    jest.spyOn(m3u, "parseM3UGroups").mockRejectedValue(new Error("Request failed with status code 404"));
    await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "https://example.com/token123abc/playlist.m3u8?key=abc" });
    const f = await lastFailure();
    expect(f).toMatchObject({ source: "m3u", error: "404", address: "https://<host>/<seg>/playlist.m3u8?…" });
    expect(JSON.stringify(f)).not.toMatch(/example\.com|token123abc|key=abc/);
  });
});

// ─── /play diagnostics ───

describe("/play refusals are recorded with the reason", () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const xt = enc({ t: "xtream", s: "http://example.com:8080", u: "user", p: "pass" });
  const lastReject = async () => (await request(app).get("/stats")).body.recentPlayRejects[0];

  test("letter/digit stream ids are now allowed", async () => {
    const res = await request(app).get(`/play/${xt}/live/ab12_C-3/ts/Channel`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://example.com:8080/live/user/pass/ab12_C-3.ts");
  });

  test.each([
    ["movie type", `/play/${xt}/movie/1/ts/x`, /stream type "movie"/],
    ["bad id", `/play/${xt}/live/a.b/ts/x`, /unexpected characters/],
    ["bad format", `/play/${xt}/live/1/mp4/x`, /format "mp4"/],
    ["broken link", `/play/garbage/live/1/ts/x`, /install link/],
    ["private server", `/play/${enc({ t: "xtream", s: "http://192.168.1.1", u: "u", p: "p" })}/live/1/ts/x`, /server address/],
  ])("%s → 400 with reason", async (_, path, reason) => {
    expect((await request(app).get(path)).status).toBe(400);
    const r = await lastReject();
    expect(r.reason).toMatch(reason);
    expect(JSON.stringify(r)).not.toContain("pass");
  });
});

// ─── Addon installed without configuring ───

describe("installs without settings (bare manifest)", () => {
  const stats = async () => (await request(app).get("/stats")).body;

  test("bare catalog gets a 'Set up StreamVault first' tile, logged with the app's User-Agent", async () => {
    const before = (await stats()).history[0].unconfigured || 0;
    const res = await request(app).get("/catalog/tv/iptv_live.json").set("User-Agent", "StremioTV/1.0 (old build)");
    expect(res.status).toBe(200);
    expect(res.body.metas).toEqual([expect.objectContaining({ id: "iptv_notice_setup", name: "⚠️ Set up StreamVault first" })]);

    const s = await stats();
    expect(s.history[0].unconfigured).toBe(before + 1);
    expect(s.recentUnconfigured[0]).toMatchObject({ path: "/catalog/tv/iptv_live.json", userAgent: "StremioTV/1.0 (old build)" });
  });

  test("film/series requests to an empty install count as foreign, not unconfigured", async () => {
    const before = (await stats()).history[0];
    for (const path of ["/stream/series/tt40385667:1:1.json", "/stream/anime/tt40385667:1:1.json", "/meta/movie/tt1.json"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
    }
    const after = (await stats()).history[0];
    expect(after.unconfigured || 0).toBe(before.unconfigured || 0);
    expect(after.foreignRequests).toBe((before.foreignRequests || 0) + 3);
  });

  test("bare search/next pages, channel page and stream are handled too", async () => {
    expect((await request(app).get("/catalog/tv/iptv_live/search=news.json")).body.metas[0].id).toBe("iptv_notice_setup");
    expect((await request(app).get("/catalog/tv/iptv_live/skip=100.json")).body.metas).toEqual([]);
    const meta = (await request(app).get("/meta/tv/iptv_tv_1.json")).body.meta;
    expect(meta.description).toMatch(/^On this phone: tap Play to set up\./);
    expect(meta.description).toContain("https://streamvault.fly.dev/setup");
    expect(meta.links).toEqual([{ name: "Set up StreamVault", category: "Setup", url: "https://streamvault.fly.dev/setup?via=link" }]);
    expect(meta.description).toMatch(/Sync addons/);
    expect(meta.background).toBe("https://streamvault.fly.dev/public/img/setup-bg.png?v=3");
    expect((await request(app).get("/stream/tv/iptv_tv_1.json")).body.streams).toEqual([]);
    // Play on the setup tile opens the setup page (phones can't scan their own screen)
    expect((await request(app).get("/stream/tv/iptv_notice_setup.json")).body.streams).toEqual([
      { name: "StreamVault", title: "Open setup page", externalUrl: "https://streamvault.fly.dev/setup?via=play" },
    ]);
  });

  test("the setup tile's picture is a QR code to /setup, which is counted and opens the configure page", async () => {
    const tile = (await request(app).get("/catalog/tv/iptv_live.json")).body.metas[0];
    expect(tile.poster).toBe("https://streamvault.fly.dev/public/img/setup-qr.png?v=2");
    for (const file of ["setup-qr.png", "setup-bg.png"]) {
      const res = await request(app).get(`/public/img/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("image/png");
    }
    const img = await request(app).get("/public/img/setup-qr.png");
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");

    const before = (await stats()).history[0].setupScans || 0;
    const res = await request(app).get("/setup");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/configure?from=tile");
    expect((await stats()).history[0].setupScans).toBe(before + 1);

    // Taps from a phone (Play / link chip) are counted apart from scans
    const taps = (await stats()).history[0].setupTaps || 0;
    const tapped = await request(app).get("/setup?via=play");
    expect(tapped.headers.location).toBe("/configure?from=tile");
    const after = (await stats()).history[0];
    expect(after.setupTaps).toBe(taps + 1);
    expect(after.setupScans).toBe(before + 1);
  });

  test("the configure page shows the TV tip, and the tile banner only when opened from the tile", async () => {
    const page = (await request(app).get("/configure").set("Fly-Client-IP", "198.51.100.71")).text;
    expect(page).toContain("Watching on a TV?");
    expect(page).toMatch(/id="tileBanner" style="display: none;/);
    expect(page).toContain("get('from') === 'tile'");
  });

  test("subtitle requests (apps asking every addon) get an empty list, not a 404", async () => {
    const enc = Buffer.from(JSON.stringify({ t: "m3u", m: "http://example.com/subs.m3u" })).toString("base64").replace(/=+$/, "");
    const before = (await stats()).history[0].foreignRequests || 0;
    for (const path of [
      `/${enc}/subtitles/movie/tt32890033.json`,
      `/${enc}/subtitles/series/tt9813792:4:1/${enc}`,
      "/subtitles/series/tt1567432:2:2.json",
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ subtitles: [] });
    }
    expect((await stats()).history[0].foreignRequests).toBe(before + 3);
  });

  test("robots.txt lets crawlers see the configure page only", async () => {
    const res = await request(app).get("/robots.txt");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.text).toBe("User-agent: *\nAllow: /configure\nAllow: /public/\nDisallow: /\n");
  });

  test("an Xtream test with a playlist link says to use the M3U tab", async () => {
    const xtream = require("../xtream");
    const cats = jest.spyOn(xtream, "getLiveCategories");
    for (const server of ["https://provider.example/abc/index.m3u", "http://gfdg.m3u", "http://p.example/list.m3u8?token=x"]) {
      const res = await request(app).post("/api/test").send({ type: "xtream", server, username: "u", password: "p" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/use the M3U tab/);
    }
    expect(cats).not.toHaveBeenCalled();
    cats.mockRestore();
  });

  test("players probing for subtitles next to the install link are counted, not listed", async () => {
    const s0 = await stats();
    for (const ext of ["srt", "vtt", "dfxp"]) {
      const res = await request(app).head(`/e-0123456789abcdef/manifest.${ext}`);
      expect(res.status).toBe(404);
    }
    const s1 = await stats();
    expect(s1.history[0].subtitleProbes).toBe((s0.history[0].subtitleProbes || 0) + 3);
    expect(JSON.stringify(s1.recentUnknownPaths)).not.toMatch(/manifest\.(srt|vtt|dfxp)/);
  });

  test("an address with a guide's placeholder left in gets a replace-it hint, no download", async () => {
    const parse = jest.spyOn(require("../m3u"), "parseM3UGroups");
    for (const m3uUrl of ["https://host.example/a/b/%3CFILENAME%3E.m3u", "https://host.example/<FILENAME>.m3u"]) {
      const res = await request(app).post("/api/test").send({ type: "m3u", m3uUrl });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/placeholder like <FILENAME>/);
    }
    const xt = await request(app).post("/api/test").send({ type: "xtream", server: "http://<your-server>:8080", username: "u", password: "p" });
    expect(xt.body.error).toMatch(/placeholder .* server address/);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  test("streaming-server probes are counted, not listed as unknown paths", async () => {
    const s0 = await stats();
    const res = await request(app).get("/c9c097cf5c1eb9fd0d910001980d191796bd3ba0/0/stats.json");
    expect(res.status).toBe(404);
    const s1 = await stats();
    expect(s1.history[0].streamingServerProbes).toBe((s0.history[0].streamingServerProbes || 0) + 1);
    expect(s1.recentUnknownPaths[0] && s1.recentUnknownPaths[0].path).not.toMatch(/stats\.json/);
    expect((s1.history[0].responseErrors["unknown path"] || {})["404"]).toBe((s0.history[0].responseErrors["unknown path"] || {})["404"]);
  });

  test("other unknown paths are still 404 and now show the User-Agent", async () => {
    await request(app).get("/x/other.json").set("User-Agent", "SomeBot/2.0");
    expect((await stats()).recentUnknownPaths[0]).toMatchObject({ path: "/x/other.json", userAgent: "SomeBot/2.0" });
  });
});

// ─── Configure page visit counting ───

describe("configure visit counting", () => {
  const configures = async () => (await request(app).get("/stats")).body.configures;

  test("HEAD and a quick repeat from the same IP count once; another IP counts", async () => {
    const before = await configures();
    await request(app).head("/configure").set("Fly-Client-IP", "198.51.100.61");
    await request(app).get("/configure").set("Fly-Client-IP", "198.51.100.61");
    await request(app).get("/configure").set("Fly-Client-IP", "198.51.100.61");
    expect(await configures()).toBe(before + 1);
    const page = await request(app).get("/e-abc/configure").set("Fly-Client-IP", "198.51.100.62");
    expect(page.status).toBe(200);
    expect(page.text).toContain("<html");
    expect(await configures()).toBe(before + 2);
  });
});

// ─── Browser fallback ───

describe("unknown pages", () => {
  test.each(["/", "/some/old/link", "/home"])("GET %s redirects to /configure", async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/configure");
  });

  test("HEAD / redirects too (uptime monitors), not a 404", async () => {
    const res = await request(app).head("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/configure");
  });

  test.each(["/api/nope", "/x/unknown.json", "/sitemap.xml", "/index.html", "/icon-192.png"])(
    "GET %s stays a JSON 404 (never a second configure page)", async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });
    });

  test.each(["/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/apple-touch-icon-240x240.png", "/apple-touch-icon-240x240-precomposed.png"])(
    "GET %s returns the logo (browsers ask for it on every visit)", async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/image\/png/);
      expect(res.headers["cache-control"]).toMatch(/max-age=604800/);
    });

  test("the configure page points browsers at its icon", async () => {
    const res = await request(app).get("/configure").set("Fly-Client-IP", "198.51.100.70");
    expect(res.text).toContain('<link rel="icon" type="image/png" href="/public/img/logo.png" />');
  });
});

// ─── Stats history + failure tracking ───

describe("stats history and failures", () => {
  const m3u = require("../m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const today = () => new Date().toISOString().slice(0, 10);
  const todayRow = async () => (await request(app).get("/stats")).body.history.find(r => r.date === today());
  afterEach(() => jest.restoreAllMocks());

  test("counts today's launches, searches and streams (incl. empty results)", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U\n#EXTINF:-1 tvg-id="h1",Hist One\nhttp://example.com/1.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://example.com/history.m3u" });
    const before = (await todayRow()) || { launches: 0, searches: 0, streams: 0, emptyStreams: 0 };

    await request(app).get(`/${cfg}/manifest.json`);
    await request(app).get(`/${cfg}/catalog/tv/iptv_live/search=hist.json`);
    await request(app).get(`/${cfg}/stream/tv/iptv_tv_h1.json`);
    await request(app).get(`/${cfg}/stream/tv/iptv_tv_missing.json`);

    const after = await todayRow();
    expect(after.launches - before.launches).toBe(1);
    expect(after.searches - before.searches).toBe(1);
    expect(after.streams - before.streams).toBe(2);
    expect(after.emptyStreams - before.emptyStreams).toBe(1);
    expect(after.dau).toBeGreaterThanOrEqual(1);
  });

  test("search ignores accents, punctuation and Cyrillic vs Latin", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent([
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="s1",La Vie Rêve', "http://example.com/1.m3u8",
      '#EXTINF:-1 tvg-id="s2",БНТ 1 HD', "http://example.com/2.m3u8",
      '#EXTINF:-1 tvg-id="s3",Nova-Sport', "http://example.com/3.m3u8",
      '#EXTINF:-1 tvg-id="s4",Ćirilica Đorđe', "http://example.com/4.m3u8",
    ].join("\n")));
    const cfg = enc({ t: "m3u", m: "http://example.com/search-norm.m3u" });
    const names = async (q) => (await request(app).get(`/${cfg}/catalog/tv/iptv_live/search=${encodeURIComponent(q)}.json`)).body.metas.map(m => m.name);

    expect(await names("la vie reve")).toEqual(["La Vie Rêve"]);
    expect(await names("RÊVE")).toEqual(["La Vie Rêve"]);
    expect(await names("bnt 1")).toEqual(["БНТ 1 HD"]);
    expect(await names("бнт")).toEqual(["БНТ 1 HD"]);
    expect(await names("nova sport")).toEqual(["Nova-Sport"]);
    expect(await names("нова")).toEqual(["Nova-Sport"]);
    expect(await names("cirilica dorde")).toEqual(["Ćirilica Đorđe"]);
    expect(await names("bnt nova")).toEqual([]);
  });

  test("one failed download shared by many waiting requests counts as one error", async () => {
    // slow failure so all requests wait for the same download
    jest.spyOn(m3u, "parseM3U").mockImplementation(() =>
      new Promise((_, reject) => setTimeout(() => reject(new Error("Request failed with status code 451")), 100)));
    const cfg = enc({ t: "m3u", m: "http://example.com/shared-failure.m3u" });
    const before = (await todayRow()) || {};
    const errBefore = (before.metaErrors || 0), cachedBefore = (before.cachedFailures || 0);
    const code451 = (row) => (row.providerErrors?.["meta (m3u)"]?.["451"]) || 0;

    await Promise.all([1, 2, 3, 4, 5].map(i => request(app).get(`/${cfg}/meta/tv/iptv_tv_ch${i}.json`)));

    const after = await todayRow();
    expect(after.metaErrors - errBefore).toBe(1);
    expect(code451(after) - code451(before)).toBe(1);
    expect(after.cachedFailures - cachedBefore).toBe(4);
  });

  test("a failing provider is counted and listed without URLs or credentials", async () => {
    jest.spyOn(m3u, "parseM3U").mockRejectedValue(new Error("connect ECONNREFUSED http://secret-user:pw@provider.example/list"));
    const cfg = enc({ t: "m3u", m: "http://example.com/failing.m3u" });
    const before = (await todayRow()) || { catalogErrors: 0 };

    const res = await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`);
    expect(res.body.metas.map(m => m.id)).toEqual(["iptv_notice_bad_address"]);

    const stats = (await request(app).get("/stats")).body;
    const after = stats.history.find(r => r.date === today());
    expect(after.catalogErrors - (before.catalogErrors || 0)).toBe(1);
    expect(stats.recentErrors[0]).toMatchObject({ where: "catalog", source: "m3u", error: "Connection failed" });
    expect(JSON.stringify(stats.recentErrors)).not.toContain("secret-user");
  });
});

// ─── /play redirect ───

describe("/play redirect", () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const xt = enc({ t: "xtream", s: "http://example.com:8080", u: "user", p: "pass" });

  test("redirects a valid live stream to the provider", async () => {
    const res = await request(app).get(`/play/${xt}/live/123/ts/Diema%20Sport`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://example.com:8080/live/user/pass/123.ts");
  });

  test("a failing DNS lookup on our side doesn't block play (the player connects, not us)", async () => {
    const dns = require("node:dns");
    const lookup = jest.spyOn(dns.promises, "lookup").mockRejectedValue(new Error("getaddrinfo EAI_AGAIN"));
    const cfg = enc({ t: "xtream", s: "http://dns-hiccup.example.net:8080", u: "user", p: "pass" });
    const res = await request(app).get(`/play/${cfg}/live/77/ts/x`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://dns-hiccup.example.net:8080/live/user/pass/77.ts");
    expect(lookup).not.toHaveBeenCalled();
    lookup.mockRestore();
    // literal internal addresses are still refused
    const internal = enc({ t: "xtream", s: "http://192.168.1.10:8080", u: "user", p: "pass" });
    expect((await request(app).get(`/play/${internal}/live/77/ts/x`)).status).toBe(400);
  });

  test.each([
    ["non-live type", `/play/${xt}/movie/123/ts/x`],
    ["non-numeric id", `/play/${xt}/live/..%2F..%2Fevil/ts/x`],
    ["unknown extension", `/play/${xt}/live/123/html/x`],
  ])("rejects %s", async (_, path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(400);
  });

  test("rejects a private server and M3U configs", async () => {
    const priv = enc({ t: "xtream", s: "http://192.168.1.1", u: "u", p: "p" });
    expect((await request(app).get(`/play/${priv}/live/1/ts/x`)).status).toBe(400);
    const m3uCfg = enc({ t: "m3u", m: "http://example.com/x.m3u" });
    expect((await request(app).get(`/play/${m3uCfg}/live/1/ts/x`)).status).toBe(400);
  });
});

// ─── Xtream account info + EPG timezone ───

describe("formatAccountInfo", () => {
  test("formats a full user_info", () => {
    expect(formatAccountInfo({ status: "Active", exp_date: "1796083200", max_connections: "2", active_cons: "1", is_trial: "0" }))
      .toBe("Account: Active · expires 2026-12-01 · 1/2 connections");
  });
  test("handles no expiry and trial", () => {
    expect(formatAccountInfo({ status: "Active", exp_date: null, is_trial: "1" })).toBe("Account: Active · trial · no expiry");
  });
  test("returns empty string for missing info", () => {
    expect(formatAccountInfo(null)).toBe("");
    expect(formatAccountInfo({})).toBe("");
  });
});

describe("epgTimeRange", () => {
  const entry = { start: "2026-10-12 20:00:00", end: "2026-10-12 21:00:00", start_timestamp: "1791824400", stop_timestamp: "1791828000" };
  test("formats in the viewer's timezone when known", () => {
    expect(epgTimeRange(entry, "Europe/Sofia")).toBe("20:00 - 21:00");
    expect(epgTimeRange(entry, "UTC")).toBe("17:00 - 18:00");
  });
  test("falls back to provider strings without (or with invalid) timezone", () => {
    expect(epgTimeRange(entry, "")).toBe("20:00 - 21:00");
    expect(epgTimeRange({ ...entry, start: "2026-10-12 09:00:00", end: "2026-10-12 10:00:00" }, "Not/AZone")).toBe("09:00 - 10:00");
  });
});

describe("timezone config key", () => {
  test("/api/encrypt keeps z and parseConfigPath exposes it", async () => {
    const res = await request(app).post("/api/encrypt").send({ t: "m3u", m: "http://example.com/x.m3u", z: "Europe/Sofia" });
    expect(parseConfigPath(res.body.config).timezone).toBe("Europe/Sofia");
  });
});

// ─── SSRF guard on fetch paths ───

describe("outbound fetch SSRF guard", () => {
  const m3uReal = jest.requireActual("../m3u");
  const xtream = require("../xtream");

  test("parseM3U refuses a private playlist URL", async () => {
    await expect(m3uReal.parseM3U("http://169.254.169.254/latest")).rejects.toThrow("Invalid or blocked URL");
  });

  test("xtream calls refuse a private server", async () => {
    const config = { server: "http://10.0.0.1:8080", username: "u", password: "p" };
    await expect(xtream.getLiveStreams(config)).rejects.toThrow("Invalid or blocked URL");
  });

  test("isPrivateIp catches bracketed and IPv4-mapped IPv6", () => {
    expect(isPrivateIp("[::1]")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("[fdaa:0:1::2]")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
  });
});

// ─── HTTP API tests ───

describe("API endpoints", () => {
  test("GET /manifest.json returns valid manifest", async () => {
    const res = await request(app).get("/manifest.json");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("community.streamvault.addon");
    expect(res.body.name).toBe("StreamVault IPTV");
    expect(res.body.resources).toContain("catalog");
    expect(res.body.resources).toContain("stream");
    expect(res.body.types).toContain("tv");
    expect(res.body.behaviorHints.configurable).toBe(true);
    expect(res.body.behaviorHints.configurationRequired).toBe(true);
  });

  test("GET /:config/manifest.json returns configured manifest", async () => {
    // Provider down → manifest still served, just without the genre filter
    const xtream = require("../xtream");
    jest.spyOn(xtream, "getLiveStreams").mockRejectedValue(new Error("down"));
    const config = { t: "xtream", s: "http://example.com", u: "user", p: "pass", c: "" };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await request(app).get(`/${encoded}/manifest.json`);
    jest.restoreAllMocks();
    expect(res.body.catalogs[0].extra.map(e => e.name)).toEqual(["search", "skip"]);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("community.streamvault.addon");
    expect(res.body.behaviorHints.configurable).toBe(true);
    expect(res.body.behaviorHints.configurationRequired).toBeUndefined();
  });

  test("GET /:config/manifest.json rejects invalid config", async () => {
    const config = { t: "xtream", s: "", u: "", p: "", c: "" };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await request(app).get(`/${encoded}/manifest.json`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("GET /configure serves HTML", async () => {
    const res = await request(app).get("/configure");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/html/);
  });

  test("OPTIONS requests return 204 (CORS preflight)", async () => {
    const res = await request(app).options("/manifest.json");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });

  test("GET /health returns ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("GET /stats returns stats object", async () => {
    const res = await request(app).get("/stats");
    expect(res.status).toBe(200);
    expect(res.body.addon).toBe("StreamVault IPTV");
    expect(typeof res.body.installs).toBe("number");
    expect(typeof res.body.uniqueUsers).toBe("number");
  });

  test("POST /api/test rejects missing type", async () => {
    const res = await request(app)
      .post("/api/test")
      .send({});
    expect(res.status).toBe(400);
  });

  test("POST /api/test rejects xtream with missing credentials", async () => {
    const res = await request(app)
      .post("/api/test")
      .send({ type: "xtream" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test("POST /api/test rejects m3u with missing URL", async () => {
    const res = await request(app)
      .post("/api/test")
      .send({ type: "m3u" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test("POST /api/categories rejects missing credentials", async () => {
    const res = await request(app)
      .post("/api/categories")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test("POST /api/encrypt returns encrypted config", async () => {
    const res = await request(app)
      .post("/api/encrypt")
      .send({ t: "xtream", s: "http://example.com", u: "user", p: "pass", c: "" });
    expect(res.status).toBe(200);
    expect(res.body.config).toMatch(/^e-[0-9a-f]+$/i);
  });

  test("POST /api/encrypt rejects missing type", async () => {
    const res = await request(app)
      .post("/api/encrypt")
      .send({});
    expect(res.status).toBe(400);
  });

  test("encrypted config round-trip works end-to-end", async () => {
    // Encrypt via API
    const encRes = await request(app)
      .post("/api/encrypt")
      .send({ t: "xtream", s: "http://test.com", u: "admin", p: "secret", c: "1,2" });
    const configPath = encRes.body.config;
    // Use encrypted config to fetch manifest
    const manifestRes = await request(app).get(`/${configPath}/manifest.json`);
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.body.id).toBe("community.streamvault.addon");
  });
});

// ─── Encryption ───

describe("encryptConfig / decryptConfig", () => {
  test("encrypts and decrypts correctly", () => {
    const original = { t: "xtream", s: "http://test.com", u: "user", p: "pass123", c: "5" };
    const encrypted = encryptConfig(original);
    const decrypted = decryptConfig(encrypted);
    expect(decrypted).toEqual(original);
  });

  test("different encryptions produce different ciphertexts (random IV)", () => {
    const config = { t: "xtream", s: "http://test.com", u: "user", p: "pass", c: "" };
    const enc1 = encryptConfig(config);
    const enc2 = encryptConfig(config);
    expect(enc1).not.toBe(enc2);
  });

  test("tampered ciphertext throws", () => {
    const config = { t: "xtream", s: "http://test.com", u: "user", p: "pass", c: "" };
    const encrypted = encryptConfig(config);
    // Corrupt the auth tag (chars 24-56) to guarantee authentication failure
    const tampered = encrypted.slice(0, 24) + "00".repeat(16) + encrypted.slice(56);
    expect(() => decryptConfig(tampered)).toThrow();
  });
});

// ─── SSRF protection ───

describe("isPrivateIp", () => {
  test("blocks 127.x.x.x (loopback)", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.99.99.99")).toBe(true);
  });

  test("blocks 10.x.x.x (private)", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  test("blocks 192.168.x.x (private)", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("192.168.255.255")).toBe(true);
  });

  test("blocks 172.16-31.x.x (private)", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  test("blocks 169.254.x.x (link-local)", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  test("blocks IPv6 loopback and private", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fd00:")).toBe(true);
    expect(isPrivateIp("fe80:")).toBe(true);
  });

  test("allows public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("203.0.113.1")).toBe(false);
  });
});

describe("validateExternalUrl", () => {
  test("rejects non-string input", async () => {
    expect(await validateExternalUrl(null)).toBe(false);
    expect(await validateExternalUrl(undefined)).toBe(false);
    expect(await validateExternalUrl(123)).toBe(false);
  });

  test("rejects URLs longer than 2048 chars", async () => {
    const longUrl = "http://example.com/" + "a".repeat(2040);
    expect(await validateExternalUrl(longUrl)).toBe(false);
  });

  test("rejects non-http protocols", async () => {
    expect(await validateExternalUrl("ftp://example.com")).toBe(false);
    expect(await validateExternalUrl("file:///etc/passwd")).toBe(false);
  });

  test("rejects localhost", async () => {
    expect(await validateExternalUrl("http://localhost:8080")).toBe(false);
    expect(await validateExternalUrl("http://127.0.0.1:8080")).toBe(false);
  });

  test("rejects private IP addresses", async () => {
    expect(await validateExternalUrl("http://10.0.0.1/api")).toBe(false);
    expect(await validateExternalUrl("http://192.168.1.1/api")).toBe(false);
    expect(await validateExternalUrl("http://172.16.0.1/api")).toBe(false);
  });

  test("rejects .local and .internal hostnames", async () => {
    expect(await validateExternalUrl("http://myserver.local")).toBe(false);
    expect(await validateExternalUrl("http://service.internal")).toBe(false);
  });

  test("rejects cloud metadata endpoints", async () => {
    expect(await validateExternalUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  test("accepts valid external URLs", async () => {
    expect(await validateExternalUrl("http://example.com")).toBe(true);
    expect(await validateExternalUrl("https://google.com")).toBe(true);
  });
});

// ─── safeError ───

describe("safeError", () => {
  test("strips URLs from error messages", () => {
    const err = new Error("connect ECONNREFUSED http://192.168.1.1:8080/api");
    expect(safeError(err)).toBe("Connection failed");
  });

  test("truncates long error messages", () => {
    const err = new Error("A".repeat(200));
    expect(safeError(err).length).toBeLessThanOrEqual(100);
  });

  test("passes through short safe messages", () => {
    const err = new Error("timeout");
    expect(safeError(err)).toBe("timeout");
  });

  test("handles missing message", () => {
    const err = {};
    expect(safeError(err)).toBe("Unknown error");
  });
});

// ─── SSRF-blocking API tests ───

describe("API SSRF protection", () => {
  test("POST /api/test blocks private server URL", async () => {
    const res = await request(app)
      .post("/api/test")
      .send({ type: "xtream", server: "http://127.0.0.1:8080", username: "user", password: "pass" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blocked/i);
  });

  test("POST /api/test blocks private M3U URL", async () => {
    const res = await request(app)
      .post("/api/test")
      .send({ type: "m3u", m3uUrl: "http://192.168.1.1/playlist.m3u" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blocked/i);
  });

  test("POST /api/categories blocks private server URL", async () => {
    const res = await request(app)
      .post("/api/categories")
      .send({ server: "http://10.0.0.1", username: "user", password: "pass" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blocked/i);
  });

  test("POST /api/test blocks metadata endpoint", async () => {
    const res = await request(app)
      .post("/api/test")
      .send({ type: "xtream", server: "http://169.254.169.254/latest/meta-data/", username: "u", password: "p" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blocked/i);
  });
});

// ─── Encrypt input validation ───

describe("/api/encrypt input validation", () => {
  test("rejects invalid type", async () => {
    const res = await request(app)
      .post("/api/encrypt")
      .send({ t: "malicious", payload: "evil" });
    expect(res.status).toBe(400);
  });

  test("strips unknown fields from config", async () => {
    const res = await request(app)
      .post("/api/encrypt")
      .send({ t: "xtream", s: "http://example.com", u: "user", p: "pass", c: "", evil: "payload", __proto__: { admin: true } });
    expect(res.status).toBe(200);
    // Decrypt and verify no extra fields
    const encStr = res.body.config.slice(2);
    const decrypted = decryptConfig(encStr);
    expect(decrypted.evil).toBeUndefined();
    expect(decrypted.admin).toBeUndefined();
    expect(decrypted.t).toBe("xtream");
  });

  test("truncates excessively long field values", async () => {
    const longValue = "A".repeat(5000);
    const res = await request(app)
      .post("/api/encrypt")
      .send({ t: "m3u", m: longValue, c: "" });
    expect(res.status).toBe(200);
    const encStr = res.body.config.slice(2);
    const decrypted = decryptConfig(encStr);
    expect(decrypted.m.length).toBe(2048);
  });
});
