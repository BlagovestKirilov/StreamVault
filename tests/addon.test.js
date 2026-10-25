// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app, parseExtra } = require("../src/addon");

// ─── Category (genre) filter ───

describe("category filter", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("M3U: manifest lists playlist groups, catalog filters by genre", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 group-title="Sports & News",Delta Sport
http://example.com/1.m3u8
#EXTINF:-1 group-title="Bulgaria",Alpha
http://example.com/2.m3u8
#EXTINF:-1 group-title="Sports & News",Ridge
http://example.com/3.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://genre-test.example.com/list.m3u" });

    const man = await request(app).get(`/${cfg}/manifest.json`);
    const genre = man.body.catalogs[0].extra.find(e => e.name === "genre");
    expect(genre.options).toEqual(["Bulgaria", "Sports & News"]); // A–Z

    const cat = await request(app).get(`/${cfg}/catalog/tv/iptv_live/genre=${encodeURIComponent("Sports & News")}.json`);
    expect(cat.body.metas.map(m => m.name)).toEqual(["Delta Sport", "Ridge"]);
  });

  test("Xtream: category names become genre options", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([
      { category_id: "1", category_name: "BG | Sport" },
      { category_id: "2", category_name: "BG | Kids" },
    ]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([
      { stream_id: 10, name: "Delta Sport", category_id: "1" },
      { stream_id: 11, name: "Kiddo", category_id: 2 },
    ]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const cfg = enc({ t: "xtream", s: "http://genre-xtream.example.com", u: "u", p: "p", c: "" });

    const man = await request(app).get(`/${cfg}/manifest.json`);
    const genre = man.body.catalogs[0].extra.find(e => e.name === "genre");
    expect(genre.options).toEqual(["BG | Kids", "BG | Sport"]); // A–Z

    const cat = await request(app).get(`/${cfg}/catalog/tv/iptv_live/genre=${encodeURIComponent("BG | Kids")}.json`);
    expect(cat.body.metas.map(m => m.name)).toEqual(["Kiddo"]);
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

// ─── Ids that aren't this install's channels ───

describe("foreign ids", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("an Xtream install offers no (unplayable) streams for an M3U-style id", async () => {
    const streams = jest.spyOn(xtream, "getLiveStreams");
    const cfg = enc({ t: "xtream", s: "http://foreign-xt.example.com", u: "u", p: "p", c: "" });
    for (const id of ["examplemagic.za", "Sample.Love.HD.za (src05)"]) {
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

describe("Sonar fixes", () => {
  test("trailing slashes are trimmed in linear time (no regex backtracking)", () => {
    const { trimTrailingSlashes } = require("../src/urlguard");
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

// ─── Fixes from live stats (2026-10-14) ───

describe("live-stats fixes", () => {
  const m3u = require("../src/m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const stats = async () => (await request(app).get("/stats")).body;
  afterEach(() => jest.restoreAllMocks());

  test("an emoji at the name cut-off no longer breaks the catalog (was 'URI malformed')", async () => {
    // 29 characters, then an emoji: the old substring(0, 30) cut it in half
    const name = "Sport Channel HD Premium 4K S📺 extra";
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 tvg-id="e1" group-title="A" tvg-logo="https://cdn.example.com/e1.png",${name}
http://example.com/1.m3u8
#EXTINF:-1 tvg-id="e2" group-title="B",${name}
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
    expect(errLog.mock.calls.filter(c => String(c[0]).startsWith("Catalog error"))).toHaveLength(1);
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
  const m3u = require("../src/m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("a channel without tvg-id is still found after the playlist order changed", async () => {
    // saved when "Fennec News Now" was the 3rd entry (…_2); now a channel was added above it
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1,New Channel
http://example.com/new.m3u8
#EXTINF:-1,Alpha
http://example.com/a.m3u8
#EXTINF:-1,Beta
http://example.com/b.m3u8
#EXTINF:-1,Fennec News Now
http://example.com/fennec.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://example.com/reordered.m3u" });
    const streams = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_m3u_fennec_news_now_2.json`)).body.streams;
    expect(streams.map(s => s.url)).toEqual(["http://example.com/fennec.m3u8"]);
    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_tv_m3u_fennec_news_now_2.json`)).body.meta;
    expect(meta.name).toBe("Fennec News Now");
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
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
  const { maskIp } = require("../src/ratelimit");
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
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const cfg = enc({ t: "xtream", s: "http://example.com:8080/player_api.php?username=u1&password=p1", u: "", p: "" });
    const cat = await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`);
    expect(cat.body.metas.map(m => m.name)).toEqual(["One"]);
    expect(streams).toHaveBeenCalledWith(expect.objectContaining({ server: "http://example.com:8080", username: "u1", password: "p1" }));
  });

  test("the parser records what a playlist looked like", () => {
    const shapeOf = (content) => {
      const { Readable } = require("stream");
      const axios = require("axios");
      const urlguard = require("../src/urlguard");
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

  test("setting up after the tile is measured: bare users per day, then bareConverted once", async () => {
    const m3u = require("../src/m3u");
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1,One
http://example.com/1.m3u8`));
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const cfg = enc({ t: "m3u", m: "http://example.com/bare-setup.m3u" });
    const as = (ip, path) => request(app).get(path).set("Fly-Client-IP", ip);
    const before = await stats();
    const today = (s, key) => s.history[0][key] || 0;

    // A: only an empty install so far (twice: still one user)
    await as("198.51.100.61", "/catalog/tv/iptv_live.json");
    await as("198.51.100.61", "/catalog/tv/iptv_live.json");
    // B: already set up, plus an old empty install — not someone stuck at setup
    await as("198.51.100.62", `/${cfg}/manifest.json`);
    await as("198.51.100.62", "/catalog/tv/iptv_live.json");
    let s = await stats();
    expect(today(s, "bareUsers")).toBe(today(before, "bareUsers") + 1);
    expect(s.bareUsersWaiting).toBe(before.bareUsersWaiting + 1);

    // A sets up: counted once, however often the configured StreamVault loads
    await as("198.51.100.61", `/${cfg}/manifest.json`);
    await as("198.51.100.61", `/${cfg}/manifest.json`);
    s = await stats();
    expect(today(s, "bareConverted")).toBe(today(before, "bareConverted") + 1);
    expect(s.bareUsersWaiting).toBe(before.bareUsersWaiting);
    jest.restoreAllMocks();
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
    const xtream = require("../src/xtream");
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
    const parse = jest.spyOn(require("../src/m3u"), "parseM3UGroups");
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

// ─── /play redirect ───

describe("/play redirect", () => {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const xt = enc({ t: "xtream", s: "http://example.com:8080", u: "user", p: "pass" });

  test("redirects a valid live stream to the provider", async () => {
    const res = await request(app).get(`/play/${xt}/live/123/ts/Delta%20Sport`);
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

// ─── Ko-fi link clicks ───

describe("Ko-fi link clicks", () => {
  const stats = async () => (await request(app).get("/stats")).body;
  const today = (s) => s.history.find(r => r.date === new Date().toISOString().slice(0, 10)) || {};

  test("every click counts (all time + per day, by where), then the browser goes to Ko-fi", async () => {
    const before = await stats();
    for (const from of ["dialog", "dialog", "footer", "somewhere"]) {
      const res = await request(app).get(`/go/kofi?from=${from}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("https://ko-fi.com/streamvaultaddon");
    }
    await request(app).head("/go/kofi?from=dialog"); // link preview: not a click
    const after = await stats();
    expect(after.kofiClicksTotal).toEqual({
      dialog: before.kofiClicksTotal.dialog + 2,
      footer: before.kofiClicksTotal.footer + 1,
      other: before.kofiClicksTotal.other + 1,
    });
    const day = (key) => (today(after)[key] || 0) - (today(before)[key] || 0);
    expect([day("kofiClicksDialog"), day("kofiClicksFooter"), day("kofiClicksOther")]).toEqual([2, 1, 1]);
  });

  test("the configure page's Ko-fi links go through the counter", async () => {
    const html = (await request(app).get("/configure")).text;
    expect(html).toContain('href="/go/kofi?from=dialog"');
    expect(html).toContain('href="/go/kofi?from=footer"');
  });
});
