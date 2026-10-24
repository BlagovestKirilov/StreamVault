/**
 * notices.js — The tiles StreamVault shows instead of channels when something
 * needs the user's attention: provider errors, account problems / expiry, a
 * category that's gone, and "Set up StreamVault first".
 */

const { providerErrorKey } = require("./stats");
const { makePosterUrl } = require("./catalog");

// --- Error tiles: tell the user why their catalog is empty ---
const NOTICES = {
  category_gone: {
    name: "No channels in this category",
    description: "Either this category isn't in your StreamVault setup any more and your app is still showing an older category list, or your provider has no channels in it right now. Close and reopen the app to refresh the list, or check your categories in Configure on StreamVault.",
  },
  provider_down: {
    name: "Provider not responding",
    description: "Your IPTV provider's server returned an error or didn't respond. This is usually temporary — try again in a few minutes.",
  },
  provider_refused: {
    name: "Provider refused access",
    description: "Your IPTV provider refused the connection. Check that your subscription is active and your login is correct. Some providers also block servers like StreamVault's — if it keeps happening, contact your provider.",
  },
  not_found: {
    name: "Playlist not found",
    description: "Your provider says this playlist or server address doesn't exist. Open Stremio's Addons page, click Configure on StreamVault and check the address.",
  },
  bad_address: {
    name: "Address doesn't work",
    description: "The server or playlist address in your setup can't be reached. Open Stremio's Addons page, click Configure on StreamVault and check the address.",
  },
  https_mismatch: {
    name: "Use http:// not https://",
    description: "Your server address starts with https://, but your provider's server only works with http:// on that port. Open Stremio's Addons page, click Configure on StreamVault and change the address to start with http://.",
  },
  provider_limited: {
    name: "Provider is limiting requests",
    description: "Your IPTV provider is temporarily refusing requests because too many were made. Try again in a few minutes.",
  },
  account: {
    name: "Account problem",
    description: "", // filled with the specific reason (expired, wrong login, ...)
  },
  setup: {
    name: "Set up StreamVault first",
    // First line is what shows before "Show more", so it's the action
    description: "On this phone: tap Play to set up. On a TV: scan the code with your phone, or open https://streamvault.fly.dev/setup. Then Sync addons (Stremio) or add the new link (other apps), and delete this empty StreamVault.",
  },
  unknown: {
    name: "Couldn't load channels",
    description: "Something went wrong loading your channels. Try again later, or click Configure on StreamVault in Stremio's Addons page to check your details.",
  },
};

function classifyError(e) {
  const key = providerErrorKey(e);
  const status = Number(key);
  // 451: the provider blocks servers in some countries / data centres
  if (status === 401 || status === 403 || status === 451) return "provider_refused";
  if (status === 404) return "not_found";
  if (status === 429) return "provider_limited";
  if (status >= 500) return "provider_down";
  if (key === "https_mismatch") return "https_mismatch";
  if (key === "bad_address") return "bad_address";
  if (key === "timeout") return "provider_down";
  return "unknown";
}

const SETUP_URL = "https://streamvault.fly.dev/setup";
// Play on the setup tile opens the setup page in the browser — on a phone the QR
// can't be scanned, so this is the way through
const SETUP_PLAY_STREAM = { name: "StreamVault", title: "Open setup page", externalUrl: `${SETUP_URL}?via=play` };
// ?v= changes when the picture does (/public is cached for 7 days)
const SETUP_QR_URL = "https://streamvault.fly.dev/public/img/setup-qr.png?v=2";
// Wide detail-page background: QR on the right, left kept dark for the app's
// title/description overlay (without it apps stretch the square tile behind
// the text, half-covering the code)
const SETUP_BG_URL = "https://streamvault.fly.dev/public/img/setup-bg.png?v=3";

function noticeMeta(kind, type, detail) {
  const notice = NOTICES[kind] || NOTICES.unknown;
  const name = kind === "account" && detail ? detail : notice.name;
  const description = kind === "account"
    ? `${detail || "There is a problem with your IPTV account"}. Renew or check your subscription with your provider, then reopen Stremio.`
    : notice.description;
  return {
    id: `iptv_notice_${kind}`,
    type: type || "tv",
    name: `⚠️ ${name}`,
    // The setup tile's picture is a QR code to /setup, so a TV user can finish
    // setting up on their phone
    poster: kind === "setup" ? SETUP_QR_URL : makePosterUrl(name),
    posterShape: "square",
    description,
    ...(kind === "setup" && {
      background: SETUP_BG_URL,
      // A tappable button on the detail page in apps that show meta links
      links: [{ name: "Set up StreamVault", category: "Setup", url: `${SETUP_URL}?via=link` }],
    }),
  };
}

// First tile of the catalog when the account can't be used (expired/disabled
// while the panel still lists channels) or ends within EXPIRY_WARN_DAYS
const EXPIRY_WARN_DAYS = 7;
const ACCOUNT_WAIT_MS = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
function accountNotice(info, type) {
  const problem = accountProblem(info);
  if (problem) return noticeMeta("account", type, problem);
  const exp = Number(info?.exp_date) * 1000;
  const left = exp - Date.now();
  if (!(left > 0 && left <= EXPIRY_WARN_DAYS * DAY_MS)) return null;
  const when = left < DAY_MS ? "in less than a day" : `in ${Math.ceil(left / DAY_MS)} days`;
  const date = new Date(exp).toISOString().slice(0, 10);
  return {
    id: "iptv_notice_expiring",
    type: type || "tv",
    name: `⚠️ Subscription ends ${when}`,
    poster: makePosterUrl(`Subscription ends ${when}`),
    posterShape: "square",
    description: `Your IPTV subscription ends on ${date} (UTC). Renew it with your provider to keep watching. `
      + "After renewing, this notice disappears within 30 minutes.",
  };
}

// Why an Xtream account can't be used, or null when it looks fine / is unknown
// (providers that don't report user_info are never blocked)
function accountProblem(info) {
  if (!info || typeof info !== "object") return null;
  if (String(info.auth) === "0") return "Wrong username or password";
  const status = String(info.status || "").trim().toLowerCase();
  if (status !== "" && status !== "active") return `Your account is ${status.slice(0, 20)}`;
  const exp = Number(info.exp_date);
  if (exp > 0 && exp * 1000 < Date.now()) {
    return `Your account expired on ${new Date(exp * 1000).toISOString().slice(0, 10)}`;
  }
  return null;
}

module.exports = {
  NOTICES, classifyError, SETUP_PLAY_STREAM, noticeMeta, ACCOUNT_WAIT_MS, accountNotice,
  accountProblem,
};
