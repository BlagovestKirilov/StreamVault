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

StreamVault is a Stremio addon (Express.js HTTP server) that proxies IPTV streams from Xtream Codes API servers or M3U playlists into the Stremio protocol.

### Core files

- **`addon.js`** — The entire application: Express routes, config parsing, caching, encryption, SSRF protection, analytics, and all Stremio protocol handlers.
- **`xtream.js`** — Thin wrapper around the Xtream Codes HTTP API (categories, streams, EPG).
- **`m3u.js`** — M3U/M3U8 playlist parser that groups channels by category and detects content type (live TV, VOD, series).
- **`public/configure.html`** — Single-page configuration UI served to users before installation; generates an encrypted install URL.
- **`tests/addon.test.js`** — Jest + Supertest integration tests covering all routes, config formats, encryption, and SSRF protection.

### Request flow

1. User opens `/configure`, fills in Xtream or M3U credentials, and clicks Install.
2. The UI calls `POST /api/encrypt` to encode the config as AES-256-GCM ciphertext, producing a `/:config` URL segment.
3. Stremio installs the addon at `/:config/manifest.json`.
4. Stremio calls `/:config/catalog/:type/:id.json`, `/:config/meta/:type/:id.json`, and `/:config/stream/:type/:id.json`.
5. Each handler decrypts `:config`, fetches data from the upstream Xtream API or M3U URL (with caching), and returns Stremio-format JSON.

### Config encoding

Three formats are supported for the `:config` URL segment (parsed in `addon.js` around line 270):
- **Encrypted** (current): AES-256-GCM base64url, keyed by `CONFIG_SECRET` env var.
- **Base64url** (legacy): plain JSON encoded as base64url.
- **URL-encoded** (oldest legacy): `key=value&key=value` query-string style.

### Caching

In-memory caches inside `addon.js`:
- M3U playlist data: 10-minute TTL
- Xtream API data: 4-hour TTL
- Cache eviction runs on a 30-minute interval

### SSRF protection

All outbound HTTP requests (Xtream API calls and M3U fetches) go through `isSafeUrl()` in `addon.js`, which blocks private IP ranges, localhost, `.local`/`.internal` domains, and cloud metadata endpoints (169.254.169.254). This is tested extensively in the test suite.

### Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP listen port | `7000` |
| `CONFIG_SECRET` | AES-256-GCM key for config encryption | `dev-secret` |
| `STATS_SECRET` | Password to access `/stats` dashboard | _(none, endpoint open)_ |

### Deployment

- Fly.io (`fly.toml`): 1 shared CPU, 1 GB RAM, AMS region, persistent `/data` volume for `stats.json`.
- GitHub Actions (`.github/workflows/fly-deploy.yml`): runs tests then deploys on every push to `master`.
- Docker: `node:18-alpine`, `npm ci --production`.
