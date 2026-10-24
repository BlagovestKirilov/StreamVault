// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app } = require("../src/addon");

// ─── M3U streams (variants + labels + headers) ───

describe("M3U stream handler", () => {
  const m3u = require("../src/m3u");
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

  test("returns the channel's quality versions, best first, labelled", async () => {
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
    // falls back to bTV (HD) and offers its versions, best first
    expect(res.body.streams.map(s => s.url)).toEqual(["http://example.com/btv_fhd.ts", "http://example.com/btv_hd.m3u8"]);
  });
});
