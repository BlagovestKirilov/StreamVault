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
