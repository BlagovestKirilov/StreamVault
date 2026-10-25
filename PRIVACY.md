# Privacy

What StreamVault stores, why, and for how long. Last updated: 25 October 2026.

StreamVault is a free, open-source addon run by [BlagovestKirilov](https://github.com/BlagovestKirilov) on a
server at [Fly.io](https://fly.io) in Amsterdam (EU). It doesn't sell or share anything, shows no ads and
uses no tracking or analytics services.

## Your settings

When you press **Install**, StreamVault saves your settings so your install link stays short and can be
updated later with **Save changes**:

- source type, server address, username and password (Xtream) or playlist link (M3U)
- the categories you picked and your time zone

They are **encrypted** (AES-256-GCM) before they're saved, and stored under a random id — that id is your
install link (`…/s-xxxxxxxxxxxx/manifest.json`). Older install links carry the same encrypted settings inside
the link itself instead.

**Treat your install link like a password.** Anyone who has it can use your setup and open it on the
configure page, which shows your settings so you can edit them.

Saved settings are kept as long as the service runs (there's no expiry, because apps keep using the link).
Server backups are kept for 30 days.

## Usage statistics

To keep the service running well, StreamVault counts things like installs, app launches, channels opened,
searches and errors — as numbers per day.

To count *unique* users, your IP address is turned into a one-way code with a secret key. **The IP address
itself is never saved**, and the code can't be turned back into it. These codes are kept for up to 30 days
(per-day lists), and the newest 10,000 are kept to tell new installs from returning ones. Daily totals are
kept for 90 days.

Clicks on the configure page's Ko-fi links are counted the same way — just a number per day and in
total, nothing about who clicked.

## Server logs

The server logs events such as "new install", "configure page opened" or "provider returned an error",
with a **shortened IP address** (the last part hidden, e.g. `203.0.113.x`). Logs never contain install
links, passwords or playlist links. Fly.io keeps logs for a limited time.

## Temporary data

To answer quickly, the server keeps copies in memory of what your provider returns — channel lists, account
details (such as the expiry date) and the TV guide — for minutes to hours. It also keeps the last few
errors, with install links hidden. All of this disappears when the server restarts.

## Who else is involved

- **Your IPTV provider:** StreamVault's server asks it for your channel list, account details and TV guide.
  The **video goes directly** from your provider to your player — it never passes through StreamVault.
- **Fly.io** hosts the server and its data.
- **Channel pictures** are loaded by your app from [wsrv.nl](https://wsrv.nl) (fits channel logos into
  squares) and [ui-avatars.com](https://ui-avatars.com) (pictures with the channel name). They receive the
  logo link or channel name, and — like any website — your IP address.
- **Stremio / Nuvio** are separate apps with their own privacy policies.

The configure page uses no cookies. It remembers only your light/dark choice, in your browser.

## Tips through Ko-fi

Tips are optional and go through [Ko-fi](https://ko-fi.com/streamvaultaddon) and PayPal, under their own
privacy policies — StreamVault itself never sees your payment details.

If you tip, I receive your **name, email address, message and the amount** from Ko-fi / PayPal. They're used
only to thank you or reply to you, never shared, and deleted when you ask. A tip and its message can appear on
the Ko-fi page with your name, unless you choose **Private** when tipping.

## Your choices

- Don't want your settings stored? Delete StreamVault from your app and stop using the link.
- Want saved settings or your tip details deleted, or have a question? Open an
  [issue on GitHub](https://github.com/BlagovestKirilov/StreamVault/issues/new/choose) — **without** your
  install link or login. You'll get a private way to send what's needed.

## Content

StreamVault provides no channels or content. Use it only with playlists and subscriptions you have the
right to watch.
