/**
 * catalog.js — Channel lists: order, one tile per channel (versions merged),
 * display names, posters and search matching. Pure functions, no I/O.
 */

// --- Search matching ---
// "La Vie Rêve" = "la vie reve", "Канал 1" = "kanal 1", "Nord-Sport" = "nord sport".
// Cyrillic (Bulgarian/Serbian/Macedonian/Russian/Ukrainian) is written in Latin
// letters so either alphabet finds the channel.
const CYRILLIC_TO_LATIN = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", к: "k",
  л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
  х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya",
  ы: "y", э: "e", є: "e", і: "i", ђ: "dj", ј: "j", љ: "lj", њ: "nj", ћ: "c",
  џ: "dz", ѕ: "dz",
};
// Latin letters that don't split into base letter + accent
const LATIN_EXTRA = { ß: "ss", đ: "d", ł: "l", ø: "o", æ: "ae", œ: "oe", ı: "i", þ: "th" };

function normalizeForSearch(text) {
  let s = String(text).toLowerCase();
  // Plain ASCII (most names and searches) skips the slow path
  // eslint-disable-next-line no-control-regex -- \x00-\x7f is the whole ASCII range on purpose
  if (/[^\x00-\x7f]/.test(s)) {
    s = s.normalize("NFKD").replace(/\p{M}/gu, ""); // ê → e, й → и, ё → е
    s = s.replace(/[Ѐ-ӿß-þđıłœ]/g, ch => CYRILLIC_TO_LATIN[ch] ?? LATIN_EXTRA[ch] ?? ch);
  }
  return s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// --- Channel lists ---
/**
 * Generate a poster URL with the channel name as visible text (PNG).
 * Uses ui-avatars.com — a free service that generates text-based images.
 */
function makePosterUrl(name) {
  // Cut by whole characters: substring(0, 30) could split an emoji in half, and
  // encodeURIComponent then threw "URI malformed", failing the whole catalog page.
  // toWellFormed() also repairs broken characters coming from a provider.
  const text = encodeURIComponent(Array.from(String(name).toWellFormed()).slice(0, 30).join(""));
  return `https://ui-avatars.com/api/?name=${text}&size=300&background=1e1e3a&color=ffffff&font-size=0.28&bold=true&length=30`;
}

/**
 * Channel logo as a square image with the whole logo visible.
 * Stremio fills square tiles by cropping, which cuts off most wide TV logos, so
 * wsrv.nl (a free image service) fits the logo into a 256×256 transparent square.
 * It also serves http logos over https. The server does no image work itself.
 * `fallback` is shown instead when the provider's logo link is dead.
 */
function squareLogo(logo, fallback) {
  if (!/^https?:\/\//i.test(logo || "")) return "";
  return `https://wsrv.nl/?url=${encodeURIComponent(logo.toWellFormed())}&w=256&h=256&fit=contain&cbg=transparent&output=png` +
    `&default=${encodeURIComponent(fallback)}`;
}

// Poster for a channel: its logo fitted into a square, or a generated name tile
function channelPoster(logo, name) {
  const nameTile = makePosterUrl(name);
  return squareLogo(logo, nameTile) || nameTile;
}

// Channel order: picked categories in the order the user picked them (configure
// page chips; Xtream `c` ids / M3U `g` names), otherwise categories A–Z; channels
// A–Z inside each; channels without a category (or M3U's "Uncategorized", unless
// picked) last. Any script (Latin, Cyrillic, Greek…), case and accents ignored,
// numbers in names compared as numbers ("Sport 2" before "Sport 10"). Done once
// per cache load, never per request. The genre dropdown follows the same order.
const nameOrder = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function sortCategory(meta) {
  return meta.genres?.[0] || "";
}

// Real categories A–Z, then the channels without one
function compareByName(a, b) {
  const ca = a === "Uncategorized" ? "" : a;
  const cb = b === "Uncategorized" ? "" : b;
  if (ca === cb) return 0;
  if (!ca || !cb) return ca ? -1 : 1;
  return nameOrder.compare(ca, cb);
}

// Picked categories first, in pick order; the rest by name
function compareCategories(a, b, rank) {
  const ra = rank.get(a) ?? Infinity;
  const rb = rank.get(b) ?? Infinity;
  if (ra !== rb) return ra < rb ? -1 : 1;
  return compareByName(a, b);
}

// Names are compared as search sees them (normalizeForSearch: case, accents,
// punctuation and odd/leading spaces ignored, Cyrillic transliterated by sound),
// so a provider's hidden characters don't move a channel. Quality tags don't count
// either: "ALPHA", "ALPHA HD", "ALPHA UHD" stay together (before "ALPHA ACTION"); same
// base name → lower quality first. Tags match any case, also inside () or [].
const QUALITY_TAGS = new Map([
  ["sd", 1], ["lq", 1], ["hq", 2], ["hd", 2], ["720p", 2], ["fhd", 3], ["1080p", 3], ["1080i", 3],
  ["uhd", 4], ["4k", 4], ["2160p", 4], ["8k", 5],
  ["hevc", 0], ["h265", 0], ["h264", 0], ["50fps", 0], ["60fps", 0],
]);

// "[BG] ALPHA (UHD)" → { base: "bg alpha", quality: 4 }
function nameKey(name) {
  const normalized = normalizeForSearch(name || "");
  const kept = [];
  let quality = 0;
  for (const word of normalized.split(" ")) {
    const tag = QUALITY_TAGS.get(word);
    if (tag === undefined) kept.push(word);
    else quality = Math.max(quality, tag);
  }
  const mergeBase = mergeWords(normalized.split(" "));
  // A trailing "TV" doesn't count either: "NORTH TV" sorts with "NORTH", not after
  // "NORTH SPORT" ("ALPHATV", "TVX", "TV 9000" keep theirs)
  if (kept.length > 1 && kept.at(-1) === "tv") kept.pop();
  return { base: kept.join(" ") || normalized, mergeBase, quality };
}

// Versions of one channel differ only by quality tags and a "TV" at the END of
// the name ("ALPHA", "ALPHA HD", "BRIX TV" + "BRIX UHD", "BAY MUSIC TV UHD") —
// merged into one tile. A tag inside a name ("Sport HD Premium") is part of it.
function mergeWords(words) {
  let end = words.length;
  const dropTags = () => {
    while (end > 1 && QUALITY_TAGS.has(words[end - 1])) end--;
  };
  dropTags();
  if (end > 1 && words[end - 1] === "tv") end--;
  dropTags();
  return words.slice(0, end).join(" ");
}

// "[BG] ALPHA (UHD)" → "[BG] ALPHA" (display name of a merged tile): trailing tags only
function stripQualityTags(name) {
  const words = String(name || "").trim().split(" ");
  let end = words.length;
  while (end > 1 && QUALITY_TAGS.has(words[end - 1].replaceAll(/[()[\]|]/g, "").toLowerCase())) end--;
  return words.slice(0, end).join(" ");
}

// Leading provider tags — bounded parts only (no backtracking); at most two are
// removed ("|AR| VIP| …")
const NAME_PREFIXES = [
  /^\[[^\]]{1,8}\] */,        // "[BG] "
  /^\([^)]{1,8}\) */,         // "(UK) "
  /^\|[^|]{1,8}\| */,         // "|AR| "
  /^[A-Za-z0-9]{2,4} ?\| */,  // "VIP| ", "UK | "
  /^[A-Z]{2} ?: */,           // "UK: "
  /^[A-Z]{2} - */,            // "BG - "
];
function cleanName(name) {
  let out = String(name || "").trim();
  for (let i = 0; i < 2; i++) {
    const match = NAME_PREFIXES.map(re => re.exec(out)).find(Boolean);
    if (!match || match[0].length >= out.length) break;
    out = out.slice(match[0].length);
  }
  return out;
}

// One tile per channel: versions of a channel in the same category that differ
// only by quality ("ALPHA", "ALPHA HD", "ALPHA UHD") share a tile, named without the
// tag, with the best version's id; its streams offer every version, best first.
// Built once per cached list (WeakMap: dropped with it).
const MAX_VERSIONS = 6;
const catalogViews = new WeakMap();
function catalogView(list) {
  let view = catalogViews.get(list);
  if (view) return view;
  const byKey = new Map(); // first appearance keeps the sorted order
  for (const meta of list) {
    const { mergeBase, quality } = nameKey(meta.name);
    // A name of only symbols/emoji normalizes to "": key it by itself, not with all such names
    const key = JSON.stringify([meta.genres?.[0] || "", mergeBase || meta.name]);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ meta, quality });
  }
  const display = [];
  const versionsById = new Map(); // channel id -> its channel's versions, best first
  const titles = new Map();       // merged tile id -> its name
  for (const members of byKey.values()) {
    const ordered = members.toSorted((a, b) => b.quality - a.quality).slice(0, MAX_VERSIONS);
    const versions = ordered.map(m => m.meta);
    if (versions.length === 1) {
      display.push(versions[0]);
      continue;
    }
    // Named like the plain version as the provider wrote it ("BRIX TV", not "BRIX")
    const title = stripQualityTags((ordered.find(m => m.quality === 0) || ordered[0]).meta.name);
    display.push({ ...versions[0], name: title });
    titles.set(versions[0].id, title);
    for (const m of members) versionsById.set(m.meta.id, versions);
  }
  view = { display, versionsById, titles };
  catalogViews.set(list, view);
  return view;
}

// A channel's name as its tile shows it (a merged tile: its group's name)
function channelTitle(list, item) {
  return catalogView(list).titles.get(item.id) ?? item.name;
}

function compareChannels(a, b) {
  return nameOrder.compare(a.base, b.base) || a.quality - b.quality || nameOrder.compare(a.meta.name, b.meta.name);
}

// Keys computed once per channel (not per comparison), then written back in order
function sortChannels(metas, picked = []) {
  const rank = new Map(picked.map((name, i) => [name, i]));
  const keyed = metas.map(meta => ({ meta, category: sortCategory(meta), ...nameKey(meta.name) }));
  keyed.sort((a, b) => compareCategories(a.category, b.category, rank) || compareChannels(a, b));
  keyed.forEach((k, i) => { metas[i] = k.meta; });
  return metas;
}

// Catalog channel { id, type, name, logo, genres? } → what Stremio gets. Called
// only for the channels actually sent (one page), so the long poster links are
// never built for a whole 10k-channel list or kept in the caches.
function catalogMeta({ logo, ...item }) {
  const name = cleanName(item.name);
  return { ...item, name, poster: channelPoster(logo, name), posterShape: "square" };
}

module.exports = {
  makePosterUrl, channelPoster, nameKey, cleanName, catalogView, channelTitle, sortChannels, catalogMeta, normalizeForSearch,
};
