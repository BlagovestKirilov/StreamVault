// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

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
