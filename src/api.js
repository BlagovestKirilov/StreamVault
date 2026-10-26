/**
 * api.js — The configure page's API: provider checks (/api/test,
 * /api/categories, /api/m3u-groups), saving settings (/api/link, /api/encrypt)
 * and reading an install's settings back (/api/config).
 */

const xtream = require("./xtream");
const m3u = require("./m3u");
const { safeError } = require("./util");
const { validateExternalUrl, trimTrailingSlashes } = require("./urlguard");
const {
  encryptConfig, configFromSettings, isPlaylistLink, normalizeXtreamLogin,
} = require("./configlink");
const {
  stats, countToday, countCode, providerErrorKey, noteRecent, recentTestFailures,
} = require("./stats");
const { once, withDownloadSlot } = require("./cache");
const { accountProblem } = require("./notices");
const { forceRefresh } = require("./xtream-addon");

// --- API: Encrypt config for secure URL ---
const ALLOWED_CONFIG_KEYS = new Set(["t", "s", "u", "p", "m", "c", "z", "g"]);

// Settings from the configure page → only known fields, nothing cut off silently
function sanitizeConfig(configObj) {
  const type = configObj?.t;
  if (type !== "xtream" && type !== "m3u") {
    return { error: "Invalid config" };
  }
  const sanitized = {};
  for (const key of Object.keys(configObj)) {
    if (ALLOWED_CONFIG_KEYS.has(key)) {
      sanitized[key] = String(configObj[key]).slice(0, 2048);
    }
  }
  // A truncated selection would silently fall back to "all groups" (M3U) or
  // keep a cut-off list of category ids (Xtream)
  if (sanitized.g && String(configObj.g).length > 2048) return { error: "Too many groups selected — pick fewer" };
  if (sanitized.c && String(configObj.c).length > 2048) return { error: "Too many categories selected — pick fewer" };
  return { sanitized };
}

// "Account: Active · expires 2026-12-01 · 1/2 connections" (parts the provider omits are skipped)
function formatAccountInfo(info) {
  if (!info || typeof info !== "object") return "";
  const parts = [];
  if (info.status) parts.push(String(info.status).slice(0, 20));
  if (String(info.is_trial) === "1") parts.push("trial");
  const exp = Number(info.exp_date);
  if (exp > 0) parts.push(`expires ${new Date(exp * 1000).toISOString().slice(0, 10)}`);
  else if (info.exp_date === null || info.exp_date === "null") parts.push("no expiry");
  const max = Number(info.max_connections);
  if (max > 0) {
    const active = Number(info.active_cons);
    parts.push(Number.isFinite(active) ? `${active}/${max} connections` : `${max} connections`);
  }
  return parts.length ? `Account: ${parts.join(" · ")}` : "";
}

// Plain-language Test Connection errors for cases whose raw message means nothing
// to users (keys from providerErrorKey)
const TEST_ERROR_HINTS = {
  https_mismatch: "Your server address should probably start with http:// instead of https://",
  "429": "Your provider is limiting requests — try again in a few minutes",
  "403": "Your provider refused the connection from StreamVault's server. Check the link/login; some providers block servers — if it works in your player app, contact your provider",
  "451": "Your provider blocks StreamVault's server (some block servers in certain countries or data centres) — if it works in your player app, contact your provider",
};

// A playlist link that works but has no live TV: say which of the usual causes
// it is (from what the parser saw), so users know what to fix
function whyNoLiveChannels(shape) {
  const s = shape || {};
  if (s.html) {
    return { kind: "no_channels_web_page", message: "This link returned a web page, not a playlist — check the link (it may have expired or need a login)" };
  }
  if (s.vod > 0) {
    return { kind: "no_channels_vod_only", message: `This playlist only has movies/series (${s.vod}) — StreamVault shows live TV channels only` };
  }
  if (s.lines === 0) {
    return { kind: "no_channels_empty", message: "This playlist is empty — check the link with your provider" };
  }
  if (s.extinf === 0) {
    return { kind: "no_channels_not_m3u", message: "This link doesn't look like an M3U playlist — check that you copied the playlist link" };
  }
  return { kind: "no_channels", message: "No live channels found in this playlist" };
}

// Address with everything private hidden: scheme + port + path structure only.
// Host → <host>; path segments → <seg> unless they're a known file name
// (get.php, player_api.php, *.m3u/.m3u8); query → "?…". Paths/queries can hold
// usernames, passwords and tokens, so nothing else is kept.
const KNOWN_PATH_FILE = /^([a-z_]+\.php|[^/]*\.m3u8?)$/i;
function addressShape(url) {
  let u;
  try {
    u = new URL(String(url || ""));
  } catch (_) {
    return "not a URL"; // that's the answer: the shape of what was entered
  }
  const path = u.pathname.split("/").map(seg => (!seg || KNOWN_PATH_FILE.test(seg) ? seg : "<seg>")).join("/");
  return `${u.protocol}//<host>${u.port ? ":" + u.port : ""}${path}${u.search ? "?…" : ""}`;
}

// --- API: Test connection to provider ---
// Why an Xtream test failed (provider-error kind + message for the user), or null
function xtreamTestProblem(cats, account) {
  // Many panels answer a bad login with an empty list instead of an error, so
  // the account status is what tells a wrong password / expired account apart
  const problem = accountProblem(account);
  if (problem) return ["account", problem];
  if (!Array.isArray(cats)) return ["invalid_response", "This address doesn't answer like an Xtream server. Check the server address (only http://name:port, without /get.php or other paths) — or use the M3U tab if you have a playlist link"];
  if (cats.length === 0) return ["no_channels", "No live channels on this account"];
  return null;
}

// An address copied from a guide with its placeholder left in ("…/<FILENAME>.m3u")
const PLACEHOLDER_RE = /<[^<>]{1,40}>|%3C[^%]{1,40}%3E/i;
const PLACEHOLDER_HINT = "The address still contains a placeholder like <FILENAME> — replace it with your real playlist link";

// Test Connection, Xtream: login + categories (+ account status)
async function testXtream(body, res) {
  const { server, username, password } = normalizeXtreamLogin(body.server, body.username, body.password);
  if (PLACEHOLDER_RE.test(server)) {
    return res.status(400).json({ ok: false, error: PLACEHOLDER_HINT.replace("playlist link", "server address") });
  }
  if (isPlaylistLink(server)) {
    return res.status(400).json({ ok: false, error: "This is a playlist link — use the M3U tab instead" });
  }
  if (!server || !username || !password) {
    return res.status(400).json({ ok: false, error: "Missing credentials" });
  }
  if (!(await validateExternalUrl(server))) {
    return res.status(400).json({ ok: false, error: "Invalid or blocked server URL" });
  }
  const config = { server: trimTrailingSlashes(server), username, password };
  const [cats, account] = await Promise.all([
    xtream.getLiveCategories(config),
    xtream.getAccountInfo(config).catch(() => null), // no account info = can't check it, not a failure
  ]);
  const failure = xtreamTestProblem(cats, account);
  if (failure) {
    countCode("providerErrors", "test (xtream)", failure[0]);
    return res.json({ ok: false, error: failure[1] });
  }
  res.json({
    ok: true,
    message: `Connected! Found ${cats.length} live categories.`,
    account: formatAccountInfo(account),
    // Lets the configure page fill the category picker without a second request
    categories: cats.map(c => ({ category_id: c.category_id, category_name: c.category_name || "" })),
  });
}

// Test Connection, M3U: playlist groups with channel counts
async function testM3u(m3uUrl, res) {
  if (!m3uUrl) {
    return res.status(400).json({ ok: false, error: "Missing M3U URL" });
  }
  if (PLACEHOLDER_RE.test(m3uUrl)) {
    return res.status(400).json({ ok: false, error: PLACEHOLDER_HINT });
  }
  if (!(await validateExternalUrl(m3uUrl))) {
    return res.status(400).json({ ok: false, error: "Invalid or blocked M3U URL" });
  }
  // Group counts only (no channel list in memory); shared with /api/m3u-groups,
  // so test + group picker cost one download
  const groups = await once(`groups:${m3uUrl}`, () => withDownloadSlot(() => m3u.parseM3UGroups(m3uUrl)));
  const total = groups.reduce((sum, g) => sum + g.count, 0);
  if (total === 0) {
    const { kind, message } = whyNoLiveChannels(groups.shape);
    countCode("providerErrors", "test (m3u)", kind);
    return res.json({ ok: false, error: message });
  }
  res.json({ ok: true, message: `Connected! Found ${total} channels.`, groups });
}

// A failed Test Connection: counted, listed (address shape only) and explained
function answerTestFailure(body, res, e) {
  const key = providerErrorKey(e);
  const source = body.type === "xtream" ? "xtream" : "m3u";
  countCode("providerErrors", `test (${source})`, key);
  // What kind of address failed (host/path/query hidden) — e.g. to tell a
  // wrong port from a path pasted into the Xtream server field
  const entered = source === "xtream"
    ? normalizeXtreamLogin(body.server, body.username, body.password).server
    : body.m3uUrl;
  noteRecent(recentTestFailures, { source, error: key, address: addressShape(entered) });
  // "Use http:// instead of https://" only helps if the address IS https://;
  // an http:// address can hit this too (provider redirects to https on a
  // port without a certificate)
  const sslOnHttp = key === "https_mismatch" && !/^https:/i.test(String(entered || ""));
  const hint = sslOnHttp
    ? "Your provider's server had a secure-connection (SSL) problem. Try again later, or check the address with your provider"
    : TEST_ERROR_HINTS[key];
  res.json({ ok: false, error: hint || safeError(e) });
}

// Registered by addon.js at the same point as before (Express matches routes in
// order). The install-link helpers come from addon.js (they need its link store).
function registerApiRoutes(app, { linkStore, parseConfigPath, extractConfig, limitProviderChecks, limitConfig }) {
  // --- API: Fetch categories from provider ---
  app.post("/api/categories", limitProviderChecks, async (req, res) => {
    try {
      const { server, username, password } = normalizeXtreamLogin(req.body.server, req.body.username, req.body.password);
      if (!server || !username || !password) {
        return res.status(400).json({ error: "Missing credentials" });
      }
      if (!(await validateExternalUrl(server))) {
        return res.status(400).json({ error: "Invalid or blocked server URL" });
      }
      const config = { server: trimTrailingSlashes(server), username, password };
      const live = await xtream.getLiveCategories(config).catch(() => []);
      res.json({ live });
    } catch (e) {
      res.status(500).json({ error: safeError(e) });
    }
  });

  // --- API: List M3U groups (configure page group picker) ---
  // Counts only — no channels are kept in memory, and concurrent clicks share one download
  app.post("/api/m3u-groups", limitProviderChecks, async (req, res) => {
    try {
      const { m3uUrl } = req.body || {};
      if (!m3uUrl) {
        return res.status(400).json({ error: "Missing M3U URL" });
      }
      if (!(await validateExternalUrl(m3uUrl))) {
        return res.status(400).json({ error: "Invalid or blocked M3U URL" });
      }
      const groups = await once(`groups:${m3uUrl}`, () => withDownloadSlot(() => m3u.parseM3UGroups(m3uUrl)));
      res.json({ groups });
    } catch (e) {
      res.status(500).json({ error: safeError(e) });
    }
  });

  // An older install link that really is a StreamVault setup (so random strings
  // can't be used to fill the store with overrides)
  function isUsableOldLink(link) {
    try {
      const c = parseConfigPath(link);
      if (c.type === "m3u") return !!c.url;
      if (c.type === "xtream") return !!(c.server && c.username && c.password);
      return false;
    } catch (_) {
      return false; // can't be read, so it isn't a usable link
    }
  }

  app.post("/api/encrypt", limitConfig, (req, res) => {
    try {
      const { error, sanitized } = sanitizeConfig(req.body);
      if (error) return res.status(400).json({ error });
      res.json({ config: "e-" + encryptConfig(sanitized) });
    } catch (e) {
      console.error("[ENCRYPT] failed:", e.message);
      res.status(500).json({ error: "Encryption failed" });
    }
  });

  // Install link from the configure page: a stable "s-<id>" link. When the page
  // was opened from an installed StreamVault ("editing" = its link), that link is
  // updated in place — same link, so apps don't add a second StreamVault. An "s-"
  // link gets its settings replaced; an older link (e-/base64/plain) gets an
  // override. Only a full store (or an unreadable old link) gives a new link.
  app.post("/api/link", limitConfig, (req, res) => {
    try {
      const { error, sanitized } = sanitizeConfig(req.body);
      if (error) return res.status(400).json({ error });
      const encrypted = encryptConfig(sanitized);
      // Saving reloads the channel list (configure page hint says so)
      const config = configFromSettings(sanitized);
      if (config.type === "xtream") Object.assign(config, normalizeXtreamLogin(config.server, config.username, config.password));
      forceRefresh(config);
      // Not truncated: a cut-off link would fingerprint as a different link
      const editing = typeof req.body.editing === "string" && req.body.editing.length <= 8192 ? req.body.editing : "";
      if (editing) {
        stats.reinstalls++;
        countToday("reinstalls");
      }
      if (linkStore.isId(editing)) {
        if (linkStore.update(editing, encrypted)) return res.json({ config: editing, updated: true });
      } else if (editing && isUsableOldLink(editing) && linkStore.setOverride(editing, encrypted)) {
        return res.json({ config: editing, updated: true });
      }
      const id = linkStore.create(encrypted);
      res.json({ config: id || "e-" + encrypted, updated: false });
    } catch (e) {
      console.error("[LINK] save failed:", e.message);
      res.status(500).json({ error: "Couldn't save your settings" });
    }
  });

  // --- API: Read back an install's settings (configure page opened from Stremio) ---
  // Whoever holds the install link can already use these credentials, so returning
  // them to the same link holder exposes nothing new.
  app.get("/api/config/:config", limitConfig, extractConfig, (req, res) => {
    const c = req.userConfig;
    res.setHeader("Cache-Control", "no-store");
    if (c.type === "xtream") {
      return res.json({
        type: "xtream", server: c.server, username: c.username, password: c.password,
        categories: (c.country || "").split(",").filter(Boolean),
      });
    }
    res.json({ type: "m3u", m3uUrl: c.url, categories: c.groups || [] });
  });

  app.post("/api/test", limitProviderChecks, async (req, res) => {
    const body = req.body || {};
    try {
      if (body.type === "xtream") return await testXtream(body, res);
      if (body.type === "m3u") return await testM3u(body.m3uUrl, res);
      res.status(400).json({ ok: false, error: "Unknown source type" });
    } catch (e) {
      answerTestFailure(body, res, e);
    }
  });
}

module.exports = { registerApiRoutes, formatAccountInfo };
