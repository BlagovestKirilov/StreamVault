// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app, encryptConfig } = require("../src/addon");

// ─── Stable install links ("s-<id>") ───

describe("stable install links", () => {
  const m3u = require("../src/m3u");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const { spawnSync } = require("child_process");
  const stats = async () => (await request(app).get("/stats")).body;
  const playlist = [
    "#EXTM3U",
    '#EXTINF:-1 tvg-id="n1" group-title="News",News One', "http://example.com/n1.m3u8",
    '#EXTINF:-1 tvg-id="s1" group-title="Sport",Sport One', "http://example.com/s1.m3u8",
  ].join("\n");
  // like the real parser: only the selected groups
  beforeEach(() => jest.spyOn(m3u, "parseM3U").mockImplementation(async (_url, groups) => m3u.parseM3UContent(playlist, groups)));
  afterEach(() => jest.restoreAllMocks());
  const names = async (link) => (await request(app).get(`/${link}/catalog/tv/iptv_live.json`)).body.metas.map(m => m.name);

  test("Install gives a stable link that works like an encrypted one", async () => {
    const res = await request(app).post("/api/link").send({ t: "m3u", m: "http://stable.example.com/a.m3u" });
    expect(res.body.updated).toBe(false);
    expect(res.body.config).toMatch(/^s-[a-z0-9]{12}$/);
    const man = await request(app).get(`/${res.body.config}/manifest.json`);
    expect(man.body.description).toMatch(/^✓ Connected to your M3U playlist\./);
    expect(await names(res.body.config)).toEqual(["News One", "Sport One"]);
    expect((await stats()).caches.links).toBeGreaterThanOrEqual(1);
  });

  test("editing a stable link keeps the same link and applies the new settings", async () => {
    const link = (await request(app).post("/api/link").send({ t: "m3u", m: "http://stable.example.com/b.m3u" })).body.config;
    const genresBefore = (await request(app).get(`/${link}/manifest.json`)).body.catalogs[0].extra.find(e => e.name === "genre");
    expect(genresBefore.options).toEqual(["News", "Sport"]);

    const before = (await stats()).history[0].reinstalls || 0;
    const edit = await request(app).post("/api/link")
      .send({ t: "m3u", m: "http://stable.example.com/b.m3u", g: JSON.stringify(["Sport"]), editing: link });
    expect(edit.body).toEqual({ config: link, updated: true });
    expect((await stats()).history[0].reinstalls).toBe(before + 1);

    expect(await names(link)).toEqual(["Sport One"]);
    // the category list isn't served from the old cache entry
    const man = await request(app).get(`/${link}/manifest.json`);
    expect(man.body.catalogs[0].extra.map(e => e.name)).toEqual(["search", "skip"]);
  });

  test("an older link is edited in place too (no second StreamVault)", async () => {
    const old = (await request(app).post("/api/encrypt").send({ t: "m3u", m: "http://stable.example.com/c.m3u" })).body.config;
    expect(old).toMatch(/^e-/);
    expect(await names(old)).toEqual(["News One", "Sport One"]);

    const res = await request(app).post("/api/link")
      .send({ t: "m3u", m: "http://stable.example.com/c.m3u", g: JSON.stringify(["News"]), editing: old });
    expect(res.body).toEqual({ config: old, updated: true });
    expect(await names(old)).toEqual(["News One"]);
    expect((await request(app).get(`/api/config/${old}`)).body.categories).toEqual(["News"]);

    // a second edit updates the same override
    await request(app).post("/api/link").send({ t: "m3u", m: "http://stable.example.com/c.m3u", editing: old });
    expect(await names(old)).toEqual(["News One", "Sport One"]);
  });

  test("an editing value that isn't a real StreamVault link can't store anything", async () => {
    const res = await request(app).post("/api/link").send({ t: "m3u", m: "http://stable.example.com/d.m3u", editing: "garbage-link" });
    expect(res.body.updated).toBe(false);
    expect(res.body.config).toMatch(/^s-/); // a normal new link instead
  });

  test("a stable link that doesn't exist: the app gets the setup tile, the configure page a clear error", async () => {
    const res = await request(app).get("/s-zzzzzzzzzzzz/catalog/tv/iptv_live.json");
    expect(res.status).toBe(200);
    expect(res.body.metas).toEqual([expect.objectContaining({ id: "iptv_notice_setup" })]);
    const prefill = await request(app).get("/api/config/s-zzzzzzzzzzzz");
    expect(prefill.status).toBe(400);
    expect(prefill.body.error).toMatch(/no longer exists/);
  });

  test("opening Configure from an installed StreamVault counts as a reconfigure", async () => {
    const before = (await stats()).history[0].reconfigures || 0;
    await request(app).get("/s-abcdefghijkl/configure").set("Fly-Client-IP", "198.51.100.90");
    await request(app).get("/configure").set("Fly-Client-IP", "198.51.100.91");
    expect((await stats()).history[0].reconfigures).toBe(before + 1);
  });

  test("stable links are hidden in logged paths", async () => {
    await request(app).get("/s-abcdefghijkl/subtitles2/x.json");
    const paths = (await stats()).recentUnknownPaths.map(p => p.path).join(" ");
    expect(paths).not.toContain("s-abcdefghijkl");
  });

  test("links survive a restart; a corrupt file falls back to the backup", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-links-"));
    const run = (code) => spawnSync(process.execPath, ["-e", code], {
      cwd: path.join(__dirname, "..", "src"), env: { ...process.env, STATS_DIR: dir, FORCE_COLOR: "0" }, encoding: "utf8", timeout: 15000,
    });
    const last = (r) => r.stdout.trim().split("\n").pop();
    // 1st run: create, edit (2 saves → a .bak exists), shut down
    const r1 = run(`
      const r = require('supertest'); const { app } = require('./addon');
      r(app).post('/api/link').send({ t: 'm3u', m: 'http://persist.example.com/a.m3u' })
        .then(x => r(app).post('/api/link').send({ t: 'm3u', m: 'http://persist.example.com/b.m3u', editing: x.body.config }).then(() => x))
        .then(x => setTimeout(() => { console.log(x.body.config); process.emit('SIGTERM'); }, 300));
    `);
    const link = last(r1);
    expect(link).toMatch(/^s-/);
    expect(fs.existsSync(path.join(dir, "links.json"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "links.json"), "utf8")).not.toContain("persist.example.com"); // encrypted only

    const read = `const r = require('supertest'); const { app } = require('./addon');
      r(app).get('/api/config/${link}').then(x => { console.log(x.body.m3uUrl); process.exit(0); });`;
    expect(last(run(read))).toBe("http://persist.example.com/b.m3u");

    // main file corrupted → kept aside, the backup (previous version) is used
    fs.writeFileSync(path.join(dir, "links.json"), "{ not json");
    expect(last(run(read))).toBe("http://persist.example.com/a.m3u");
    expect(fs.readdirSync(dir).some(f => f.startsWith("links.json.corrupt-"))).toBe(true);
  });

  test("without links.json an edited older link falls back to the settings inside it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sv-links-"));
    const run = (code) => spawnSync(process.execPath, ["-e", code], {
      cwd: path.join(__dirname, "..", "src"), env: { ...process.env, STATS_DIR: dir, FORCE_COLOR: "0" }, encoding: "utf8", timeout: 15000,
    });
    const last = (r) => r.stdout.trim().split("\n").pop();
    const old = encryptConfig({ t: "m3u", m: "http://fallback.example.com/original.m3u" });
    const r1 = run(`
      const r = require('supertest'); const { app } = require('./addon');
      r(app).post('/api/link').send({ t: 'm3u', m: 'http://fallback.example.com/edited.m3u', editing: 'e-${old}' })
        .then(x => setTimeout(() => { console.log(x.body.updated); process.emit('SIGTERM'); }, 300));
    `);
    expect(last(r1)).toBe("true");
    const read = `const r = require('supertest'); const { app } = require('./addon');
      r(app).get('/api/config/e-${old}').then(x => { console.log(x.body.m3uUrl); process.exit(0); });`;
    expect(last(run(read))).toBe("http://fallback.example.com/edited.m3u");
    for (const f of fs.readdirSync(dir)) if (f.startsWith("links.json")) fs.unlinkSync(path.join(dir, f));
    expect(last(run(read))).toBe("http://fallback.example.com/original.m3u");
  });
});
