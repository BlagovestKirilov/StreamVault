// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const { isPrivateIp, validateExternalUrl } = require("../src/addon");

// ─── Requests to providers identify as a player ───

// ─── SSRF: the address is re-checked when connecting ───

describe("connect-time address check (DNS rebinding)", () => {
  const dns = require("dns");
  const http = require("http");
  const { guardedLookup } = require("../src/urlguard");
  afterEach(() => jest.restoreAllMocks());

  const lookupWith = (addresses) =>
    jest.spyOn(dns, "lookup").mockImplementation((_host, _opts, cb) => cb(null, addresses));
  const run = (opts) => new Promise(res => guardedLookup("x.example", opts, (...a) => res(a)));

  test("refuses a host that resolves to a private address, passes public ones", async () => {
    lookupWith([{ address: "93.184.215.14", family: 4 }, { address: "10.0.0.5", family: 4 }]);
    expect((await run({}))[0].message).toBe("Invalid or blocked URL");
    jest.restoreAllMocks();

    lookupWith([{ address: "93.184.215.14", family: 4 }]);
    expect(await run({})).toEqual([null, "93.184.215.14", 4]);
    expect(await run({ all: true })).toEqual([null, [{ address: "93.184.215.14", family: 4 }]]);
  });

  test("a domain that passes the early check but then resolves inside is never connected to", async () => {
    let hits = 0;
    const server = http.createServer((_req, res) => { hits++; res.end("[]"); });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
      // Early check (validateExternalUrl) sees a public address...
      jest.spyOn(dns.promises, "lookup").mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
      // ...the connection's own lookup gets 127.0.0.1 (rebinding)
      lookupWith([{ address: "127.0.0.1", family: 4 }]);
      const xtream = require("../src/xtream");
      await expect(xtream.getLiveCategories({ server: `http://rebind.example:${port}`, username: "u", password: "p" }))
        .rejects.toThrow("Invalid or blocked URL");
      await expect(require("../src/m3u").parseM3UGroups(`http://rebind.example:${port}/list.m3u`))
        .rejects.toThrow("Invalid or blocked URL");
      expect(hits).toBe(0);
    } finally {
      server.close();
    }
  });
});

// ─── SSRF guard on fetch paths ───

describe("outbound fetch SSRF guard", () => {
  const m3uReal = jest.requireActual("../src/m3u");
  const xtream = require("../src/xtream");

  test("parseM3U refuses a private playlist URL", async () => {
    await expect(m3uReal.parseM3U("http://169.254.169.254/latest")).rejects.toThrow("Invalid or blocked URL");
  });

  test("xtream calls refuse a private server", async () => {
    const config = { server: "http://10.0.0.1:8080", username: "u", password: "p" };
    await expect(xtream.getLiveStreams(config)).rejects.toThrow("Invalid or blocked URL");
  });

  test("isPrivateIp catches bracketed and IPv4-mapped IPv6", () => {
    expect(isPrivateIp("[::1]")).toBe(true);
    expect(isPrivateIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateIp("[fdaa:0:1::2]")).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
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

describe("provider User-Agent", () => {
  const axios = require("axios");
  afterEach(() => jest.restoreAllMocks());

  test("playlist downloads send a VLC User-Agent (axios's default gets 403 from many panels)", async () => {
    const get = jest.spyOn(axios, "get").mockRejectedValue(new Error("stop"));
    await expect(require("../src/m3u").parseM3UGroups("http://93.184.215.14/ua.m3u")).rejects.toThrow("stop");
    expect(get.mock.calls[0][1].headers["User-Agent"]).toMatch(/^VLC\//);
  });
});
