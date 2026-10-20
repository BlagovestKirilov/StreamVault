# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Keep this file accurate (required)

Every change that alters behaviour, an endpoint, a stats counter, a file on the volume, a limit, a user-facing text or a coding rule must update this file **in the same commit**. Before committing, check the sections it touches (request flow, config encoding, Stremio details, memory/stats, code rules, deployment) and remove anything the change made untrue. Keep entries short; describe how it works now, not the history.

## Commands

```bash
npm start        # Start the Express server on port 7000
npm test         # Run Jest test suite (jest --forceExit --detectOpenHandles)
```

There are no build or lint steps — this is a plain Node.js project with no transpilation.

To run a single test file or test by name:
```bash
npx jest tests/addon.test.js
npx jest --testNamePattern "SSRF"
```

## Architecture

StreamVault is a Stremio addon (Express.js HTTP server) that proxies IPTV streams from Xtream Codes API servers or M3U playlists into the Stremio protocol. **Live TV only** — VOD/series are intentionally dropped (memory).

### Core files

- **`addon.js`** — Express routes, config parsing, caching, encryption, analytics, and all Stremio protocol handlers.
- **`xtream.js`** — Thin wrapper around the Xtream Codes HTTP API (categories, streams, short EPG, account info). Every call is SSRF-checked.
- **`m3u.js`** — Streaming M3U parser (`createLineParser`): live-only filter, unique ids, playlist headers, optional group filter, group-count mode.
- **`urlguard.js`** — SSRF protection (`validateExternalUrl`, `assertExternalUrl`, `blockPrivateRedirects`), plus `guardedAgents` (axios http/https agents whose DNS lookup refuses private addresses at connect time — covers DNS rebinding, redirects to internal hosts and the 5-min `okHosts` cache; every provider request must use them) and `PROVIDER_USER_AGENT` (VLC) sent on every provider request — axios's default UA gets 403 from many panels).
- **`ratelimit.js`** — `getIp` (uses Fly's `Fly-Client-IP`; `X-Forwarded-For` is client-forgeable — verified) and `rateLimit(name, max, windowMs)`. Per IP per minute: provider checks (`/api/test`, `/api/categories`, `/api/m3u-groups`) 10, `/api/encrypt` + `/api/config` 30, `/stats` 5, addon routes 1500. Loopback is never limited (tests/local dev). Daily `history` rows also count `providerErrors` as `{ "<where> (<source>)": { "<status or kind>": n } }` (e.g. `"catalog (m3u)": {"503": 2}`) and `responseErrors` (our ≥400 responses incl. 429) as `{ "<METHOD route pattern>": { "<status>": n } }` — route patterns, never raw URLs (install links contain credentials).
- **`links.js`** — stable install links `s-<12 chars>`: id → encrypted settings (same AES as `e-` links) in `<STATS_DIR>/links.json` (+ `.bak` = previous version; an unreadable file is moved to `.corrupt-<ts>` and the backup loaded — never overwritten by an empty store). Atomic serialized writes, sync flush on SIGTERM. Cap 50k (then `/api/link` falls back to `e-`). Older links (`e-`/base64/plain) are edited in place too: new settings saved as an override keyed by SHA-256 of the link (link not stored); `parseConfigPath` applies it. **Losing links.json breaks every `s-` install** (back it up with the volume); edited old links just fall back to the settings inside them.
- **`public/configure.html`** — Configuration UI; category/group picker; Install calls `/api/link` (stable link). Works for Stremio and Nuvio (button says "Install", not "Install to Stremio"; result box says where to paste the link in either app; player tip: Stremio needs VLC, Nuvio uses its internal player and must be restarted after installing). A playlist link (`.m3u/.m3u8`, also a bare `http://name.m3u`) typed into the Xtream server field moves to the M3U tab; `/api/test` says "use the M3U tab" for it too. In edit mode the button reads **"Save changes"** (after the saved setup loaded) and a save that updates in place doesn't open the app. Opened from an installed addon's Configure (`/<link>/configure`) it sends `editing: <link>`: the link is updated in place ("Saved — StreamVault updated", nothing to reinstall) — `s-` links directly, older links via an override. Only a full store or an unreadable old link gives a new link. The save response carries `app` ("Nuvio"/"Stremio"/null) from an in-memory map (`linkApps`, capped 50k, never saved) learned from the User-Agent of that link's addon requests (not /api, not /play); the page says "Restart Nuvio" etc., or "Close and reopen your app" when unsure.
- **`tests/addon.test.js`** — Jest + Supertest tests. Upstream calls are mocked with `jest.spyOn(m3u|xtream, ...)`.

### Request flow

1. User opens `/configure`, fills in Xtream or M3U details, presses **Test Connection** (it also returns the category/group list — there is no separate "Load Categories" button), optionally picks categories/groups, presses **Install**.
2. The UI calls `POST /api/link`: settings are AES-256-GCM encrypted and saved under a stable `s-<id>` link (`links.js`); the page opens `stremio://…/manifest.json` (Stremio or Nuvio offers to install). `POST /api/encrypt` (self-contained `e-` link) still exists for older clients/tests.
3. The app installs `/:config/manifest.json`. The configured manifest lists the user's groups as catalog `genre` options (`getGenresWithin`, cached 6h, 8s timeout → no dropdown).
4. Stremio calls `/:config/catalog|meta|stream/:type/:id.json`.
5. Each handler decrypts `:config`, fetches from Xtream / the M3U URL (cached), returns Stremio JSON.

Other endpoints: `POST /api/test` (connection test + Xtream account info), `POST /api/categories` (Xtream), `POST /api/m3u-groups` (M3U group names + counts, no channels kept), `/play/...` (redirect so VLC shows the channel name), `/stats?key=` (all-time usage, `history` = 90 days of per-day counts incl. failures, `recentErrors` since restart, `memory`/`caches` telemetry), `/health`.

### Config encoding

Four formats for the `:config` segment (`parseConfigPath`): **stable** `s-<id>` (current — looked up in `links.js`, unknown id → 400 "no longer exists"; cache keys that depend on settings use `req.configKey` = `<id>@<revision>`), **encrypted** `e-<hex>` (current, keyed by `CONFIG_SECRET`), **base64url** JSON (legacy), **URL-encoded** (oldest). Short keys: `t` type, `s`/`u`/`p` Xtream server/user/pass, `m` M3U URL, `c` Xtream category ids (comma-joined), `g` M3U groups (JSON array string), `z` viewer timezone (IANA). Allowed keys are whitelisted in `ALLOWED_CONFIG_KEYS`; values are capped at 2048 chars (`g` over the cap is rejected, not truncated).

### Stremio details worth knowing

- Catalog extras are parsed from the **raw** path (`req.path`), not `req.params` (already decoded — breaks `&` in names).
- Search (`normalizeForSearch`) ignores case, accents, punctuation and Cyrillic vs Latin (`бнт` = `BNT`); every word must appear in the name.
- Stats never store IPs: unique users (`users`, `dailyActive`) are `userKey(ip)` = 16-hex HMAC keyed from `CONFIG_SECRET` (changing the secret resets the count; old plain-IP entries are converted on load).
- M3U ids: first entry keeps the bare `tvg-id`; duplicates get `_v2`, `_v3`. Ids are assigned before the group filter so they are stable across selections. Streams return the picked channel + up to 5 same-`tvg-id` variants.
- Stream `name` = left column in Stremio ("StreamVault\nTS"), `title` = right side.
- Bump `BASE_MANIFEST.version` when the manifest shape changes so clients refresh it.
- Manifest description: the empty install says "Not connected yet. Open Configure … Already have a connected StreamVault? Delete this one."; a configured one says "✓ Connected to your <Xtream account|M3U playlist>. If another StreamVault only shows “Set up StreamVault first”, delete that one." Apps keep the description from **install time**, so text that must reach old installs belongs in live responses (tiles), not the manifest.
- A saved `<tvg-id>_v2/_v3` id that no longer exists (the provider changed the number of copies) falls back to the base channel (`findM3UChannel`); `m3u_<name>_<pos>` ids fall back to the same name at the nearest position.
- Test Connection hints: "use http:// instead of https://" only when the entered address really starts with `https://`; an SSL error on an `http://` address gets a "secure-connection (SSL) problem" message.
- `HEAD /` redirects to `/configure` like `GET` (uptime monitors check `/` with HEAD). Film/series/anime requests to an empty install count as `foreignRequests`, not `unconfigured`. `X-Powered-By` is disabled.

### Memory (the server has crashed from OOM before — keep it bounded)

- Fly VM 1 GB, `--max-old-space-size=640`. Heap watchdog every 10s: >450 MB evicts half the M3U cache, >550 MB clears all caches.
- Caches: M3U playlists 10 min TTL, max 15 entries (key = URL + selected groups); Xtream catalogs 4h, max 25 (raw logos only — poster links built per response); genres 6h, max 500. A capped 10k-channel parse ≈ 5 MB heap.
- `withFailureCache()`: a provider that just failed is not retried for 2 min (requests fail fast with the same error/tile); `/stats` → `caches.failedProviders`. Repeats answered from this cache — and requests that waited for the same failed download (`once()`; same error object, tracked in a WeakSet) — are counted as `history.cachedFailures` only (not logged/counted as provider errors); a `[FAILCACHE]` log line summarizes them on the next real retry.
- `/stats` also lists (in memory, last 20, masked) `recentUnknownPaths` (our 404s, with User-Agent), `recentEmptyStreams` (with reason), `recentUnconfigured` (bare-manifest installs, with User-Agent) and `recentPlayRejects` (why `/play` refused). `history.foreignRequests` = items that aren't this install's channels, answered without touching the provider: non-`iptv_tv_` ids (IMDb, other addons' `iptv_…`) and, on Xtream installs, ids that can't be an Xtream stream id (an M3U install's `iptv_tv_name.cc`).
- Daily `history.reconfigures` = configure page opened from an installed addon (`/<link>/configure`); `history.reinstalls` = Install pressed in that mode (each one was a duplicate StreamVault before stable links). `/stats` → `caches.links` = saved stable links.
- Bare installs (no settings) get the "Set up StreamVault first" tile; its poster is `public/img/setup-qr.png`, a QR to `/setup` (short link → coarse, TV-scannable code) which counts `history.setupScans` and redirects to `/configure?from=tile` (page shows a TV/app banner). For phones (can't scan their own screen): the bare stream for `iptv_notice_setup` is an `externalUrl` to `/setup?via=play`, the meta has `links` → `/setup?via=link`, and the description starts with "On this phone: tap Play"; `?via=` counts `setupTaps` instead of `setupScans`. The setup meta also carries `background` = `public/img/setup-bg.png` (1920×1080, QR card at the far right — apps put title/text on the left, and phones crop to the middle (Nuvio ~x 585–1335), so the card starts at x 1412; without it they stretched the square tile behind the text). Both PNGs are rendered from SVG with `qrcode` + `@resvg/resvg-js` (not project deps); keep error correction H (logo in the middle), integer-px modules, and bump the `?v=` on `SETUP_QR_URL`/`SETUP_BG_URL` when a picture changes (`/public` is cached 7 days).
- `[/<config>]/subtitles/...` (Nuvio asks every addon) → `{subtitles:[]}`, counted as `foreignRequests`. `/robots.txt` allows only `/configure` + `/public/` (install links stay out of search engines).
- `/<40-hex>/<n>/stats.json` (a client treating us as Stremio's streaming server, ~1/s) → 404, counted as `history.streamingServerProbes`, not in `recentUnknownPaths` / `responseErrors`.
- Never `substring()` user/provider text before `encodeURIComponent` — it can split an emoji and throw "URI malformed"; slice by code points + `toWellFormed()`.
- `withDownloadSlot()`: at most 4 big provider downloads (whole M3U playlists, full Xtream channel lists) run at once across all users; the rest queue. `/stats` → `caches.downloadsRunning` / `downloadsWaiting` (now) and per-day `history` → `downloads`, `downloadsQueued` (had to wait), `longestDownloadWaitMs`. Never call it from inside another slot (deadlock).
- `once(key, load)` dedupes concurrent cache misses so one playlist is downloaded once, not per request.
- M3U parse stops at 10k live channels; Xtream responses capped at 50 MB.
- Don't add per-user downloads of large files (e.g. XMLTV EPG) without strict size/concurrency limits.
- Check `/stats` → `memory` (peak, evictions) before changing cache sizes.

### Code rules (SonarQube — keep the scan clean)

The codebase was cleaned of all Sonar findings; new code must not bring them back:
- Built-in modules with the `node:` prefix (`require("node:fs")`, `node:path`, `node:crypto`, …).
- No regex that can backtrack on user/provider input (e.g. `/\/+$/` is quadratic on a run of slashes) — use a loop (`trimTrailingSlashes` in `urlguard.js`).
- Functions stay ≤ 15 cognitive complexity: route handlers dispatch to small helpers (see `parseConfigPath`, `/api/test` → `testXtream`/`testM3u`/`answerTestFailure`, `m3u.js` `addLine`, `configure.html` `install()`).
- No nested ternaries — a small function with early `return`s instead.
- No empty or comment-only `catch`: return/log something **and** say why the error is ignored. Don't reassign a function parameter in a catch; return the fallback.
- `x?.y` instead of `x && x.y` — but not where `""`/`0` must stay falsy differently (account status compares `status !== "" && status !== "active"`).
- `re.exec(str)` instead of `str.match(re)` for single matches; `replaceAll` for global literal replaces; `Number.parseInt(x, 10)`; sort strings with `localeCompare`; `a >= b` instead of `!(a < b)` (check NaN explicitly).
- Promises: `async`/`await` instead of nested `.then` chains; a fire-and-forget call is written `void fn()` and only for functions that never reject (e.g. `links.js` `save()`).
- No SHA-1 (use SHA-256), no `X-Powered-By`.
- `configure.html`: every `<label>` has `for=`, inputs without a visible label get `aria-label`, no `!important`, no `user-scalable=no`.
- Tests: in-process tests use a temp `STATS_DIR` (set at the top of `addon.test.js`); a `parseM3U` mock must honour its `groups` argument like the real parser; spawned Node processes run with `FORCE_COLOR=0` (IDE runners colour `console.log` output).

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP listen port | `7000` |
| `CONFIG_SECRET` | AES-256-GCM key for config encryption — **required on Fly / production** (app exits without it) | `dev-secret` (local only) |
| `STATS_SECRET` | Password to access `/stats` | _(none, endpoint open)_ |

### Deployment

- Fly.io (`fly.toml`): 1 shared CPU, 1 GB RAM, AMS region, persistent `/data` volume (`vol_4qloqe1knpzep0nr`) for `stats.json` and `links.json`(+`.bak`). Daily volume snapshots kept **30 days** (`fly volumes snapshots list vol_4qloqe1knpzep0nr`); restoring = new volume from a snapshot, then attach it.
- If GitHub Actions is down: `fly deploy --remote-only` from the repo (deploys the local folder — commit first). GitHub's `FLY_API_TOKEN` is an app-scoped **deploy** token (`fly tokens list`).
- GitHub Actions (`.github/workflows/fly-deploy.yml`): tests (Node 24) then deploys on every push to `master` — **pushing is deploying**, no manual `fly deploy` needed.
- **Never `git push` unless the owner explicitly says to push in that request.** Commit locally, report what changed, and wait. An earlier "push it" covers only that change.
- Docker: `node:24-alpine`, `npm ci --omit=dev`.
