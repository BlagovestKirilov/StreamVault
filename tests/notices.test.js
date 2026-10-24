// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app } = require("../src/addon");

// ─── Error tiles instead of an empty catalog ───

describe("catalog error tiles", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ["Request failed with status code 503", "iptv_notice_provider_down", "Provider not responding"],
    ["Request failed with status code 512", "iptv_notice_provider_down", "Provider not responding"],
    ["Request failed with status code 403", "iptv_notice_provider_refused", "Provider refused access"],
    ["Request failed with status code 451", "iptv_notice_provider_refused", "Provider refused access"],
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

test("hidden characters and Cyrillic look-alikes in names don't move a channel", async () => {
  const m3u = require("../src/m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // leading spaces, a non-breaking space, Cyrillic А/Т typed in a Latin name, lower-case tag
  const names = ["  [BG] TVN", "[BG] BTV ACTION", "[BG]\u00a0BOX TV", "[BG] \u0422V1", "[BG] btv uhd", "[BG] \u0410CTION"];
  jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent("#EXTM3U\n"
    + names.map((n, i) => `#EXTINF:-1 group-title="G",${n}\nhttp://example.com/${i}.m3u8`).join("\n")));
  const cfg = enc({ t: "m3u", m: "http://hidden-chars.example.com/list.m3u" });
  const { metas } = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body;
  expect(metas.map(m => m.name.trim())).toEqual([
    "\u0410CTION", "BOX TV", "btv uhd", "BTV ACTION", "\u0422V1", "TVN", // "[BG]" hidden
  ]);
  jest.restoreAllMocks();
});

test("M3U: picked groups in pick order, channels A–Z inside", async () => {
  const m3u = require("../src/m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  jest.spyOn(m3u, "parseM3U").mockImplementation(async (_url, groups) => m3u.parseM3UContent(`#EXTM3U
#EXTINF:-1 group-title="Bulgaria",Nova
http://example.com/1.m3u8
#EXTINF:-1 group-title="Serbia",RTS 1
http://example.com/2.m3u8
#EXTINF:-1 group-title="Bulgaria",bTV
http://example.com/3.m3u8
#EXTINF:-1 group-title="Serbia",Pink
http://example.com/4.m3u8`, groups));
  const names = async (g) => {
    const cfg = enc({ t: "m3u", m: "http://pick-order.example.com/list.m3u", g: JSON.stringify(g) });
    return (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);
  };
  expect(await names(["Serbia", "Bulgaria"])).toEqual(["Pink", "RTS 1", "bTV", "Nova"]);
  expect(await names(["Bulgaria", "Serbia"])).toEqual(["bTV", "Nova", "Pink", "RTS 1"]);
  jest.restoreAllMocks();
});

// ─── Subscription expiry notice ───

describe("expiry notice", () => {
  const xtream = require("../src/xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const DAY = 24 * 60 * 60;
  const inDays = (d) => String(Math.floor(Date.now() / 1000 + d * DAY));
  let n = 0;
  const setup = (account) => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 1, name: "One" }]);
    const info = jest.spyOn(xtream, "getAccountInfo").mockImplementation(account);
    return { info, cfg: enc({ t: "xtream", s: "http://expiry.example.com", u: `user${++n}`, p: "p" }) };
  };
  afterEach(() => jest.restoreAllMocks());

  test("within 7 days: first tile on the first page only, not in search", async () => {
    const { cfg } = setup(async () => ({ auth: 1, status: "Active", exp_date: inDays(2.5) }));
    const first = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas;
    expect(first.map(m => m.name)).toEqual(["⚠️ Subscription ends in 3 days", "One"]);
    expect(first[0].id).toBe("iptv_notice_expiring");
    expect((await request(app).get(`/${cfg}/catalog/tv/iptv_live/skip=100.json`)).body.metas).toEqual([]);
    expect((await request(app).get(`/${cfg}/catalog/tv/iptv_live/search=one.json`)).body.metas.map(m => m.name)).toEqual(["One"]);

    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_notice_expiring.json`)).body.meta;
    expect(meta.description).toMatch(/^Your IPTV subscription ends on \d{4}-\d{2}-\d{2} \(UTC\)\. Renew/);
    expect((await request(app).get(`/${cfg}/stream/tv/iptv_notice_expiring.json`)).body.streams).toEqual([]);
  });

  test("the extra tile never hides a channel on the next page", async () => {
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue(
      Array.from({ length: 150 }, (_, i) => ({ stream_id: i + 1, name: `Ch ${String(i + 1).padStart(3, "0")}` })));
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue({ auth: 1, status: "Active", exp_date: inDays(2) });
    const cfg = enc({ t: "xtream", s: "http://expiry.example.com", u: `paging${++n}`, p: "p" });
    const page = async (skip) => (await request(app).get(`/${cfg}/catalog/tv/iptv_live${skip ? `/skip=${skip}` : ""}.json`)).body.metas;
    const first = await page(0);
    expect(first).toHaveLength(101);
    expect(first.at(-1).name).toBe("Ch 100");
    // "items so far" (101) and "fixed 100" both continue at Ch 101
    expect((await page(101))[0].name).toBe("Ch 101");
    expect((await page(100))[0].name).toBe("Ch 101");
  });

  test("less than a day left", async () => {
    const { cfg } = setup(async () => ({ auth: 1, status: "Active", exp_date: inDays(0.2) }));
    const first = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas;
    expect(first[0].name).toBe("⚠️ Subscription ends in less than a day");
  });

  test("no tile with more than 7 days left, no expiry date, or no account info", async () => {
    for (const account of [
      { auth: 1, status: "Active", exp_date: inDays(8) },
      { auth: 1, status: "Active", exp_date: null },
      null,
    ]) {
      const { cfg } = setup(async () => account);
      const names = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);
      expect(names).toEqual(["One"]);
      jest.restoreAllMocks();
    }
  });

  test("expired but the panel still lists channels: account tile first", async () => {
    const { cfg } = setup(async () => ({ auth: 1, status: "Active", exp_date: inDays(-1) }));
    const first = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas;
    expect(first[0]).toMatchObject({ id: "iptv_notice_account" });
    expect(first[0].name).toMatch(/^⚠️ Your account expired on /);
    expect(first[1].name).toBe("One");
  });

  test("a slow account lookup never holds the catalog back", async () => {
    const { cfg } = setup(() => new Promise(() => {})); // never answers
    const started = Date.now();
    const names = (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);
    expect(names).toEqual(["One"]);
    expect(Date.now() - started).toBeLessThan(5000); // gives up after 3 s
  }, 10000);

  test("a renewal shows up after 30 minutes; a failed lookup is retried after 3", async () => {
    let account = { auth: 1, status: "Active", exp_date: inDays(2) };
    const { info, cfg } = setup(async () => account);
    const names = async () => (await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);
    const settle = () => new Promise(resolve => setImmediate(resolve)); // background refresh
    const realNow = Date.now;
    let offset = 0;
    jest.spyOn(Date, "now").mockImplementation(() => realNow() + offset);

    expect((await names())[0]).toMatch(/^⚠️ Subscription ends/);
    account = { auth: 1, status: "Active", exp_date: inDays(30) }; // renewed
    offset = 29 * 60 * 1000;
    expect((await names())[0]).toMatch(/^⚠️ Subscription ends/); // still cached
    offset = 31 * 60 * 1000;
    // Expired: answered at once from the old copy while it refreshes, then fresh
    expect((await names())[0]).toMatch(/^⚠️ Subscription ends/);
    await settle();
    expect(await names()).toEqual(["One"]);

    info.mockImplementation(async () => { throw new Error("down"); });
    offset = 62 * 60 * 1000;
    await names(); // refresh fails → cached as null
    await settle();
    const calls = info.mock.calls.length;
    account = { auth: 1, status: "Active", exp_date: inDays(1.5) };
    info.mockImplementation(async () => account);
    offset = 64 * 60 * 1000;
    await names();
    expect(info.mock.calls).toHaveLength(calls); // within 3 minutes: not asked again
    offset = 66 * 60 * 1000;
    await names(); // retried in the background
    await settle();
    expect((await names())[0]).toBe("⚠️ Subscription ends in 2 days");
  });
});
