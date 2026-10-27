// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app, decryptConfig, formatAccountInfo } = require("../src/addon");

// ─── Configure page: one-step check + edit installed setup ───

describe("configure page API", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
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

  test("a 404 Test Connection says the login / link isn't recognised", async () => {
    jest.spyOn(m3u, "parseM3UGroups").mockRejectedValue(new Error("Request failed with status code 404"));
    const res = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: "http://example.com/hint-404.m3u" });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/doesn't recognise this login or link \(404\)/);
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
    const xtream = require("../src/xtream");
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

  test("a broken install link in an app is answered like an install without settings (setup tile)", async () => {
    const config = { t: "xtream", s: "", u: "", p: "", c: "" };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const bad = `/${encoded}`;

    const man = await request(app).get(`${bad}/manifest.json`);
    expect(man.status).toBe(200);
    expect(man.body.behaviorHints.configurationRequired).toBe(true); // the bare "Not connected yet" manifest
    const cat = await request(app).get(`${bad}/catalog/tv/iptv_live.json`);
    expect(cat.body.metas).toEqual([expect.objectContaining({ id: "iptv_notice_setup" })]);
    expect((await request(app).get(`${bad}/catalog/tv/iptv_live/skip=100.json`)).body.metas).toEqual([]);
    expect((await request(app).get(`${bad}/meta/tv/iptv_notice_setup.json`)).body.meta.id).toBe("iptv_notice_setup");
    expect((await request(app).get(`${bad}/meta/movie/tt0111161.json`)).body.meta.name).toBe("Unknown"); // not ours
    const play = (await request(app).get(`${bad}/stream/tv/iptv_notice_setup.json`)).body.streams;
    expect(play[0].externalUrl).toMatch(/\/setup\?via=play$/);
    expect((await request(app).get(`${bad}/stream/tv/iptv_tv_1.json`)).body.streams).toEqual([]);

    // the configure page and /play still get errors; the bad link is still listed in /stats
    expect((await request(app).get(`/api/config${bad}`)).status).toBe(400);
    expect((await request(app).get(`/play${bad}/live/1/ts/x`)).status).toBe(400);
    const recent = (await request(app).get("/stats")).body.recentBadLinks;
    expect(recent[0]).toMatchObject({ reason: "install link has no Xtream server/login" });
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
    expect(decrypted.m).toHaveLength(2048);
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

// ─── Failed Test Connection: address shape ───

describe("failed tests record the address shape (private parts hidden)", () => {
  const m3u = require("../src/m3u");
  const xtream = require("../src/xtream");
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
