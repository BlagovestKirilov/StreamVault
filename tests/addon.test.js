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

// ─── /play redirect ───

describe("/play redirect", () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const xt = enc({ t: "xtream", s: "http://example.com:8080", u: "user", p: "pass" });

  test("redirects a valid live stream to the provider", async () => {
    const res = await request(app).get(`/play/${xt}/live/123/ts/Diema%20Sport`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://example.com:8080/live/user/pass/123.ts");
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
