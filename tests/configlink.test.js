// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const request = require("supertest");
const { app, parseConfigPath, encryptConfig, decryptConfig } = require("../src/addon");

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

describe("timezone config key", () => {
  test("/api/encrypt keeps z and parseConfigPath exposes it", async () => {
    const res = await request(app).post("/api/encrypt").send({ t: "m3u", m: "http://example.com/x.m3u", z: "Europe/Sofia" });
    expect(parseConfigPath(res.body.config).timezone).toBe("Europe/Sofia");
  });
});

// ─── Server addresses missing their slashes ───

describe("Xtream server address in its parsed form", () => {
  const { normalizeXtreamLogin } = require("../src/configlink");
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  test.each([
    ["http:provider.example:8080", "http://provider.example:8080"],
    ["http:/provider.example", "http://provider.example"],
    ["http://Provider.example:8080/", "http://provider.example:8080"],
    ["http://provider.example/panel/", "http://provider.example/panel"],
    ["https://provider.example", "https://provider.example"],
  ])("%s → %s", (typed, expected) => {
    expect(normalizeXtreamLogin(typed, "u", "p").server).toBe(expected);
  });

  test("no scheme: http:// is added (Xtream panels speak plain http)", () => {
    expect(normalizeXtreamLogin("provider.example", "u", "p").server).toBe("http://provider.example");
    expect(normalizeXtreamLogin("provider.example:8080/", "u", "p").server).toBe("http://provider.example:8080");
  });

  test("another scheme is left as typed (validation reports it)", () => {
    expect(normalizeXtreamLogin("ftp://provider.example", "u", "p").server).toBe("ftp://provider.example");
  });

  test("an install saved with 'http:host' gets a playable link (not a path on StreamVault)", async () => {
    const cfg = enc({ t: "xtream", s: "http:provider.example:8080", u: "u1", p: "p1" });
    const live = await request(app).get(`/play/${cfg}/live/12/ts/Delta`);
    expect(live.status).toBe(302);
    expect(live.headers.location).toBe("http://provider.example:8080/live/u1/p1/12.ts");
    const catchup = await request(app).get(`/play/${cfg}/timeshift/12/2026-11-01:07-00/60/ts/Delta`);
    expect(catchup.headers.location).toBe("http://provider.example:8080/timeshift/u1/p1/60/2026-11-01:07-00/12.ts");
  });
});

// ─── Invisible characters in pasted logins ───

describe("login fields lose invisible characters and outer spaces", () => {
  const { cleanField, normalizeXtreamLogin } = require("../src/configlink");
  const zw = "\u200B"; // zero-width space, as copied from chat apps

  test("cleanField drops zero-width space/joiners, word joiner, BOM and soft hyphen", () => {
    expect(cleanField(` u${zw}ser\u200C\u200D\u2060\uFEFF\u00AD `)).toBe("user");
    expect(cleanField(undefined)).toBe("");
    expect(cleanField("p@ss word")).toBe("p@ss word"); // inner spaces are kept
  });

  test("normalizeXtreamLogin cleans server, username and password", () => {
    expect(normalizeXtreamLogin(`${zw}http://example.com:8080${zw}`, `\uFEFFuser`, `pass\u00AD `))
      .toEqual({ server: "http://example.com:8080", username: "user", password: "pass" });
  });

  test("saved settings and the M3U link come back clean (saved via /api/link)", async () => {
    const xt = await request(app).post("/api/link").send({ t: "xtream", s: `http://example.com${zw}`, u: `${zw}user`, p: `pa${zw}ss`, c: "" });
    const back = (await request(app).get(`/api/config/${xt.body.config}`)).body;
    expect([back.server, back.username, back.password]).toEqual(["http://example.com", "user", "pass"]);
    const m3u = await request(app).post("/api/link").send({ t: "m3u", m: `\uFEFFhttp://example.com/list.m3u${zw}`, c: "" });
    expect((await request(app).get(`/api/config/${m3u.body.config}`)).body.m3uUrl).toBe("http://example.com/list.m3u");
  });

  test("Test Connection gets the cleaned login", async () => {
    const res = await request(app).post("/api/test").send({ type: "m3u", m3uUrl: `${zw}https://${zw}` });
    // only invisible characters around an empty address: refused as an address problem, not sent anywhere
    expect(res.status).toBe(400);
  });
});
