# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- **`public/configure.html`** — Configuration UI; category/group picker; Install calls `/api/link` (stable link). Opened from an installed addon's Configure (`/<link>/configure`) it sends `editing: <link>`: the link is updated in place ("Saved — StreamVault updated", nothing to reinstall) — `s-` links directly, older links via an override. Only a full store or an unreadable old link gives a new link.
- **`tests/addon.test.js`** — Jest + Supertest tests. Upstream calls are mocked with `jest.spyOn(m3u|xtream, ...)`.

### Request flow

1. User opens `/configure`, fills in Xtream or M3U details, optionally loads + picks categories/groups, clicks Install.
2. The UI calls `POST /api/encrypt` to encode the config as AES-256-GCM ciphertext, producing a `/:config` URL segment.
3. Stremio installs `/:config/manifest.json`. The configured manifest lists the user's groups as catalog `genre` options (`getGenresWithin`, cached 6h, 8s timeout → no dropdown).
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

### Memory (the server has crashed from OOM before — keep it bounded)

- Fly VM 1 GB, `--max-old-space-size=640`. Heap watchdog every 10s: >450 MB evicts half the M3U cache, >550 MB clears all caches.
- Caches: M3U playlists 10 min TTL, max 15 entries (key = URL + selected groups); Xtream catalogs 4h, max 25 (raw logos only — poster links built per response); genres 6h, max 500. A capped 10k-channel parse ≈ 5 MB heap.
- `withFailureCache()`: a provider that just failed is not retried for 2 min (requests fail fast with the same error/tile); `/stats` → `caches.failedProviders`. Repeats answered from this cache are counted as `history.cachedFailures` only (not logged/counted as provider errors); a `[FAILCACHE]` log line summarizes them on the next real retry.
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

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP listen port | `7000` |
| `CONFIG_SECRET` | AES-256-GCM key for config encryption — **required on Fly / production** (app exits without it) | `dev-secret` (local only) |
| `STATS_SECRET` | Password to access `/stats` | _(none, endpoint open)_ |

### Deployment

- Fly.io (`fly.toml`): 1 shared CPU, 1 GB RAM, AMS region, persistent `/data` volume for `stats.json`.
- GitHub Actions (`.github/workflows/fly-deploy.yml`): tests (Node 24) then deploys on every push to `master` — **pushing is deploying**, no manual `fly deploy` needed.
- **Never `git push` unless the owner explicitly says to push in that request.** Commit locally, report what changed, and wait. An earlier "push it" covers only that change.
- Docker: `node:24-alpine`, `npm ci --omit=dev`.
