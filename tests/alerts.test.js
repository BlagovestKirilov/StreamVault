// Stats and run state live in a throwaway folder, never the repo
process.env.STATS_DIR = require("fs").mkdtempSync(require("path").join(require("os").tmpdir(), "sv-test-"));

const fs = require("fs");
const os = require("os");
const path = require("path");
const { alert, isCodeBug, reportBug, checkPreviousRun, markClean, markCrashed, ALERT_EVERY_MS, MARKER } = require("../src/alerts");

const URL_KEY = "ALERT_WEBHOOK_URL";
afterEach(() => {
  delete process.env[URL_KEY];
  jest.restoreAllMocks();
});

describe("alert", () => {
  test("nothing is sent without ALERT_WEBHOOK_URL", () => {
    const post = jest.fn();
    expect(alert("t-none", "x", { post })).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  test("sends once per kind per 30 minutes, prefixed and capped", () => {
    process.env[URL_KEY] = "https://discord.example/webhook";
    const post = jest.fn().mockResolvedValue({});
    const t0 = 1_000_000_000_000;
    expect(alert("t-rate", "first", { post, now: t0 })).toBe(true);
    expect(post).toHaveBeenCalledWith("🔴 first");
    expect(alert("t-rate", "again", { post, now: t0 + 60_000 })).toBe(false);
    expect(alert("t-other", "other kind", { post, now: t0 + 60_000 })).toBe(true);
    expect(alert("t-rate", "later", { post, now: t0 + ALERT_EVERY_MS })).toBe(true);
    expect(post).toHaveBeenCalledTimes(3);
    alert("t-long", "y".repeat(5000), { post, now: t0 });
    expect(post.mock.calls.at(-1)[0]).toHaveLength(1900);
  });

  test("a failed send is logged without the webhook address", async () => {
    process.env[URL_KEY] = "https://discord.example/secret-webhook";
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    alert("t-fail", "x", { post: () => Promise.reject(Object.assign(new Error("https://discord.example/secret-webhook"), { response: { status: 404 } })) });
    await new Promise(r => setImmediate(r));
    expect(warn).toHaveBeenCalledWith("[ALERT] not sent (t-fail): 404");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-webhook/);
  });
});

describe("crash detection across restarts", () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sv-run-"));
  beforeEach(() => jest.spyOn(console, "warn").mockImplementation(() => {}));

  test("first start and a start after a normal stop report nothing", () => {
    const d = dir();
    expect(checkPreviousRun(d)).toBeNull();
    markClean(d);
    expect(checkPreviousRun(d)).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(d, MARKER), "utf8")).state).toBe("running");
  });

  test("a run that never stopped normally (out-of-memory kill) is reported on the next start", () => {
    const d = dir();
    checkPreviousRun(d, new Date("2026-11-27T01:00:00Z"));
    const text = checkPreviousRun(d);
    expect(text).toBe("StreamVault restarted — the previous run (started 2026-11-27T01:00:00.000Z) stopped without a normal shutdown (likely killed for using too much memory). Not a deploy.");
  });

  test("an uncaught exception names its (masked) reason on the next start", () => {
    const d = dir();
    checkPreviousRun(d);
    markCrashed(d, new Error("connect ECONNREFUSED 203.0.113.7:8080"));
    const text = checkPreviousRun(d);
    expect(text).toMatch(/crashed: connect ECONNREFUSED 203\.0\.113\.x\. Not a deploy\.$/);
    expect(text).not.toMatch(/203\.0\.113\.7/);
  });

  test("the alert is sent when a webhook is set", () => {
    process.env[URL_KEY] = "https://discord.example/webhook";
    const axios = require("axios");
    const post = jest.spyOn(axios, "post").mockResolvedValue({});
    const d = dir();
    checkPreviousRun(d);
    checkPreviousRun(d);
    expect(post).toHaveBeenCalledWith("https://discord.example/webhook",
      { content: expect.stringMatching(/^🔴 StreamVault restarted/), allowed_mentions: { parse: [] } }, { timeout: 5000 });
  });
});

describe("critical events send an alert", () => {
  test("a freeze over 30 s", () => {
    process.env[URL_KEY] = "https://discord.example/webhook";
    const axios = require("axios");
    const post = jest.spyOn(axios, "post").mockResolvedValue({});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const { noteFreeze } = require("../src/cache");
    noteFreeze(5000);
    expect(post).not.toHaveBeenCalled(); // logged and counted, not alerted
    noteFreeze(31000);
    expect(post.mock.calls.at(-1)[1].content).toMatch(/^🔴 StreamVault server blocked 31\.0 s — heap \d+ MB; loading: /);
  });
});

describe("bugs are told apart from expected failures", () => {
  test.each([
    ["x is not a function", new TypeError("x is not a function"), true],
    ["y is not defined", new ReferenceError("y is not defined"), true],
    ["invalid array length", new RangeError("Invalid array length"), true],
    ["bad URL (has a code)", Object.assign(new TypeError("Invalid URL"), { code: "ERR_INVALID_URL" }), false],
    ["network error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), false],
    ["provider answer (axios)", Object.assign(new Error("Request failed with status code 503"), { isAxiosError: true }), false],
    ["our own timeout", new Error("timeout of 60000ms exceeded"), false],
    ["bad JSON from a provider", new SyntaxError("Unexpected token <"), false],
    ["nothing", undefined, false],
  ])("%s", (_name, error, bug) => {
    expect(isCodeBug(error)).toBe(bug);
  });

  test("reportBug logs an [ERROR] line (masked) and alerts", () => {
    process.env[URL_KEY] = "https://discord.example/webhook";
    const axios = require("axios");
    const post = jest.spyOn(axios, "post").mockResolvedValue({});
    const err = jest.spyOn(console, "error").mockImplementation(() => {});
    reportBug("doing something", new TypeError("cannot read properties of undefined (reading 'x') at http://203.0.113.9/live"));
    expect(err.mock.calls[0][0]).toMatch(/^\[ERROR\] doing something: /);
    expect(err.mock.calls[0][0]).not.toMatch(/203\.0\.113\.9/);
    expect(post.mock.calls[0][1].content).toMatch(/^🔴 Unexpected error while doing something: /);
  });
});
