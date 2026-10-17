# StreamVault IPTV

**Stream live TV via Xtream Codes or M3U playlist.**

A Stremio addon that brings all your live IPTV channels into one place. Connect your existing IPTV subscription and watch live TV directly inside Stremio.

![Stremio](https://img.shields.io/badge/Stremio-Addon-blue?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

---

## What You Can Do

- **Watch Live TV** — all your live channels right inside Stremio
- **Browse by Category** — your provider's own categories / playlist groups appear in Stremio's genre dropdown
- **Pick Only What You Want** — choose categories (Xtream) or playlist groups (M3U) at setup to keep your library clean
- **TV Guide (EPG)** — see what's playing now and next on Xtream channels, shown in your local time
- **Search** — find any live channel by name directly in Stremio
- **Quality Options** — HD / FHD / UHD versions of the same channel are offered together; Xtream channels come as both TS (best for VLC) and HLS
- **Test Your Connection** — verify your credentials before installing; Xtream shows account status, expiry date and connections
- **Works with Picky Providers** — custom User-Agent / Referer from your playlist (`#EXTVLCOPT`, `#EXTHTTP`, `url|User-Agent=…`) is passed to the player
- **Handles Large Playlists** — playlists are streamed and parsed, so even huge M3U files load without errors
- **Private by Design** — your credentials are encrypted inside your install link
- **Works Everywhere** — PC, Android, iOS, and TV — same addon, all devices

---

## How to Install

1. Open the StreamVault configure page
2. Choose your source: **Xtream Codes** or **M3U Playlist**
3. Enter your IPTV credentials or playlist URL
4. Optionally test your connection and click **Load Categories** to pick only the categories / groups you want
5. Click **Install to Stremio** — done!

Your channels will appear in Stremio's catalog. Browse by category, search, and play. Search ignores accents and works in Latin or Cyrillic (`bnt` finds `БНТ`).

> ⚠️ **VLC external player is required for live TV.** Live streams don't play in Stremio's built-in player.

> 💡 Already installed an older version? Reinstall from the configure page to get local TV-guide times and group selection.

---

## Supported Sources

| Source | Live TV | Category filter | Pick at setup | TV Guide |
|--------|:---:|:---:|:---:|:---:|
| **Xtream Codes** | ✅ | ✅ | ✅ categories | ✅ |
| **M3U Playlist** | ✅ | ✅ | ✅ groups | — |

---

## License

[MIT](LICENSE)
