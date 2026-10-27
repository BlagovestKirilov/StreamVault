/**
 * xtream-addon.js — Xtream Codes installs: channel list (cached, stale-while-refresh),
 * account info, TV guide (Now/Next), channel page and the TS/HLS streams.
 */

const xtream = require("./xtream");
const { trimTrailingSlashes } = require("./urlguard");
const { withinMs, safeError } = require("./util");
const { ACCOUNT_WAIT_MS } = require("./notices");
const {
  m3uCache, xtreamCache, XTREAM_CACHE_TTL, XTREAM_CACHE_MAX, ACCOUNT_CACHE_TTL, ACCOUNT_RETRY_MS,
  XTREAM_STALE_MS, ACCOUNT_STALE_MS, EPG_CACHE_TTL, EPG_CACHE_MAX, epgCache, accountCache,
  setCapped, touch, once, withDownloadSlot, failCache, withFailureCache, usableEntry, m3uCacheKey,
} = require("./cache");
const {
  makePosterUrl, channelPoster, cleanName, catalogView, channelTitle, sortChannels,
} = require("./catalog");

// --- Xtream Codes handlers ---

function xtreamCacheKey(config, type, categoryIds) {
  return `${config.server}_${config.username}_${type}_${categoryIds.join(",")}`;
}

function xtreamCategoryIds(config) {
  return (config.country || "").split(",").filter(Boolean);
}

async function getXtreamCatalog(config, type) {
  // Only live TV channels are supported
  if (type !== "tv") return [];

  const categoryIds = xtreamCategoryIds(config);
  const cacheKey = xtreamCacheKey(config, type, categoryIds);
  const load = () => once(`xtream:${cacheKey}`, () =>
    withFailureCache(`xtream:${cacheKey}`, () => loadXtreamCatalog(config, type, categoryIds, cacheKey)));
  const cached = usableEntry(touch(xtreamCache, cacheKey), XTREAM_CACHE_TTL, XTREAM_STALE_MS, load);
  return cached ? cached.data : load();
}

async function loadXtreamCatalog(config, type, categoryIds, cacheKey) {
  // Category names (for the genre filter) are fetched alongside; failure just means no genres
  const categoriesPromise = xtream.getLiveCategories(config).catch(() => []);
  // One download slot per catalog load (a user's selected categories together)
  let items = await withDownloadSlot(async () => {
    if (categoryIds.length === 0) return xtream.getLiveStreams(config);
    const results = await Promise.all(categoryIds.map(catId => xtream.getLiveStreams(config, catId)));
    return results.filter(Array.isArray).flat();
  });
  const categories = await categoriesPromise;

  // Guard: API may return an object/error instead of an array
  if (!Array.isArray(items)) items = [];

  const categoryNames = new Map(
    (Array.isArray(categories) ? categories : []).map(c => [String(c.category_id), c.category_name])
  );

  const result = items.map((item) => {
    const name = item.name || item.title || "Unknown";
    const logo = item.stream_icon || item.cover || "";
    const category = categoryNames.get(String(item.category_id));
    // Cached as the raw logo; the (much longer) poster link is built only for the
    // channels actually sent — see catalogMeta() — so the cache stays small
    const meta = {
      id: `iptv_${type}_${item.stream_id}`,
      type: type,
      name: name,
      logo,
    };
    if (category) meta.genres = [category];
    // Catch-up: the provider keeps this channel's past programmes for N days
    const archiveDays = Number(item.tv_archive_duration);
    if (Number(item.tv_archive) === 1 && archiveDays > 0) meta.archiveDays = Math.min(archiveDays, 30);
    return meta;
  });
  sortChannels(result, categoryIds.map(id => categoryNames.get(id)).filter(Boolean));

  setCapped(xtreamCache, cacheKey, { data: result, ts: Date.now() }, XTREAM_CACHE_MAX);
  return result;
}

// "HH:MM - HH:MM" in the viewer's timezone (captured by the configure page).
// Older installs have no timezone → fall back to the provider's local strings.
function epgTimeRange(e, timezone) {
  const startTs = Number(e.start_timestamp);
  const endTs = Number(e.stop_timestamp || e.end_timestamp);
  if (!timezone || !startTs || !endTs) return providerTimeRange(e);
  try {
    const fmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timezone });
    return `${fmt.format(startTs * 1000)} - ${fmt.format(endTs * 1000)}`;
  } catch (_) {
    return providerTimeRange(e); // invalid timezone: use the provider's own times
  }
}

// "HH:MM - HH:MM" as the provider wrote it (its local time)
function providerTimeRange(e) {
  const start = e.start || "";
  const end = e.end || "";
  return start && end ? `${start.slice(11, 16)} - ${end.slice(11, 16)}` : "";
}

// Account info (expiry) for channel pages and the expiry notice — tiny request
async function getXtreamAccount(config) {
  const key = `${config.server}_${config.username}`;
  const entry = touch(accountCache, key);
  const load = () => once(`account:${key}`, async () => {
    const info = await xtream.getAccountInfo(config).catch(() => null);
    setCapped(accountCache, key, { data: info, ts: Date.now() }, XTREAM_CACHE_MAX);
    return info;
  });
  const ttl = entry?.data ? ACCOUNT_CACHE_TTL : ACCOUNT_RETRY_MS;
  const cached = usableEntry(entry, ttl, ACCOUNT_STALE_MS, load);
  return cached ? cached.data : load();
}

// "Save changes" on the configure page: forget this setup's cached channel list
// (and Xtream account, and a remembered provider failure) so the next request
// downloads them fresh — new channels show at once instead of after the TTL.
// At most once per FORCED_REFRESH_MS per setup: each reload is a full download.
const FORCED_REFRESH_MS = 2 * 60 * 1000;
const forcedRefreshes = new Map(); // cache key -> last forced refresh (ms)
function forceRefresh(config) {
  const key = config.type === "xtream"
    ? xtreamCacheKey(config, "tv", xtreamCategoryIds(config))
    : m3uCacheKey(config);
  const last = forcedRefreshes.get(key);
  if (!key || (last && Date.now() - last < FORCED_REFRESH_MS)) return false;
  setCapped(forcedRefreshes, key, Date.now(), 1000);
  if (config.type === "xtream") {
    xtreamCache.delete(key);
    failCache.delete(`xtream:${key}`);
    accountCache.delete(`${config.server}_${config.username}`);
  } else {
    m3uCache.delete(key);
    failCache.delete(`m3u:${key}`);
  }
  return true;
}

// TV guide listings for one channel (see EPG_CACHE_TTL); failures aren't kept
async function getCachedEPG(config, streamId) {
  const key = `${trimTrailingSlashes(config.server)}_${streamId}`;
  const cached = touch(epgCache, key);
  if (cached && Date.now() - cached.ts < EPG_CACHE_TTL) return cached.data;
  return once(`epg:${key}`, async () => {
    const data = await xtream.getShortEPG(config, streamId);
    setCapped(epgCache, key, { data, ts: Date.now() }, EPG_CACHE_MAX);
    return data;
  });
}

// "🗓 Subscription expires 2026-12-01" for the channel page, or "" when unknown
function subscriptionLine(info) {
  if (!info || typeof info !== "object") return "";
  const status = String(info.status || "").trim().toLowerCase();
  if (status !== "" && status !== "active") return `⚠️ Your IPTV account is ${status.slice(0, 20)}`;
  const exp = Number(info.exp_date);
  if (!Number.isFinite(exp) || exp <= 0) return ""; // missing/invalid date → nothing to show
  const date = new Date(exp * 1000).toISOString().slice(0, 10);
  return exp * 1000 < Date.now() ? `⚠️ Subscription expired on ${date}` : `🗓 Subscription expires ${date}`;
}

// The programme on now and the one after it, by the provider's timestamps (some
// panels start the list at the next show, some include ended ones). Without
// usable timestamps: the first two entries as sent.
function nowAndNext(listings, nowSec) {
  const start = (e) => Number(e.start_timestamp);
  const end = (e) => Number(e.stop_timestamp || e.end_timestamp);
  const timed = listings.filter(e => start(e) > 0 && end(e) > 0).toSorted((a, b) => start(a) - start(b));
  if (timed.length === 0) return { now: listings[0], next: listings[1] };
  const now = timed.find(e => start(e) <= nowSec && nowSec < end(e));
  const next = timed.find(e => start(e) >= (now ? end(now) : nowSec));
  return { now, next };
}

// Channel page guide: "▶ Now 20:00 - 21:00 News" and "Next 21:00 - 22:00 Film"
// (titles only, times in the viewer's zone); "" when there's nothing to show
function guideLines(listings, timezone) {
  if (!listings?.length) return "";
  const { now, next } = nowAndNext(listings, Date.now() / 1000);
  const line = (e) => {
    const time = epgTimeRange(e, timezone);
    const title = e.title ? Buffer.from(e.title, "base64").toString("utf-8") : "";
    return `${time ? time + " " : ""}${title}`;
  };
  return [now && `▶ Now ${line(now)}`, next && `Next ${line(next)}`].filter(Boolean).join("\n");
}

async function getXtreamMeta(config, type, id) {
  // Only live TV channels are supported
  if (type !== "tv") return null;

  const streamId = id.replace(`iptv_${type}_`, "");

  // Look up actual channel name from cached catalog
  const catalog = await getXtreamCatalog(config, type);
  const item = catalog.find(m => m.id === id);

  const name = item ? cleanName(channelTitle(catalog, item)) : `Stream ${streamId}`;
  const poster = item ? channelPoster(item.logo, name) : makePosterUrl(name);
  let description = "📺 Live Channel — StreamVault IPTV";

  // Subscription expiry (cached; fetched alongside the EPG)
  const accountPromise = getXtreamAccount(config);

  // Fetch EPG for live channels
  try {
    const guide = guideLines(await getCachedEPG(config, streamId), config.timezone);
    if (guide) description = "📺 TV Guide:\n" + guide;
  } catch (_) {
    // No TV guide from the provider: the channel page just shows no guide
  }

  const archived = archivedVersion(catalog, item, catalogView(catalog).versionsById.get(id) || []);
  if (archived) {
    const days = archived.archiveDays;
    description += `\n\n⏪ Catch-up: past ${days} day${days === 1 ? "" : "s"} — in the play options`;
  }

  const subscription = subscriptionLine(await accountPromise);
  if (subscription) description += `\n\n${subscription}`;

  // Not in the (just loaded) catalog → the provider doesn't list it in the
  // user's categories; refetching the full stream list would only spike memory
  const meta = { id, type, name, poster, posterShape: "square", description };
  if (item?.genres) meta.genres = item.genres;
  return meta;
}

// --- Catch-up (TV archive): past programmes of channels the provider records ---
// Offered under the live streams: the programme on now "from the start", then
// the ones that ended, newest first. Waits at most CATCHUP_WAIT_MS for the guide
// so a slow provider never holds up the live streams.
const CATCHUP_WAIT_MS = 3000;
const MAX_CATCHUP = 24;
const PROVIDER_START = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})/; // "2026-10-27 20:00:00" (provider's local time)

// Past programmes that can be watched again, newest first (cached like the guide)
async function getCatchupPrograms(config, streamId, archiveDays) {
  const key = `catchup:${trimTrailingSlashes(config.server)}_${streamId}`;
  const cached = touch(epgCache, key);
  if (cached && Date.now() - cached.ts < EPG_CACHE_TTL) return cached.data;
  return once(`epg:${key}`, async () => {
    const listings = await xtream.getEpgTable(config, streamId);
    const nowSec = Date.now() / 1000;
    const oldest = nowSec - archiveDays * 86400;
    // Only what the streams need (the full table can hold a week of programmes)
    const data = listings
      .map(e => ({
        start: PROVIDER_START.exec(String(e.start || "")),
        startTs: Number(e.start_timestamp),
        endTs: Number(e.stop_timestamp || e.end_timestamp),
        archived: e.has_archive === undefined || Number(e.has_archive) === 1,
        title: e.title ? Buffer.from(e.title, "base64").toString("utf-8").slice(0, 80) : "",
      }))
      .filter(p => p.start && p.archived && p.startTs >= oldest && p.startTs <= nowSec && p.endTs > p.startTs)
      .toSorted((a, b) => b.startTs - a.startTs)
      .slice(0, MAX_CATCHUP)
      .map(({ start, startTs, endTs, title }) => ({ start: `${start[1]}:${start[2]}-${start[3]}`, startTs, endTs, title }));
    setCapped(epgCache, key, { data, ts: Date.now() }, EPG_CACHE_MAX);
    return data;
  });
}

// "Today", "Yesterday" or "Mon 26.10" in the viewer's time zone
function catchupDay(ts, timezone) {
  const day = (sec) => {
    try {
      return new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "UTC" }).format(sec * 1000);
    } catch (_) {
      return new Date(sec * 1000).toISOString().slice(0, 10);
    }
  };
  const nowSec = Date.now() / 1000;
  const d = day(ts);
  if (d === day(nowSec)) return "Today";
  if (d === day(nowSec - 86400)) return "Yesterday";
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`));
  return `${weekday} ${d.slice(8, 10)}.${d.slice(5, 7)}`;
}

// Providers that record channels but have no guide on the server (an empty table
// even for a recorded channel): time slots instead, newest first — the last 24
// full hours one by one, older ones in 3-hour blocks back to the archive's limit
// (3 days = 24 + 16 rows, short enough to scroll on a TV). Slots start on the
// provider's clock, so it needs its UTC offset (server_info); without one there's
// no safe start time.
const HOURLY_SLOTS = 24;
const BLOCK_HOURS = 3;
function hourlySlots(archiveDays, offsetMin) {
  if (!Number.isInteger(offsetMin)) return [];
  const offset = offsetMin * 60;
  const nowLocal = Math.floor(Date.now() / 1000) + offset;
  const thisHour = nowLocal - (nowLocal % 3600);
  const oldest = nowLocal - archiveDays * 86400; // the archive's limit
  const slot = (startLocal, hours) => {
    const local = new Date(startLocal * 1000).toISOString(); // provider's wall clock
    return {
      start: `${local.slice(0, 10)}:${local.slice(11, 13)}-${local.slice(14, 16)}`,
      startTs: startLocal - offset,
      endTs: startLocal - offset + hours * 3600,
      title: "",
    };
  };
  const slots = [];
  let start = thisHour;
  while (start - 3600 >= oldest && slots.length < HOURLY_SLOTS) {
    start -= 3600;
    slots.push(slot(start, 1));
  }
  while (start - BLOCK_HOURS * 3600 >= oldest) {
    start -= BLOCK_HOURS * 3600;
    slots.push(slot(start, BLOCK_HOURS));
  }
  return slots;
}

// One stream per past programme: /timeshift/<user>/<pass>/<minutes>/<start>/<id>.<ext>
function catchupStreams(config, channel, programs, { baseUrl, configPath }, formats) {
  const streamId = channel.id.replace("iptv_tv_", "");
  const server = trimTrailingSlashes(config.server);
  const tvName = (channel.name && cleanName(channel.name)) || `Channel ${streamId}`;
  const ext = formats.ts ? "ts" : "m3u8";
  const nowSec = Date.now() / 1000;
  return programs.map(p => {
    const minutes = Math.ceil((p.endTs - p.startTs) / 60);
    const running = p.endTs > nowSec;
    // Older installs have no time zone: the provider's own start time ("20:00")
    const time = config.timezone
      ? epgTimeRange({ start_timestamp: p.startTs, stop_timestamp: p.endTs }, config.timezone)
      : `${p.start.slice(11, 13)}:${p.start.slice(14, 16)}`;
    const label = `${running ? "From the start" : catchupDay(p.startTs, config.timezone)} ${time}`;
    const safeName = encodeURIComponent(`${tvName} ${p.title}`.trim().slice(0, 100).toWellFormed());
    const url = baseUrl && configPath
      ? `${baseUrl}/play/${configPath}/timeshift/${streamId}/${p.start}/${minutes}/${ext}/${safeName}`
      : `${server}/timeshift/${config.username}/${config.password}/${minutes}/${p.start}/${streamId}.${ext}`;
    return {
      name: `StreamVault\n${running ? "▶ From start" : "⏪ Catch-up"}`,
      title: `${[label, p.title].filter(Boolean).join(" ")}\n${tvName}`,
      url,
      behaviorHints: { notWebReady: true, bingeGroup: "streamvault-catchup" },
    };
  });
}

// play: { baseUrl, configPath } for /play links
async function getXtreamStreams(config, type, id, play = {}) {
  // Only live TV channels are supported
  if (type !== "tv") return [];

  let catalog = [];
  try {
    catalog = await getXtreamCatalog(config, type);
  } catch (_) {
    // Catalog unavailable: the stream still plays, titled "Channel <id>"
  }
  // All versions of the channel (UHD/FHD/HD/…), best quality first — also when
  // an older saved id of a lower version is opened
  const item = catalog.find(m => m.id === id);
  const versions = catalogView(catalog).versionsById.get(id) || [{ id, name: item?.name }];
  // Catch-up from the opened channel, or else its first version the provider records;
  // started now so it loads alongside the account lookup
  const archived = archivedVersion(catalog, item, versions);
  const programsPromise = archived
    ? withinMs(getCatchupPrograms(config, archived.id.replace("iptv_tv_", ""), archived.archiveDays), CATCHUP_WAIT_MS, [])
    : Promise.resolve([]);
  // Usually cached already (catalog / expiry tile); a slow provider gets both formats
  const account = await withinMs(getXtreamAccount(config), ACCOUNT_WAIT_MS, null);
  const formats = allowedFormats(account);
  const live = versions.flatMap(channel => xtreamStreamPair(config, channel, play, formats));
  if (!archived) return live;
  // Catch-up is extra: whatever goes wrong building it (odd guide data, a bug),
  // the live streams are still answered
  try {
    const programs = await programsPromise;
    const entries = programs.length ? programs : hourlySlots(archived.archiveDays, account?.serverUtcOffsetMin);
    return [...live, ...catchupStreams(config, archived, entries, play, formats)];
  } catch (e) {
    console.warn(`[CATCHUP] skipped for one channel: ${safeError(e)}`);
    return live;
  }
}

// The version of a channel tile the provider records (the opened one first) —
// a tile's main version (e.g. UHD) may have no archive while another one has
function archivedVersion(catalog, item, versions) {
  if (item?.archiveDays) return item;
  return versions.map(v => catalog.find(m => m.id === v.id)).find(m => m?.archiveDays) || null;
}

// The formats this account may play, from its "allowed_output_formats" — e.g.
// ["m3u8", "ts"], or only ["ts"] on some panels. Names compared ignoring case and
// spaces ("TS", "HLS"; a "ts,m3u8" string too). Nothing usable listed (missing,
// empty, only "rtmp"): both, as before — never hide a format on a guess.
function allowedFormats(info) {
  const raw = info?.allowed_output_formats;
  const list = typeof raw === "string" ? raw.split(",") : raw;
  const names = new Set((Array.isArray(list) ? list : []).map(f => String(f).trim().toLowerCase()));
  const ts = names.has("ts") || names.has("mpegts");
  const hls = names.has("m3u8") || names.has("hls");
  return ts || hls ? { ts, hls } : { ts: true, hls: true };
}

// TS + HLS for one Xtream channel (only the formats the account allows)
function xtreamStreamPair(config, channel, { baseUrl, configPath }, formats) {
  // id format: iptv_tv_<streamId>
  const streamId = channel.id.replace("iptv_tv_", "");
  const server = trimTrailingSlashes(config.server);

  // Live TV: notWebReady hints Stremio to prefer external player (VLC/MX)
  const tvName = (channel.name && cleanName(channel.name)) || `Channel ${streamId}`;
  const safeName = encodeURIComponent(tvName.toWellFormed());
  // Route through /play redirect so VLC shows channel name (last path segment)
  const useRedirect = baseUrl && configPath;
  const tsUrl = useRedirect
    ? `${baseUrl}/play/${configPath}/live/${streamId}/ts/${safeName}`
    : `${server}/live/${config.username}/${config.password}/${streamId}.ts`;
  const hlsUrl = useRedirect
    ? `${baseUrl}/play/${configPath}/live/${streamId}/m3u8/${safeName}`
    : `${server}/live/${config.username}/${config.password}/${streamId}.m3u8`;

  return [
    formats.ts && {
      name: "StreamVault\nTS",
      title: `${tvName}\nMPEG-TS`,
      url: tsUrl,
      behaviorHints: { notWebReady: true, bingeGroup: "streamvault-live" },
    },
    formats.hls && {
      name: "StreamVault\nHLS",
      title: `${tvName}\nHLS / m3u8`,
      url: hlsUrl,
      behaviorHints: { notWebReady: true, bingeGroup: "streamvault-live" },
    },
  ].filter(Boolean);
}

module.exports = {
  xtreamCategoryIds, getXtreamCatalog, epgTimeRange, getXtreamAccount, forceRefresh, getXtreamMeta,
  getXtreamStreams,
};
