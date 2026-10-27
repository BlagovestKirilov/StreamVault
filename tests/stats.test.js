// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app } = require("../src/addon");

// ─── Error codes per day ───

describe("per-day error codes", () => {
  const m3u = require("../src/m3u");
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
    await request(app).get("/api/config/garbage");                    // 400 invalid config
    await request(app).get("/api/nope");                              // 404
    const ip = "203.0.113.40";
    for (let i = 0; i < 11; i++) await request(app).post("/api/test").set("Fly-Client-IP", ip).send({ type: "m3u" }); // 10×400 + 429
    const after = await row();
    const diff = (where, code) => n(after.responseErrors, where, code) - n(before.responseErrors, where, code);
    expect(diff("GET /api/config/:config", "400")).toBe(1);
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
  const root = path.join(__dirname, "..", "src"); // child scripts require('./addon') from here
  // Runs a snippet in a fresh Node process whose stats live in a throwaway folder.
  // FORCE_COLOR=0: IDE test runners set FORCE_COLOR, and console.log(42) would
  // then print colour codes around the number.
  const run = (dir, code) => spawnSync(process.execPath, ["-e", code], {
    cwd: root, env: { ...process.env, STATS_DIR: dir, FORCE_COLOR: "0" }, encoding: "utf8", timeout: 15000,
  });
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-stats-"));

  test("all-time reconfigures / saves: seeded from the daily rows, then counted", () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "stats.json"), JSON.stringify({
      users: [], history: { "2026-10-20": { reconfigures: 14, reinstalls: 9 }, "2026-10-21": { reconfigures: 41, reinstalls: 23 } },
    }));
    const r = run(dir, `const r = require('supertest'); const { app } = require('./addon');
      const settings = { t: 'm3u', m: 'http://example.com/totals.m3u' };
      r(app).post('/api/link').send(settings)
        .then(x => r(app).get('/' + x.body.config + '/configure').set('Fly-Client-IP', '198.51.100.5')
          .then(() => r(app).post('/api/link').send({ ...settings, editing: x.body.config })))
        .then(() => r(app).get('/stats'))
        .then(x => { console.log(JSON.stringify({ rc: x.body.reconfiguresTotal, ri: x.body.reinstallsTotal })); process.exit(0); });`);
    expect(JSON.parse(r.stdout.trim().split("\n").pop())).toEqual({ rc: 14 + 41 + 1, ri: 9 + 23 + 1 });
  });

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

  test("viewers: unique users per day who got something to play, saved as one-way codes", () => {
    const dir = tmpDir();
    const today = new Date().toISOString().slice(0, 10);
    const cfg = Buffer.from(JSON.stringify({ t: "m3u", m: "http://example.com/v.m3u" })).toString("base64").replace(/=+$/, "");
    const r = run(dir, `
      const r = require('supertest'); const { app, buildMetricsText } = require('./addon');
      const m3u = require('./m3u');
      const list = '#EXTM3U\\n#EXTINF:-1 tvg-id="a",A\\nhttp://example.com/a.m3u8\\n#EXTINF:-1 tvg-id="b",B\\nhttp://example.com/b.m3u8';
      m3u.parseM3U = async () => m3u.parseM3UContent(list);
      const play = (id, ip) => r(app).get('/${cfg}/stream/tv/iptv_tv_' + id + '.json').set('Fly-Client-IP', ip);
      play('a', '203.0.113.1')
        .then(() => play('b', '203.0.113.1'))          // same person, second channel
        .then(() => play('a', '198.51.100.2'))         // another person
        .then(() => play('gone', '192.0.2.3'))         // nothing to play: not a viewer
        .then(() => r(app).get('/stats'))
        .then(x => {
          const metric = buildMetricsText().split('\\n').find(l => l.startsWith('streamvault_today{counter="viewers"}'));
          console.log(JSON.stringify({ stats: x.body, metric }));
          process.emit('SIGTERM');
        });
    `);
    const { stats, metric } = JSON.parse(r.stdout.trim().split("\n").pop());
    expect(stats.dailyViewers[today]).toBe(2);
    expect(stats.history.find(row => row.date === today).viewers).toBe(2);
    expect(metric).toBe('streamvault_today{counter="viewers"} 2');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "stats.json"), "utf8"));
    expect(saved.dailyViewers[today]).toHaveLength(2);
    saved.dailyViewers[today].forEach(u => expect(u).toMatch(/^[0-9a-f]{16}$/));
    expect(JSON.stringify(saved)).not.toMatch(/203\.0\.113|198\.51\.100/);
    expect(saved.history[today].viewers).toBe(2); // frozen into the row for after 30 days
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

// ─── Stats history + failure tracking ───

describe("stats history and failures", () => {
  const m3u = require("../src/m3u");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const today = () => new Date().toISOString().slice(0, 10);
  const todayRow = async () => (await request(app).get("/stats")).body.history.find(r => r.date === today());
  afterEach(() => jest.restoreAllMocks());

  test("counts today's launches, searches and streams (empty results only as emptyStreams)", async () => {
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
    expect(after.streams - before.streams).toBe(1);
    expect(after.emptyStreams - before.emptyStreams).toBe(1);
    expect(after.dau).toBeGreaterThanOrEqual(1);
  });

  test("search ignores accents, punctuation and Cyrillic vs Latin", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent([
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="s1",La Vie Rêve', "http://example.com/1.m3u8",
      '#EXTINF:-1 tvg-id="s2",КАНАЛ 1 HD', "http://example.com/2.m3u8",
      '#EXTINF:-1 tvg-id="s3",Nord-Sport', "http://example.com/3.m3u8",
      '#EXTINF:-1 tvg-id="s4",Ćirilica Đorđe', "http://example.com/4.m3u8",
    ].join("\n")));
    const cfg = enc({ t: "m3u", m: "http://example.com/search-norm.m3u" });
    const names = async (q) => (await request(app).get(`/${cfg}/catalog/tv/iptv_live/search=${encodeURIComponent(q)}.json`)).body.metas.map(m => m.name);

    expect(await names("la vie reve")).toEqual(["La Vie Rêve"]);
    expect(await names("RÊVE")).toEqual(["La Vie Rêve"]);
    expect(await names("kanal 1")).toEqual(["КАНАЛ 1 HD"]);
    expect(await names("канал")).toEqual(["КАНАЛ 1 HD"]);
    expect(await names("nord sport")).toEqual(["Nord-Sport"]);
    expect(await names("норд")).toEqual(["Nord-Sport"]);
    expect(await names("cirilica dorde")).toEqual(["Ćirilica Đorđe"]);
    expect(await names("kanal nord")).toEqual([]);
  });

  test("search treats ks = x and y = i as the same (Cyrillic typed for Latin and back)", async () => {
    jest.spyOn(m3u, "parseM3U").mockResolvedValue(m3u.parseM3UContent([
      "#EXTM3U",
      '#EXTINF:-1 tvg-id="x1",Maxima One', "http://example.com/1.m3u8",
      '#EXTINF:-1 tvg-id="x2",Максима Две', "http://example.com/2.m3u8",
      '#EXTINF:-1 tvg-id="x3",Yoana Live', "http://example.com/3.m3u8",
      '#EXTINF:-1 tvg-id="x4",Йоана Шоу', "http://example.com/4.m3u8",
    ].join("\n")));
    const cfg = enc({ t: "m3u", m: "http://example.com/search-alike.m3u" });
    const names = async (q) => (await request(app).get(`/${cfg}/catalog/tv/iptv_live/search=${encodeURIComponent(q)}.json`)).body.metas.map(m => m.name);

    expect(await names("макс")).toEqual(["Максима Две", "Maxima One"]); // кс → ks = x
    expect(await names("max")).toEqual(["Максима Две", "Maxima One"]);
    expect(await names("йоана")).toEqual(["Йоана Шоу", "Yoana Live"]);  // й → i = y
    expect(await names("yoana live")).toEqual(["Yoana Live"]);
    // sorting is unchanged: the full list keeps its normal A–Z order
    expect((await request(app).get(`/${cfg}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name))
      .toEqual(["Йоана Шоу", "Максима Две", "Maxima One", "Yoana Live"]);
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

// ─── Configure page visit counting ───

describe("unique users by network", () => {
  const crypto = require("crypto");
  const { userKey, userNetwork, knownUser, stats } = require("../src/stats");
  const { CONFIG_SECRET } = require("../src/configlink");

  test("IPv6 counts by its first half (/64), IPv4 by the whole address", () => {
    expect(userNetwork("2001:db8:aa:1:1111:2222:3333:4444")).toBe("2001:db8:aa:1::/64");
    expect(userNetwork("2001:0DB8:00AA:0001::1")).toBe("2001:db8:aa:1::/64");
    expect(userNetwork("2001:db8::5")).toBe("2001:db8:0:0::/64");
    expect(userNetwork("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(userNetwork("203.0.113.9")).toBe("203.0.113.9");
    // a phone's privacy address changes: still the same user
    expect(userKey("2001:db8:aa:1:1111:2222:3333:4444")).toBe(userKey("2001:db8:aa:1:9999:8888:7777:6666"));
    expect(userKey("2001:db8:aa:1::1")).not.toBe(userKey("2001:db8:aa:2::1"));
    expect(userKey("203.0.113.9")).not.toBe(userKey("203.0.113.10"));
  });

  test("a user saved with the old full-address code is moved over, not counted as new", () => {
    const ip = "2001:db8:bb:7:aaaa:bbbb:cccc:dddd";
    const secret = crypto.createHash("sha256").update(`stats-users|${CONFIG_SECRET}`).digest();
    const old = crypto.createHmac("sha256", secret).update(ip).digest("hex").slice(0, 16);
    stats.users.add(old);
    stats.bareUsers.add(old);
    const user = knownUser(ip);
    expect(user).toBe(userKey(ip));
    expect(stats.users.has(user)).toBe(true);
    expect(stats.users.has(old)).toBe(false);
    expect(stats.bareUsers.has(user)).toBe(true);
    expect(stats.bareUsers.has(old)).toBe(false);
  });

  test("a new address on the same IPv6 network is a returning user, not a new install", async () => {
    const m3u = require("../src/m3u");
    jest.spyOn(m3u, "parseM3UGroups").mockResolvedValue([]);
    const cfg = Buffer.from(JSON.stringify({ t: "m3u", m: "http://example.com/v6.m3u" })).toString("base64").replace(/=+$/, "");
    const installs = async () => (await request(app).get("/stats").set("Fly-Client-IP", "192.0.2.200")).body.installs;
    const before = await installs();
    await request(app).get(`/${cfg}/manifest.json`).set("Fly-Client-IP", "2001:db8:cc:1:1:2:3:4");
    await request(app).get(`/${cfg}/manifest.json`).set("Fly-Client-IP", "2001:db8:cc:1:5:6:7:8");
    expect(await installs()).toBe(before + 1);
    jest.restoreAllMocks();
  });
});

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
