/**
 * links.js — stable install links ("s-<id>") whose settings can be edited in place.
 *
 * An "e-<hex>" link carries the encrypted settings itself, so changing them makes
 * a new link and apps install a second StreamVault. An "s-<id>" link points to
 * settings saved here instead: editing replaces them and the link stays the same.
 *
 * Older links ("e-…", base64, plain) can be edited in place too: their new
 * settings are saved as an override, keyed by a SHA-256 fingerprint of the link
 * (the link itself isn't stored). Without links.json such a link falls back to
 * the settings inside it, so it never breaks.
 *
 * Stored: only the already-encrypted settings (same AES-256-GCM as "e-" links),
 * never plain credentials. File: <dir>/links.json, loaded once at startup.
 * Losing it breaks every "s-" install, so writes are atomic (temp file + rename)
 * and the previous version is kept as links.json.bak.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ID_RE = /^s-[a-z0-9]{12}$/;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
// ~600 bytes per entry on average → 50k ≈ 30 MB in memory at most; over the cap
// new installs fall back to self-contained "e-" links
const MAX_LINKS = 50_000;

function createStore(dir) {
  const file = path.join(dir, "links.json");
  const bak = `${file}.bak`;
  const links = new Map();     // id -> { e, c (created ms), r (revision) }
  const overrides = new Map(); // sha256(old link) -> { e, c, r }

  // Load: main file, else the backup. A file that can't be parsed is kept aside
  // (never overwritten by an empty store) and reported in the logs.
  for (const candidate of [file, bak]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      for (const [id, entry] of Object.entries(data.links || {})) {
        if (ID_RE.test(id) && entry && typeof entry.e === "string") links.set(id, entry);
      }
      for (const [key, entry] of Object.entries(data.overrides || {})) {
        if (/^[0-9a-f]{64}$/.test(key) && entry && typeof entry.e === "string") overrides.set(key, entry);
      }
      if (candidate === bak) console.error("[LINKS] links.json unreadable or missing — loaded links.json.bak");
      break;
    } catch (e) {
      const aside = `${candidate}.corrupt-${Date.now()}`;
      try { fs.renameSync(candidate, aside); } catch (_) {}
      console.error(`[LINKS] ${path.basename(candidate)} could not be read (${e.message}) — moved to ${path.basename(aside)}`);
    }
  }

  // Saves are serialized: one write at a time, and a change during a write
  // triggers one more write afterwards
  let writing = false;
  let dirty = false;
  let retryTimer = null;
  const RETRY_MS = 10_000; // a failing disk is retried later, not in a tight loop

  function serialize() {
    return JSON.stringify({ links: Object.fromEntries(links), overrides: Object.fromEntries(overrides) });
  }

  function save() {
    if (writing) { dirty = true; return; }
    writing = true;
    dirty = false;
    const tmp = `${file}.tmp`;
    const data = serialize();
    let failed = false;
    fs.promises.writeFile(tmp, data)
      .then(() => fs.promises.copyFile(file, bak).catch(() => {})) // no main file yet on first save
      .then(() => fs.promises.rename(tmp, file))
      .catch((e) => { console.error("[LINKS] save failed:", e.message); failed = true; dirty = true; })
      .finally(() => {
        writing = false;
        if (!dirty) return;
        if (!failed) return save();
        if (!retryTimer) {
          retryTimer = setTimeout(() => { retryTimer = null; save(); }, RETRY_MS);
          retryTimer.unref();
        }
      });
  }

  // On shutdown: write synchronously if something hasn't been saved yet
  function saveSync() {
    if (!dirty && !writing) return;
    try {
      const tmp = `${file}.exit.tmp`;
      fs.writeFileSync(tmp, serialize());
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error("[LINKS] shutdown save failed:", e.message);
    }
  }

  function newId() {
    for (;;) {
      const bytes = crypto.randomBytes(12);
      let id = "s-";
      for (const b of bytes) id += ID_CHARS[b % ID_CHARS.length];
      if (!links.has(id)) return id;
    }
  }

  const full = () => links.size + overrides.size >= MAX_LINKS;
  const fingerprint = (link) => crypto.createHash("sha256").update(link).digest("hex");

  return {
    isId: (id) => ID_RE.test(id),
    size: () => links.size + overrides.size,
    /** Encrypted settings + revision for a link, or null */
    get(id) {
      const entry = ID_RE.test(id) ? links.get(id) : null;
      return entry ? { encrypted: entry.e, revision: entry.r || 1 } : null;
    },
    /** New link for these encrypted settings; null when the store is full */
    create(encrypted) {
      if (full()) return null;
      const id = newId();
      links.set(id, { e: encrypted, c: Date.now(), r: 1 });
      save();
      return id;
    },
    /** Replace the settings of an existing link; false if it doesn't exist */
    update(id, encrypted) {
      const entry = ID_RE.test(id) ? links.get(id) : null;
      if (!entry) return false;
      entry.e = encrypted;
      entry.r = (entry.r || 1) + 1;
      save();
      return true;
    },
    /** Newer settings saved for an older link, or null (no hashing while there are none) */
    getOverride(link) {
      if (overrides.size === 0 || typeof link !== "string") return null;
      const entry = overrides.get(fingerprint(link));
      return entry ? { encrypted: entry.e, revision: entry.r || 1 } : null;
    },
    /** Save new settings for an older link; false when the store is full */
    setOverride(link, encrypted) {
      const key = fingerprint(link);
      const entry = overrides.get(key);
      if (entry) {
        entry.e = encrypted;
        entry.r = (entry.r || 1) + 1;
      } else {
        if (full()) return false;
        overrides.set(key, { e: encrypted, c: Date.now(), r: 1 });
      }
      save();
      return true;
    },
    saveSync,
  };
}

module.exports = { createStore, MAX_LINKS };
