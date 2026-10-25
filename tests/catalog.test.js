// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app, makePosterUrl } = require("../src/addon");

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

// ─── Channel order: categories A–Z, channels A–Z inside ───

describe("channel order", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test("M3U: groups A–Z, channels A–Z inside (any script, numbers as numbers), no group last", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 group-title="Спорт",Река
http://example.com/1.m3u8
#EXTINF:-1,Loose Channel
http://example.com/2.m3u8
#EXTINF:-1 group-title="sports",Sport 10
http://example.com/3.m3u8
#EXTINF:-1 group-title="Sports",Sport 2
http://example.com/4.m3u8
#EXTINF:-1 group-title="News",cosmo
http://example.com/5.m3u8
#EXTINF:-1 group-title="News",Beacon News
http://example.com/6.m3u8
#EXTINF:-1 group-title="Спорт",Делта Спорт
http://example.com/7.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://order.example.com/list.m3u" });
    const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;
    expect(metas.map(m => m.name)).toEqual([
      "Beacon News", "cosmo",   // News
      "Sport 2", "Sport 10",   // Sports / sports (case ignored), 2 before 10
      "Делта Спорт", "Река",   // Спорт (Cyrillic after Latin)
      "Loose Channel",         // no group
    ]);
  });

  test("Xtream: picked categories in pick order, channels A–Z inside", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([
      { category_id: "1", category_name: "UK Sports" },
      { category_id: "2", category_name: "UK News" },
    ]);
    jest.spyOn(xtream, "getLiveStreams").mockImplementation(async (_c, catId) => (catId === "1"
      ? [{ stream_id: 1, name: "Summit Sports 1", category_id: "1" }, { stream_id: 2, name: "Arc Sport", category_id: "1" }]
      : [{ stream_id: 3, name: "Summit News", category_id: "2" }, { stream_id: 4, name: "Beacon News", category_id: "2" }]));
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const names = async (c) => {
      const cfg = enc({ t: "xtream", s: "http://order-xt.example.com", u: "u", p: "p", c });
      return (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);
    };
    expect(await names("1,2")).toEqual(["Arc Sport", "Summit Sports 1", "Beacon News", "Summit News"]);
    expect(await names("2,1")).toEqual(["Beacon News", "Summit News", "Arc Sport", "Summit Sports 1"]);
    const cfg = enc({ t: "xtream", s: "http://order-xt.example.com", u: "u", p: "p", c: "2,1" });
    const genre = (await request(app).get(`/${cfg}/manifest.json`)).body.catalogs[0].extra.find(e => e.name === "genre");
    expect(genre.options).toEqual(["UK News", "UK Sports"]);
  });
});

// ─── Channel posters ───

describe("channel posters", () => {
  const m3u = require("../src/m3u");
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
    expect(metas.map(m => m.name)).toEqual(["No Logo", "With Logo"]); // A–Z

    const poster = new URL(metas[1].poster);
    expect(poster.origin).toBe("https://wsrv.nl");
    expect(poster.searchParams.get("url")).toBe("http://cdn.example.com/logos/a wide.png");
    expect(poster.searchParams.get("fit")).toBe("contain");
    expect(poster.searchParams.get("w")).toBe("256");
    expect(poster.searchParams.get("h")).toBe("256");
    // dead logo link → the generated name tile instead of a broken image
    expect(poster.searchParams.get("default")).toMatch(/^https:\/\/ui-avatars\.com\/api\/\?name=With%20Logo/);

    expect(metas[0].poster).toMatch(/^https:\/\/ui-avatars\.com\//);

    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_tv_a.json`)).body.meta;
    expect(meta.poster).toBe(metas[1].poster);
  });

  test("Xtream: same posters for Stremio, raw logo only kept internally", async () => {
    const xtream = require("../src/xtream");
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([{ category_id: 1, category_name: "Sport" }]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([
      { stream_id: 7, name: "Delta Sport", stream_icon: "http://cdn.example.com/delta.png", category_id: 1 },
      { stream_id: 8, name: "No Icon", category_id: 1 },
    ]);
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    const cfg = enc({ t: "xtream", s: "http://example.com", u: "poster-user", p: "p" });

    const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;
    expect(metas[0]).toEqual({
      id: "iptv_tv_7", type: "tv", name: "Delta Sport", genres: ["Sport"], posterShape: "square",
      poster: expect.stringMatching(/^https:\/\/wsrv\.nl\/\?url=http%3A%2F%2Fcdn\.example\.com%2Fdelta\.png&/),
    });
    expect(metas[0]).not.toHaveProperty("logo");
    expect(metas[1].poster).toMatch(/^https:\/\/ui-avatars\.com\//);

    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_tv_7.json`)).body.meta;
    expect(meta.poster).toBe(metas[0].poster);
    expect(meta).not.toHaveProperty("logo");
  });
});

test("quality versions of a channel are one tile; trailing TV doesn't move a channel", async () => {
  const m3u = require("../src/m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const names = ["[BG] ALPINE 24", "[BG] ALPHA ACTION", "[BG] ALPHA UHD", "[BG] ALPHA", "[BG] ALPHA (FHD)", "[BG] ALPHA HD",
    "[BG] NORTH SPORT UHD", "[BG] NORTH TV UHD", "[BG] NORTH", "[BG] NORTH SPORT"];
  jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent("#EXTM3U\n"
    + names.map((n, i) => `#EXTINF:-1 group-title="[BU] NORTHLAND",${n}\nhttp://example.com/${i}.m3u8`).join("\n")));
  const cfg = enc({ t: "m3u", m: "http://quality-order.example.com/list.m3u" });
  const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;
  expect(metas.map(m => m.name)).toEqual([
    "ALPHA",                                        // ALPHA + HD + (FHD) + UHD
    "ALPHA ACTION", "ALPINE 24",
    "NORTH",                                       // NORTH + NORTH TV UHD (a trailing "TV" doesn't count)
    "NORTH SPORT",                                 // NORTH SPORT + UHD
  ]);
  expect(metas[0].id).toBe("iptv_tv_m3u_bg_alpha_uhd_2"); // the best version's id
  jest.restoreAllMocks();
});

describe("home rows, merged versions, clean names", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const CATEGORIES = [
    { category_id: "1", category_name: "[BU] NORTHLAND" },
    { category_id: "2", category_name: "UK| NEWS" },
    { category_id: "3", category_name: "KIDS" },
  ];
  const STREAMS = {
    1: [{ stream_id: 11, name: "[BG] ALPHA", category_id: "1" }, { stream_id: 12, name: "[BG] ALPHA UHD", category_id: "1" },
      { stream_id: 13, name: "[BG] ALPHA HD", category_id: "1" }, { stream_id: 14, name: "[BG] NORTH", category_id: "1" }],
    2: [{ stream_id: 21, name: "UK: Beacon News", category_id: "2" }],
    3: [{ stream_id: 31, name: "Kiddo Jr", category_id: "3" }],
  };
  let setups = 0; // own provider address per setup: no cached account/list shared between tests
  const xtreamSetup = (c, n = "") => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue(CATEGORIES);
    jest.spyOn(xtream, "getLiveStreams").mockImplementation(async (_cfg, catId) => (catId ? STREAMS[catId] : Object.values(STREAMS).flat()));
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(null);
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    return enc({ t: "xtream", s: `http://rows-${++setups}.example.com`, u: "u", p: "p", c, n });
  };
  const names = async (path) => (await request(app).get(path)).body.metas.map(m => m.name);
  afterEach(() => jest.restoreAllMocks());

  test("one home row per picked category, in pick order, after the main row", async () => {
    const cfg = xtreamSetup("2,1");
    const { catalogs, version } = (await request(app).get(`/${cfg}/manifest.json`)).body;
    expect(version).toBe("1.2.0");
    expect(catalogs.map(c => c.name)).toEqual(["StreamVault Live", "NEWS", "NORTHLAND"]); // tags hidden
    expect(catalogs[1].id).toMatch(/^iptv_cat_[0-9a-f]{12}$/);
    expect(catalogs[1].extra).toEqual([{ name: "skip" }]);
    expect(await names(`/${cfg}/catalog/tv/${catalogs[1].id}.json`)).toEqual(["Beacon News"]);
    expect(await names(`/${cfg}/catalog/tv/${catalogs[2].id}.json`)).toEqual(["ALPHA", "NORTH"]);
    expect(await names(`/${cfg}/catalog/tv/iptv_cat_000000000000.json`)).toEqual(["⚠️ No channels in this category"]); // old row
  });

  test("a category the app still lists from an older setup explains itself instead of an empty screen", async () => {
    const cfg = xtreamSetup("2,1"); // KIDS isn't picked any more
    const path = `/${cfg}/catalog/tv/iptv_live/genre=KIDS.json`;
    const metas = (await request(app).get(path)).body.metas;
    expect(metas).toEqual([expect.objectContaining({ id: "iptv_notice_category_gone", name: "⚠️ No channels in this category" })]);
    expect((await request(app).get(`/${cfg}/catalog/tv/iptv_live/genre=KIDS&skip=100.json`)).body.metas).toEqual([]);
    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_notice_category_gone.json`)).body.meta;
    expect(meta.description).toMatch(/Close and reopen the app to refresh the list, or check your categories in Configure/);
    expect(await names(`/${cfg}/catalog/tv/iptv_live/genre=${encodeURIComponent("UK| NEWS")}.json`)).toEqual(["Beacon News"]); // real one still works
  });

  test("each Save changes gives the manifest a newer version, so apps replace their stored copy", async () => {
    xtreamSetup("1"); // mocks
    const settings = { t: "xtream", s: "http://version-bump.example.com", u: "u", p: "p", c: "1" };
    const link = (await request(app).post("/api/link").send(settings)).body.config;
    const version = async () => (await request(app).get(`/${link}/manifest.json`)).body.version;
    expect(await version()).toBe("1.2.1");
    await request(app).post("/api/link").send({ ...settings, c: "1,2", editing: link });
    expect(await version()).toBe("1.2.2");
    await request(app).post("/api/link").send({ ...settings, c: "1", editing: link });
    expect(await version()).toBe("1.2.3");
    // a link that was never saved keeps the base version
    expect((await request(app).get(`/${enc(settings)}/manifest.json`)).body.version).toBe("1.2.0");
  });

  test("channel list not ready: the manifest still lists the picked categories (Xtream and M3U)", async () => {
    const cfg = xtreamSetup("2,1");
    xtream.getLiveStreams.mockRejectedValue(new Error("timeout of 15000ms exceeded")); // list not available
    const { catalogs } = (await request(app).get(`/${cfg}/manifest.json`)).body;
    expect(catalogs[0].extra.find(e => e.name === "genre").options).toEqual(["UK| NEWS", "[BU] NORTHLAND"]);
    expect(catalogs.map(c => c.name)).toEqual(["StreamVault Live", "NEWS", "NORTHLAND"]);

    jest.spyOn(m3u, "parseM3U").mockRejectedValue(new Error("timeout of 30000ms exceeded"));
    const m3uCfg = enc({ t: "m3u", m: "http://not-ready.example.com/list.m3u", g: JSON.stringify(["Sport", "News"]) });
    const m3uMan = (await request(app).get(`/${m3uCfg}/manifest.json`)).body;
    expect(m3uMan.catalogs[0].extra.find(e => e.name === "genre").options).toEqual(["Sport", "News"]);
    expect(m3uMan.catalogs.map(c => c.name)).toEqual(["StreamVault Live", "Sport", "News"]);
  });

  test("no extra rows with one or no picked categories", async () => {
    for (const c of ["", "1"]) {
      const cfg = xtreamSetup(c);
      const { catalogs } = (await request(app).get(`/${cfg}/manifest.json`)).body;
      expect(catalogs.map(x => x.id)).toEqual(["iptv_live"]);
      jest.restoreAllMocks();
    }
  });

  test("the expiry tile stays in the main row only", async () => {
    const cfg = xtreamSetup("2,1");
    xtream.getAccountInfo.mockResolvedValue({ auth: 1, status: "Active", exp_date: String(Math.floor(Date.now() / 1000) + 2 * 86400) });
    const { catalogs } = (await request(app).get(`/${cfg}/manifest.json`)).body;
    expect((await names(`/${cfg}/catalog/tv/iptv_live.json`))[0]).toMatch(/^⚠️ Subscription ends/);
    expect(await names(`/${cfg}/catalog/tv/${catalogs[1].id}.json`)).toEqual(["Beacon News"]);
  });

  test("a merged tile plays every version, best first — also from an old saved id of a lower version", async () => {
    const cfg = xtreamSetup("1");
    expect(await names(`/${cfg}/catalog/tv/iptv_live.json`)).toEqual(["ALPHA", "NORTH"]);
    const titles = async (id) => (await request(app).get(`/${cfg}/stream/tv/${id}.json`)).body.streams
      .map(st => `${st.name.split("\n")[1]} ${st.title.split("\n")[0]}`);
    expect(await titles("iptv_tv_12")).toEqual([
      "TS ALPHA UHD", "HLS ALPHA UHD", "TS ALPHA HD", "HLS ALPHA HD", "TS ALPHA", "HLS ALPHA",
    ]);
    expect(await titles("iptv_tv_11")).toEqual(await titles("iptv_tv_12")); // plain ALPHA's old id: same list, UHD first
    expect(await titles("iptv_tv_14")).toEqual(["TS NORTH", "HLS NORTH"]); // single version unchanged
    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_tv_12.json`)).body.meta;
    expect(meta.name).toBe("ALPHA");
  });

  test("a trailing TV doesn't split a channel: BRIX TV + BRIX UHD, BAY MUSIC + … TV UHD", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 group-title="G",[BG] BRIX TV
http://example.com/box.m3u8
#EXTINF:-1 group-title="G",[BG] BRIX UHD
http://example.com/box-uhd.m3u8
#EXTINF:-1 group-title="G",[BG] BAY MUSIC
http://example.com/bm.m3u8
#EXTINF:-1 group-title="G",[BG] BAY MUSIC TV UHD
http://example.com/bm-uhd.m3u8
#EXTINF:-1 group-title="G",[BG] TV 9000
http://example.com/tv1000.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://trailing-tv.example.com/list.m3u" });
    const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;
    expect(metas.map(m => m.name)).toEqual(["BAY MUSIC", "BRIX TV", "TV 9000"]); // plain version's name
    const box = metas.find(m => m.name === "BRIX TV");
    const { streams } = (await request(app).get(`/${cfg}/stream/tv/${box.id}.json`)).body;
    expect(streams.map(st => st.url)).toEqual(["http://example.com/box-uhd.m3u8", "http://example.com/box.m3u8"]);
    expect((await request(app).get(`/${cfg}/meta/tv/${box.id}.json`)).body.meta.name).toBe("BRIX TV");
  });

  test("names made only of symbols are never merged with each other", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 group-title="G",📺
http://example.com/a.m3u8
#EXTINF:-1 group-title="G",⚽
http://example.com/b.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://symbol-names.example.com/list.m3u" });
    const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;
    expect(metas.map(m => m.name).sort()).toEqual(["⚽", "📺"].sort());
  });

  test("streams say what they are (MPEG-TS / HLS), no hints", async () => {
    const cfg = xtreamSetup("1");
    const { streams } = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_14.json`)).body;
    expect(streams.map(st => st.title)).toEqual(["NORTH\nMPEG-TS", "NORTH\nHLS / m3u8"]);
    expect(streams.map(st => st.name)).toEqual(["StreamVault\nTS", "StreamVault\nHLS"]);
  });

  test("M3U: a merged tile offers each version's stream", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 group-title="G",Kino
http://example.com/sd.m3u8
#EXTINF:-1 group-title="G",Kino FHD
http://example.com/fhd.m3u8`));
    const cfg = enc({ t: "m3u", m: "http://merge-m3u.example.com/list.m3u" });
    const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;
    expect(metas.map(m => m.name)).toEqual(["Kino"]);
    const { streams } = (await request(app).get(`/${cfg}/stream/tv/${metas[0].id}.json`)).body;
    expect(streams.map(st => st.url)).toEqual(["http://example.com/fhd.m3u8", "http://example.com/sd.m3u8"]);
  });

  test("provider tags are hidden in tiles, rows, channel pages and streams", async () => {
    const cfg = xtreamSetup("2,1");
    const { catalogs } = (await request(app).get(`/${cfg}/manifest.json`)).body;
    expect(catalogs.map(c => c.name)).toEqual(["StreamVault Live", "NEWS", "NORTHLAND"]);
    expect(await names(`/${cfg}/catalog/tv/iptv_live.json`)).toEqual(["Beacon News", "ALPHA", "NORTH"]);
    expect((await request(app).get(`/${cfg}/meta/tv/iptv_tv_12.json`)).body.meta.name).toBe("ALPHA");
    const { streams } = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_21.json`)).body;
    expect(streams[0].title.split("\n")[0]).toBe("Beacon News");
    expect(streams[0].url).toMatch(/\/Beacon%20News$/);
    // the genre dropdown keeps the real names (it filters by them)
    expect(catalogs[0].extra.find(e => e.name === "genre").options).toEqual(["UK| NEWS", "[BU] NORTHLAND"]);
  });
});
