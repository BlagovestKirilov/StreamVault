// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app } = require("../src/addon");

// ─── Rate limiting ───

describe("rate limiting", () => {
  const { getIp } = require("../src/ratelimit");
  const testBody = { type: "m3u" }; // fails validation fast (400), no network

  test("11th provider check from one IP in a minute gets 429; other groups unaffected", async () => {
    const ip = "203.0.113.10";
    for (let i = 0; i < 10; i++) {
      const ok = await request(app).post("/api/test").set("Fly-Client-IP", ip).send(testBody);
      expect(ok.status).toBe(400);
    }
    const blocked = await request(app).post("/api/test").set("Fly-Client-IP", ip).send(testBody);
    expect(blocked.status).toBe(429);
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.error).toBe("Too many requests");

    // same group, other endpoint → also blocked; other group → fine
    expect((await request(app).post("/api/m3u-groups").set("Fly-Client-IP", ip).send({})).status).toBe(429);
    expect((await request(app).post("/api/encrypt").set("Fly-Client-IP", ip).send({ t: "m3u", m: "http://example.com/x" })).status).toBe(200);
  });

  test("each client IP has its own budget; a forged X-Forwarded-For doesn't get a new one", async () => {
    const ip = "203.0.113.20";
    for (let i = 0; i < 10; i++) await request(app).post("/api/test").set("Fly-Client-IP", ip).send(testBody);
    const forged = await request(app).post("/api/test").set("Fly-Client-IP", ip).set("X-Forwarded-For", "9.9.9.9").send(testBody);
    expect(forged.status).toBe(429);
    const otherIp = await request(app).post("/api/test").set("Fly-Client-IP", "203.0.113.21").send(testBody);
    expect(otherIp.status).toBe(400);
  });

  test("/health is never limited", async () => {
    for (let i = 0; i < 30; i++) {
      expect((await request(app).get("/health").set("Fly-Client-IP", "203.0.113.30")).status).toBe(200);
    }
  });

  test("getIp prefers Fly-Client-IP and ignores X-Forwarded-For", () => {
    const req = (headers, remoteAddress = "10.0.0.1") => ({ headers, socket: { remoteAddress } });
    expect(getIp(req({ "fly-client-ip": "198.51.100.7", "x-forwarded-for": "1.2.3.4" }))).toBe("198.51.100.7");
    expect(getIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe("10.0.0.1");
  });
});

// ─── Pages, their files and unknown paths have a limit too ───

describe("page rate limit", () => {
  test("121st page-type request from one IP in a minute gets 429; addon routes unaffected", async () => {
    const ip = "203.0.113.120";
    const paths = ["/configure", "/public/css/configure.css", "/robots.txt", "/favicon.ico", "/go/kofi", "/setup", "/no-such-page"];
    for (let i = 0; i < 120; i++) {
      const res = await request(app).get(paths[i % paths.length]).set("Fly-Client-IP", ip);
      expect(res.status).not.toBe(429);
    }
    for (const path of paths) {
      expect((await request(app).get(path).set("Fly-Client-IP", ip)).status).toBe(429);
    }
    expect((await request(app).get("/manifest.json").set("Fly-Client-IP", ip)).status).toBe(200); // own budget
    expect((await request(app).get("/health").set("Fly-Client-IP", ip)).status).toBe(200);         // never limited
  });
});

describe("server time limits", () => {
  const { applyServerLimits } = require("../src/addon");

  test("a quiet connection is closed after 60 s; the request must arrive within 20 s", () => {
    const server = applyServerLimits(require("node:http").createServer());
    expect(server.timeout).toBe(60000);
    expect(server.requestTimeout).toBe(20000);
    expect(server.headersTimeout).toBe(20000);
  });

  test("a client that never sends its full request is cut off", async () => {
    const net = require("node:net");
    const server = require("node:http").createServer(app);
    applyServerLimits(server);
    server.setTimeout(300); // same mechanism, short for the test
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const closed = await new Promise((resolve) => {
      const socket = net.connect(server.address().port, "127.0.0.1", () => socket.write("GET /health HTTP/1.1\r\nHost: x\r\n")); // headers never finished
      socket.on("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    await new Promise(r => server.close(r));
    expect(closed).toBe(true);
  });
});
