# StreamVault IPTV

**Your live TV from Xtream Codes or an M3U playlist, inside Stremio and Nuvio.**

StreamVault is a free addon that brings the live channels of your own IPTV subscription or playlist into
[Stremio](https://www.stremio.com) and Nuvio. Set it up once on the configure page,
then browse, search and play your channels like any other content.

![Stremio](https://img.shields.io/badge/Stremio-Addon-blue?style=flat-square)
![Nuvio](https://img.shields.io/badge/Nuvio-Addon-purple?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)

> StreamVault provides **no channels or content**. Use it only with playlists and subscriptions you have the
> right to watch.

---

## What you can do

- **Watch live TV** — all your live channels inside Stremio or Nuvio
- **Your categories, your order** — pick the categories (Xtream) or playlist groups (M3U) you want; they show in
  the order you picked them, and with 2 or more picked each gets its own home-screen row (up to 8)
- **Search** — by channel name; ignores accents and works in Latin or Cyrillic (`bnt` finds `БНТ`)
- **One tile per channel** — "BTV", "BTV HD" and "BTV UHD" are one tile; its play list offers every version,
  best quality first
- **TV guide** — what's on now and next for Xtream channels, in your own time zone
- **Change settings anytime** — open Configure in your app, change categories, press **Save changes**: same link,
  nothing to reinstall
- **Know what's wrong** — instead of an empty screen you get a tile that explains it: provider down, login
  refused, subscription expired or ending soon, `https://` that should be `http://`
- **Test before installing** — Test Connection checks your login or playlist and shows the account's status and
  expiry date
- **Works with picky providers** — a custom User-Agent / Referer from your playlist (`#EXTVLCOPT`, `#EXTHTTP`,
  `url|User-Agent=…`) is passed to the player
- **Handles huge playlists** — playlists are read as a stream, so very large M3U files load fine
- **Every device** — PC, Android, iPhone, Android TV, and Samsung TVs through Nuvio

---

## How to install

1. Open the StreamVault configure page
2. Choose **Xtream Codes** or **M3U Playlist** and enter your login or playlist link
3. Press **Test Connection** — your categories / groups appear; pick the ones you want (none = all)
4. Press **Install** — your app opens and adds StreamVault

Didn't open? Copy the link from the result and add it by hand: **Stremio** → Addons → Install from URL, or
**Nuvio** → Add addon.

### Good to know

- **Live TV only** — films and series aren't supported.
- **Stremio needs VLC for live TV:** Settings → Advanced/Playback → Default Player → External → VLC.
  Nuvio plays live TV in its own player.
- **Nuvio:** fully close and reopen the app after installing or saving changes to see your channels.
- **Xtream channels come as TS and HLS / m3u8** — if one doesn't play, try the other. Accounts that allow only one
  format see only that one.
- **Watching on a TV?** Install on your phone or PC while logged in to the same Stremio account, then on the TV:
  Addons → Sync addons. On Samsung (Tizen) TVs, Nuvio is the only way to use StreamVault.
- **Got a tile saying "Set up StreamVault first"?** That StreamVault was added without settings. Tap Play on it (or
  scan its code), set it up, and delete the empty one.

---

## Supported sources

| Source | Live TV | Pick categories | TV guide | Formats |
|--------|:---:|:---:|:---:|---|
| **Xtream Codes** | ✅ | ✅ categories | ✅ | TS + HLS (what the account allows) |
| **M3U playlist** | ✅ | ✅ groups | — | as in the playlist |

---

## Something not working?

[Report it on GitHub](https://github.com/BlagovestKirilov/StreamVault/issues/new/choose). **Never post your
install link, server address, login or playlist link** — issues are public, and those contain your password.

If channels don't load at all, check with your provider first: StreamVault only shows what your provider sends.

## Privacy

Your settings are saved **encrypted**, your IP address is never stored (only a one-way code for counting
users), and the video goes straight from your provider to your player. Full details:
[PRIVACY.md](PRIVACY.md).

## Support

StreamVault is free and open source. If it's useful to you, you can support the hosting on
[Ko-fi](https://ko-fi.com/streamvaultaddon).

---

## License

[MIT](LICENSE)
