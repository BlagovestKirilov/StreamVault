// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app, parseConfigPath } = require("../src/addon");
const { parseM3UContent } = require("../src/m3u");

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

// ─── M3U group selection ───

describe("M3U group selection", () => {
  const m3u = require("../src/m3u");
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
    const spy = jest.spyOn(m3u, "parseM3U").mockImplementation(async (_url, groups) => m3u.parseM3UContent(playlist, groups));
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
