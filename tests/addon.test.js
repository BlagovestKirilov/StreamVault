const request = require("supertest");
const { app, parseConfigPath, parseExtra, makePosterUrl, encryptConfig, decryptConfig, isPrivateIp, validateExternalUrl, safeError } = require("../addon");
const { parseM3UContent } = require("../m3u");

// ─── parseConfigPath ───

describe("parseConfigPath", () => {
  test("decodes base64url xtream config", () => {
    const config = { t: "xtream", s: "http://example.com:8080", u: "user1", p: "pass1", c: "5" };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = parseConfigPath(encoded);
    expect(result.type).toBe("xtream");
    expect(result.server).toBe("http://example.com:8080");
    expect(result.username).toBe("user1");
    expect(result.password).toBe("pass1");
    expect(result.country).toBe("5");
  });

  test("decodes base64url m3u config", () => {
    const config = { t: "m3u", m: "http://example.com/playlist.m3u", c: "" };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = parseConfigPath(encoded);
    expect(result.type).toBe("m3u");
    expect(result.url).toBe("http://example.com/playlist.m3u");
  });

  test("decodes legacy URL-encoded xtream config", () => {
    const configStr = "sourceType=xtream&server=http%3A%2F%2Fexample.com&username=user1&password=pass1&country=5";
    const result = parseConfigPath(configStr);
    expect(result.type).toBe("xtream");
    expect(result.server).toBe("http://example.com");
    expect(result.username).toBe("user1");
    expect(result.password).toBe("pass1");
  });

  test("decodes legacy URL-encoded m3u config", () => {
    const configStr = "sourceType=m3u&m3uUrl=http%3A%2F%2Fexample.com%2Fplaylist.m3u";
    const result = parseConfigPath(configStr);
    expect(result.type).toBe("m3u");
    expect(result.url).toBe("http://example.com/playlist.m3u");
  });

  test("rejects garbage base64 that doesn't start with 'ey'", () => {
    const result = parseConfigPath("favicon");
    // Should fall through to legacy and return m3u with empty url
    expect(result.type).toBe("m3u");
    expect(result.url).toBe("");
  });

  test("decodes encrypted xtream config", () => {
    const config = { t: "xtream", s: "http://example.com:8080", u: "user1", p: "pass1", c: "5" };
    const encrypted = "e-" + encryptConfig(config);
    const result = parseConfigPath(encrypted);
    expect(result.type).toBe("xtream");
    expect(result.server).toBe("http://example.com:8080");
    expect(result.username).toBe("user1");
    expect(result.password).toBe("pass1");
  });

  test("decodes encrypted m3u config", () => {
    const config = { t: "m3u", m: "http://example.com/list.m3u", c: "" };
    const encrypted = "e-" + encryptConfig(config);
    const result = parseConfigPath(encrypted);
    expect(result.type).toBe("m3u");
    expect(result.url).toBe("http://example.com/list.m3u");
  });
});

// ─── parseExtra ───

describe("parseExtra", () => {
  test("parses search parameter", () => {
    const result = parseExtra("search=hello%20world");
    expect(result.search).toBe("hello world");
  });

  test("parses skip parameter", () => {
    const result = parseExtra("skip=100");
    expect(result.skip).toBe("100");
  });

  test("parses multiple parameters", () => {
    const result = parseExtra("search=test&skip=50");
    expect(result.search).toBe("test");
    expect(result.skip).toBe("50");
  });

  test("strips .json suffix", () => {
    const result = parseExtra("search=test.json");
    expect(result.search).toBe("test");
  });
});

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

// ─── M3U parser ───

describe("parseM3UContent", () => {
  test("parses valid M3U content", () => {
    const content = `#EXTM3U
#EXTINF:-1 tvg-id="ch1" tvg-name="Channel 1" tvg-logo="http://logo.png" group-title="News",Channel 1
http://stream1.example.com/live.m3u8
#EXTINF:-1 tvg-id="ch2" tvg-name="Channel 2" group-title="Sports",Channel 2
http://stream2.example.com/live.m3u8`;

    const { channels, categories } = parseM3UContent(content);
    expect(channels).toHaveLength(2);
    expect(channels[0].name).toBe("Channel 1");
    expect(channels[0].logo).toBe("http://logo.png");
    expect(channels[0].group).toBe("News");
    expect(channels[0].url).toBe("http://stream1.example.com/live.m3u8");
    expect(channels[1].name).toBe("Channel 2");
    expect(channels[1].group).toBe("Sports");
    expect(Object.keys(categories)).toHaveLength(2);
    expect(categories["News"]).toHaveLength(1);
    expect(categories["Sports"]).toHaveLength(1);
  });

  test("handles empty content", () => {
    const { channels } = parseM3UContent("");
    expect(channels).toHaveLength(0);
  });

  test("handles missing group-title", () => {
    const content = `#EXTM3U
#EXTINF:-1,No Group Channel
http://stream.example.com/live.m3u8`;
    const { channels } = parseM3UContent(content);
    expect(channels).toHaveLength(1);
    expect(channels[0].group).toBe("Uncategorized");
  });

  test("detects VOD by file extension", () => {
    const content = `#EXTM3U
#EXTINF:-1,Movie Title
http://example.com/movie.mp4`;
    const { channels } = parseM3UContent(content);
    expect(channels[0].type).toBe("movie");
  });

  test("detects series by group title", () => {
    const content = `#EXTM3U
#EXTINF:-1 group-title="Series",My Show S01E01
http://example.com/show.m3u8`;
    const { channels } = parseM3UContent(content);
    expect(channels[0].type).toBe("series");
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
    const config = { t: "xtream", s: "http://example.com", u: "user", p: "pass", c: "" };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await request(app).get(`/${encoded}/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("community.streamvault.addon");
    expect(res.body.behaviorHints.configurable).toBe(true);
    expect(res.body.behaviorHints.configurationRequired).toBeUndefined();
  });

  test("GET /:config/manifest.json rejects invalid config", async () => {
    const config = { t: "xtream", s: "", u: "", p: "", c: "" };
    const encoded = Buffer.from(JSON.stringify(config)).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const res = await request(app).get(`/${encoded}/manifest.json`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
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

// ─── Encryption ───

describe("encryptConfig / decryptConfig", () => {
  test("encrypts and decrypts correctly", () => {
    const original = { t: "xtream", s: "http://test.com", u: "user", p: "pass123", c: "5" };
    const encrypted = encryptConfig(original);
    const decrypted = decryptConfig(encrypted);
    expect(decrypted).toEqual(original);
  });

  test("different encryptions produce different ciphertexts (random IV)", () => {
    const config = { t: "xtream", s: "http://test.com", u: "user", p: "pass", c: "" };
    const enc1 = encryptConfig(config);
    const enc2 = encryptConfig(config);
    expect(enc1).not.toBe(enc2);
  });

  test("tampered ciphertext throws", () => {
    const config = { t: "xtream", s: "http://test.com", u: "user", p: "pass", c: "" };
    const encrypted = encryptConfig(config);
    // Corrupt the auth tag (chars 24-56) to guarantee authentication failure
    const tampered = encrypted.slice(0, 24) + "00".repeat(16) + encrypted.slice(56);
    expect(() => decryptConfig(tampered)).toThrow();
  });
});

// ─── SSRF protection ───

describe("isPrivateIp", () => {
  test("blocks 127.x.x.x (loopback)", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("127.99.99.99")).toBe(true);
  });

  test("blocks 10.x.x.x (private)", () => {
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("10.255.255.255")).toBe(true);
  });

  test("blocks 192.168.x.x (private)", () => {
    expect(isPrivateIp("192.168.0.1")).toBe(true);
    expect(isPrivateIp("192.168.255.255")).toBe(true);
  });

  test("blocks 172.16-31.x.x (private)", () => {
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("172.31.255.255")).toBe(true);
  });

  test("blocks 169.254.x.x (link-local)", () => {
    expect(isPrivateIp("169.254.169.254")).toBe(true);
  });

  test("blocks IPv6 loopback and private", () => {
    expect(isPrivateIp("::1")).toBe(true);
    expect(isPrivateIp("fd00:")).toBe(true);
    expect(isPrivateIp("fe80:")).toBe(true);
  });

  test("allows public IPs", () => {
    expect(isPrivateIp("8.8.8.8")).toBe(false);
    expect(isPrivateIp("1.1.1.1")).toBe(false);
    expect(isPrivateIp("203.0.113.1")).toBe(false);
  });
});

describe("validateExternalUrl", () => {
  test("rejects non-string input", async () => {
    expect(await validateExternalUrl(null)).toBe(false);
    expect(await validateExternalUrl(undefined)).toBe(false);
    expect(await validateExternalUrl(123)).toBe(false);
  });

  test("rejects URLs longer than 2048 chars", async () => {
    const longUrl = "http://example.com/" + "a".repeat(2040);
    expect(await validateExternalUrl(longUrl)).toBe(false);
  });

  test("rejects non-http protocols", async () => {
    expect(await validateExternalUrl("ftp://example.com")).toBe(false);
    expect(await validateExternalUrl("file:///etc/passwd")).toBe(false);
  });

  test("rejects localhost", async () => {
    expect(await validateExternalUrl("http://localhost:8080")).toBe(false);
    expect(await validateExternalUrl("http://127.0.0.1:8080")).toBe(false);
  });

  test("rejects private IP addresses", async () => {
    expect(await validateExternalUrl("http://10.0.0.1/api")).toBe(false);
    expect(await validateExternalUrl("http://192.168.1.1/api")).toBe(false);
    expect(await validateExternalUrl("http://172.16.0.1/api")).toBe(false);
  });

  test("rejects .local and .internal hostnames", async () => {
    expect(await validateExternalUrl("http://myserver.local")).toBe(false);
    expect(await validateExternalUrl("http://service.internal")).toBe(false);
  });

  test("rejects cloud metadata endpoints", async () => {
    expect(await validateExternalUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  test("accepts valid external URLs", async () => {
    expect(await validateExternalUrl("http://example.com")).toBe(true);
    expect(await validateExternalUrl("https://google.com")).toBe(true);
  });
});

// ─── safeError ───

describe("safeError", () => {
  test("strips URLs from error messages", () => {
    const err = new Error("connect ECONNREFUSED http://192.168.1.1:8080/api");
    expect(safeError(err)).toBe("Connection failed");
  });

  test("truncates long error messages", () => {
    const err = new Error("A".repeat(200));
    expect(safeError(err).length).toBeLessThanOrEqual(100);
  });

  test("passes through short safe messages", () => {
    const err = new Error("timeout");
    expect(safeError(err)).toBe("timeout");
  });

  test("handles missing message", () => {
    const err = {};
    expect(safeError(err)).toBe("Unknown error");
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
    expect(decrypted.m.length).toBe(2048);
  });
});
