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
- **`urlguard.js`** — SSRF protection (`validateExternalUrl`, `assertExternalUrl`, `blockPrivateRedirects`).
- **`ratelimit.js`** — `getIp` (uses Fly's `Fly-Client-IP`; `X-Forwarded-For` is client-forgeable — verified) and `rateLimit(name, max, windowMs)`. Per IP per minute: provider checks (`/api/test`, `/api/categories`, `/api/m3u-groups`) 10, `/api/encrypt` + `/api/config` 30, `/stats` 5, addon routes 300. Loopback is never limited (tests/local dev). Daily `history` rows also count `providerErrors` as `{ "<where> (<source>)": { "<status or kind>": n } }` (e.g. `"catalog (m3u)": {"503": 2}`) and `responseErrors` (our ≥400 responses incl. 429) as `{ "<METHOD route pattern>": { "<status>": n } }` — route patterns, never raw URLs (install links contain credentials).
- **`public/configure.html`** — Configuration UI; category/group picker; generates an encrypted install URL.
- **`tests/addon.test.js`** — Jest + Supertest tests. Upstream calls are mocked with `jest.spyOn(m3u|xtream, ...)`.

### Request flow

1. User opens `/configure`, fills in Xtream or M3U details, optionally loads + picks categories/groups, clicks Install.
2. The UI calls `POST /api/encrypt` to encode the config as AES-256-GCM ciphertext, producing a `/:config` URL segment.
3. Stremio installs `/:config/manifest.json`. The configured manifest lists the user's groups as catalog `genre` options (`getGenresWithin`, cached 6h, 8s timeout → no dropdown).
4. Stremio calls `/:config/catalog|meta|stream/:type/:id.json`.
5. Each handler decrypts `:config`, fetches from Xtream / the M3U URL (cached), returns Stremio JSON.

Other endpoints: `POST /api/test` (connection test + Xtream account info), `POST /api/categories` (Xtream), `POST /api/m3u-groups` (M3U group names + counts, no channels kept), `/play/...` (redirect so VLC shows the channel name), `/stats?key=` (all-time usage, `history` = 90 days of per-day counts incl. failures, `recentErrors` since restart, `memory`/`caches` telemetry), `/health`.

### Config encoding

Three formats for the `:config` segment (`parseConfigPath`): **encrypted** `e-<hex>` (current, keyed by `CONFIG_SECRET`), **base64url** JSON (legacy), **URL-encoded** (oldest). Short keys: `t` type, `s`/`u`/`p` Xtream server/user/pass, `m` M3U URL, `c` Xtream category ids (comma-joined), `g` M3U groups (JSON array string), `z` viewer timezone (IANA). Allowed keys are whitelisted in `ALLOWED_CONFIG_KEYS`; values are capped at 2048 chars (`g` over the cap is rejected, not truncated).

### Stremio details worth knowing

- Catalog extras are parsed from the **raw** path (`req.path`), not `req.params` (already decoded — breaks `&` in names).
- M3U ids: first entry keeps the bare `tvg-id`; duplicates get `_v2`, `_v3`. Ids are assigned before the group filter so they are stable across selections. Streams return the picked channel + up to 5 same-`tvg-id` variants.
- Stream `name` = left column in Stremio ("StreamVault\nTS"), `title` = right side.
- Bump `BASE_MANIFEST.version` when the manifest shape changes so clients refresh it.

### Memory (the server has crashed from OOM before — keep it bounded)

- Fly VM 1 GB, `--max-old-space-size=640`. Heap watchdog every 10s: >450 MB evicts half the M3U cache, >550 MB clears all caches.
- Caches: M3U playlists 10 min TTL, max 3 entries (key = URL + selected groups); Xtream catalogs 4h, max 25; genres 6h, max 500. A capped 10k-channel parse ≈ 5 MB heap.
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
- Docker: `node:24-alpine`, `npm ci --omit=dev`.
