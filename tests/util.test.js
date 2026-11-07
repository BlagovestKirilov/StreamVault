// Stats and stable links live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const { parseExtra, safeError } = require("../src/addon");

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

// ─── maskPath ───

describe("maskPath", () => {
  const { maskPath } = require("../src/util");

  test("hides install links (base64, e-, s-) as before", () => {
    expect(maskPath("/eyJ0IjoieHRyZWFtIn0/manifest.json")).toBe("/<config>/manifest.json");
    expect(maskPath("/s-abcdefabcdef/catalog/tv/iptv_live.json")).toBe("/<config>/catalog/tv/iptv_live.json");
  });

  test("hides the login in provider stream paths that reach StreamVault by mistake", () => {
    expect(maskPath("/provider.example/live/someone@mail.example/Secret123/948207.ts"))
      .toBe("/provider.example/live/<hidden>/<hidden>/948207.ts");
    expect(maskPath("/provider.example/timeshift/user1/Secret123/60/2026-11-01:07-00/1763841.ts"))
      .toBe("/provider.example/timeshift/<hidden>/<hidden>/60/2026-11-01:07-00/1763841.ts");
    expect(maskPath("/x/movie/user1/Secret123/55.mp4")).toBe("/x/movie/<hidden>/<hidden>/55.mp4");
  });

  test("hides anything with @ and leaves ordinary paths readable", () => {
    expect(maskPath("/someone@mail.example/x.json")).toBe("/<hidden>/x.json");
    expect(maskPath("/catalog/tv/iptv_live/search=live.json")).toBe("/catalog/tv/iptv_live/search=live.json");
    expect(maskPath("/meta/movie/tt123.json")).toBe("/meta/movie/tt123.json");
  });
});

// ─── trimPathSpaces ───

describe("trimPathSpaces", () => {
  const { trimPathSpaces } = require("../src/util");

  test.each([
    ["/manifest.json", "/manifest.json"],
    ["/%20manifest.json", "/manifest.json"],
    ["/link/%20manifest.json", "/link/manifest.json"],
    ["/link%20/manifest.json", "/link/manifest.json"],
    ["/%20%20link/manifest.json%20", "/link/manifest.json"],
    ["/link/%20/catalog/tv/x.json", "/link/catalog/tv/x.json"],
    ["/link/catalog/tv/x/search=a%20b.json", "/link/catalog/tv/x/search=a%20b.json"],
    ["/%20", "/"],
    ["/", "/"],
  ])("%s → %s", (input, expected) => {
    expect(trimPathSpaces(input)).toBe(expected);
  });
});
