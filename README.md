# StreamVault IPTV

**Your personal streaming vault. All channels, one place.**

A Stremio addon that connects your IPTV service directly to Stremio — supporting both **Xtream Codes** and **M3U playlist** sources.

![Stremio](https://img.shields.io/badge/Stremio-Addon-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)
![Node](https://img.shields.io/badge/Node.js-18%2B-brightgreen?style=flat-square)

---

## Features

- **Xtream Codes** — connect with server URL, username & password
- **M3U Playlists** — paste any M3U/M3U8 playlist URL
- **Live TV** — all your live channels in Stremio
- **VOD** — movies from your IPTV provider
- **Series** — TV series with episodes
- **Search** — find channels by name directly in Stremio
- **Multi-device** — works on PC, Android, iOS, TV (same network)
- **Auto-fallback streams** — HLS, TS, MP4, MKV formats for reliability
- **Zero config files** — everything configured inside Stremio's UI

---

## How It Works

1. Install the addon in Stremio
2. Choose your source type (Xtream Codes or M3U)
3. Enter your credentials or playlist URL
4. All your channels appear in Stremio — browse, search, and play

---

## Supported Content

| Type | Xtream Codes | M3U |
|------|:---:|:---:|
| Live TV | ✅ | ✅ |
| Movies (VOD) | ✅ | ✅ |
| Series | ✅ | ✅ |

---

## Tech Stack

- **Node.js** + **Express**
- **Stremio Addon SDK** protocol
- **Axios** for HTTP requests
- Stateless — no database needed

---

## License

[MIT](LICENSE)
