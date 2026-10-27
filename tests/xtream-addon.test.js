// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app, epgTimeRange } = require("../src/addon");

// ─── Xtream account validation + subscription expiry ───

describe("Xtream account checks", () => {
  const xtream = require("../src/xtream");
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
    ["a web page instead of Xtream data", { auth: 1, status: "Active" }, "<html>Welcome</html>", "doesn't answer like an Xtream server"],
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
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 5, name: "Delta" }]);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue({ auth: 1, status: "Active", exp_date: "1796083200" });
    const cfg = enc({ t: "xtream", s: "http://example.com", u: "expiry-user", p: "p" });
    const res = await request(app).get(`/${cfg}/meta/tv/iptv_tv_5.json`);
    expect(res.body.meta.description).toContain("🗓 Subscription expires 2026-12-01");
  });

  test("channel page warns when the subscription has expired", async () => {
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 5, name: "Delta" }]);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue({ auth: 1, status: "Active", exp_date: String(past) });
    const cfg = enc({ t: "xtream", s: "http://example.com", u: "expired-user", p: "p" });
    const res = await request(app).get(`/${cfg}/meta/tv/iptv_tv_5.json`);
    expect(res.body.meta.description).toMatch(/⚠️ Subscription expired on \d{4}-\d{2}-\d{2}/);
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

// ─── Stream formats the account allows (allowed_output_formats) ───

describe("stream formats the account allows", () => {
  const xtream = require("../src/xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  let users = 0;
  // Stream buttons for channel 7 (account cache is per login: a new user each time)
  const formatsFor = async (account) => {
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([{ stream_id: 7, name: "North" }]);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    if (account instanceof Error) jest.spyOn(xtream, "getAccountInfo").mockRejectedValue(account);
    else jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(account);
    const cfg = enc({ t: "xtream", s: "http://example.com", u: `formats-${users++}`, p: "p" });
    const { streams } = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_7.json`)).body;
    return streams.map(s => s.name.split("\n")[1]);
  };
  const allowing = (formats) => ({ auth: 1, status: "Active", allowed_output_formats: formats });
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ["both allowed", allowing(["m3u8", "ts"]), ["TS", "HLS"]],
    ["only TS", allowing(["ts"]), ["TS"]],
    ["only HLS, in upper case", allowing(["M3U8"]), ["HLS"]],
    ["mixed case with spaces", allowing([" Ts "]), ["TS"]],
    ["the names HLS / MPEGTS", allowing(["Hls"]), ["HLS"]],
    ["a comma-separated string", allowing("TS, m3u8"), ["TS", "HLS"]],
    ["only a format we don't offer (rtmp): both", allowing(["rtmp"]), ["TS", "HLS"]],
    ["an empty list: both", allowing([]), ["TS", "HLS"]],
    ["not reported: both", { auth: 1, status: "Active" }, ["TS", "HLS"]],
    ["no account info: both", null, ["TS", "HLS"]],
    ["account lookup failed: both", new Error("timeout of 15000ms exceeded"), ["TS", "HLS"]],
  ])("%s", async (_, account, expected) => {
    expect(await formatsFor(account)).toEqual(expected);
  });
});

// ─── Catch-up (TV archive) ───

describe("Xtream catch-up", () => {
  const xtream = require("../src/xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64 = (s) => Buffer.from(s).toString("base64");
  const now = Math.floor(Date.now() / 1000);
  // provider's local time string for a unix time (tests: provider runs on UTC)
  const local = (sec) => new Date(sec * 1000).toISOString().slice(0, 19).replace("T", " ");
  const slot = (start, mins, title, archive = 1) => ({
    start: local(start), start_timestamp: String(start), stop_timestamp: String(start + mins * 60),
    title: b64(title), has_archive: archive,
  });
  afterEach(() => jest.restoreAllMocks());

  const setup = (user, streams, table) => {
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue(streams);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue({ auth: 1, status: "Active" });
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    const table_ = jest.spyOn(xtream, "getEpgTable").mockResolvedValue(table);
    return { cfg: enc({ t: "xtream", s: "http://example.com", u: user, p: "p", z: "UTC" }), table_ };
  };

  test("archived channels offer the running programme from the start, then past ones, newest first", async () => {
    const { cfg } = setup("cu-1", [{ stream_id: 9, name: "Delta News", tv_archive: 1, tv_archive_duration: "3" }], [
      slot(now - 3 * 3600, 60, "Old Show"),
      slot(now - 1800, 60, "Running Show"),
      slot(now - 2 * 3600, 60, "Not Recorded", 0),
      slot(now - 10 * 86400, 60, "Too Old"),
      slot(now + 3600, 60, "Future Show"),
    ]);
    const streams = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_9.json`)).body.streams;
    expect(streams.slice(0, 2).map(s => s.name)).toEqual(["StreamVault\nTS", "StreamVault\nHLS"]);
    const catchup = streams.slice(2);
    expect(catchup).toHaveLength(2);
    expect(catchup[0].name).toBe("StreamVault\n▶ From start");
    expect(catchup[0].title).toMatch(/^From the start \d\d:\d\d - \d\d:\d\d Running Show\nDelta News$/);
    expect(catchup[1].name).toBe("StreamVault\n⏪ Catch-up");
    expect(catchup[1].title).toMatch(/Old Show\nDelta News$/);
    const start = local(now - 3 * 3600).replace(" ", ":").slice(0, 16).replace(/:(\d\d):(\d\d)$/, ":$1-$2");
    expect(catchup[1].url).toContain(`/play/${cfg}/timeshift/9/${start}/60/ts/`);
  });

  test("channels without an archive don't ask the provider for the guide table", async () => {
    const { cfg, table_ } = setup("cu-2", [{ stream_id: 4, name: "Echo", tv_archive: 0 }], []);
    const streams = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_4.json`)).body.streams;
    expect(streams).toHaveLength(2);
    expect(table_).not.toHaveBeenCalled();
  });

  test("the channel page says how many days can be watched again", async () => {
    const { cfg } = setup("cu-3", [{ stream_id: 7, name: "Foxtrot", tv_archive: "1", tv_archive_duration: "7" }], []);
    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_tv_7.json`)).body.meta;
    expect(meta.description).toContain("⏪ Catch-up: past 7 days");
  });

  test("/play/…/timeshift redirects to the provider's timeshift link; bad values are refused", async () => {
    const cfg = enc({ t: "xtream", s: "http://example.com:8080", u: "u1", p: "p1" });
    const ok = await request(app).get(`/play/${cfg}/timeshift/12/2026-10-27:20-00/60/ts/Delta`);
    expect(ok.status).toBe(302);
    expect(ok.headers.location).toBe("http://example.com:8080/timeshift/u1/p1/60/2026-10-27:20-00/12.ts");
    for (const bad of ["12/2026-10-27 20:00/60/ts", "12/2026-10-27:20-00/0/ts", "12/2026-10-27:20-00/2000/ts", "a.b/2026-10-27:20-00/60/ts", "12/2026-10-27:20-00/60/mp4"]) {
      expect((await request(app).get(`/play/${cfg}/timeshift/${bad}/x`)).status).toBe(400);
    }
  });
});

describe("Xtream catch-up without a guide on the server", () => {
  const xtream = require("../src/xtream");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  afterEach(() => jest.restoreAllMocks());

  const setup = (user, account) => {
    jest.spyOn(xtream, "getLiveStreams").mockResolvedValue([
      { stream_id: 31, name: "Kilo UHD" },
      { stream_id: 30, name: "Kilo", tv_archive: 1, tv_archive_duration: "2" },
    ]);
    jest.spyOn(xtream, "getLiveCategories").mockResolvedValue([]);
    jest.spyOn(xtream, "getAccountInfo").mockResolvedValue(account);
    jest.spyOn(xtream, "getShortEPG").mockResolvedValue([]);
    jest.spyOn(xtream, "getEpgTable").mockResolvedValue([]); // recorded channel, no guide
    return enc({ t: "xtream", s: "http://example.com", u: user, p: "p", z: "UTC" });
  };

  test("the provider's UTC offset comes from server_info", () => {
    expect(xtream.serverUtcOffsetMin({ time_now: "2026-10-27 22:07:00", timestamp_now: Date.parse("2026-10-27T20:07:00Z") / 1000 })).toBe(120);
    expect(xtream.serverUtcOffsetMin({ time_now: "2026-10-27 15:37:30", timestamp_now: Date.parse("2026-10-27T20:07:30Z") / 1000 })).toBe(-270);
    expect(xtream.serverUtcOffsetMin({})).toBeNull();
    expect(xtream.serverUtcOffsetMin(undefined)).toBeNull();
    expect(xtream.serverUtcOffsetMin({ time_now: "garbage", timestamp_now: 1 })).toBeNull();
  });

  test("offers the last full hours on the provider's clock, newest first", async () => {
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-27T20:07:00Z"));
    const cfg = setup("slots-1", { auth: 1, status: "Active", serverUtcOffsetMin: 120 });
    const streams = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_30.json`)).body.streams;
    const catchup = streams.filter(s => s.name === "StreamVault\n⏪ Catch-up");
    // 2-day archive: the last 24 hours one by one, then the day before in 3-hour blocks
    expect(catchup).toHaveLength(24 + 7);
    // provider 22:07 → last full hour 21:00–22:00 its time = 19:00–20:00 UTC
    expect(catchup[0].title).toBe("Today 19:00 - 20:00\nKilo");
    expect(catchup[0].url).toContain("/timeshift/30/2026-10-27:21-00/60/ts/");
    expect(catchup[23].url).toContain("/timeshift/30/2026-10-26:22-00/60/ts/");
    expect(catchup[24].title).toBe("Yesterday 17:00 - 20:00\nKilo");
    expect(catchup[24].url).toContain("/timeshift/30/2026-10-26:19-00/180/ts/");
    // the oldest block still starts inside the archive (2026-10-25 22:07 provider time)
    expect(catchup.at(-1).url).toContain("/timeshift/30/2026-10-26:01-00/180/ts/");
  });

  test("no provider clock offset: no guessed catch-up times", async () => {
    const cfg = setup("slots-2", { auth: 1, status: "Active" });
    const streams = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_30.json`)).body.streams;
    expect(streams.some(s => s.name.includes("Catch-up"))).toBe(false);
  });

  test("a tile whose main version isn't recorded still gets catch-up from the one that is", async () => {
    const cfg = setup("slots-3", { auth: 1, status: "Active", serverUtcOffsetMin: 0 });
    const meta = (await request(app).get(`/${cfg}/meta/tv/iptv_tv_31.json`)).body.meta;
    expect(meta.description).toContain("⏪ Catch-up: past 2 days");
    const streams = (await request(app).get(`/${cfg}/stream/tv/iptv_tv_31.json`)).body.streams;
    expect(streams.filter(s => s.name.includes("Catch-up")).every(s => s.url.includes("/timeshift/30/"))).toBe(true);
  });
});
