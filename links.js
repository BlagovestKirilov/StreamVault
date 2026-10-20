/**
 * links.js — stable install links ("s-<id>") whose settings can be edited in place.
 *
 * An "e-<hex>" link carries the encrypted settings itself, so changing them makes
 * a new link and apps install a second StreamVault. An "s-<id>" link points to
 * settings saved here instead: editing replaces them and the link stays the same.
 *
 * Stored: only the already-encrypted settings (same AES-256-GCM as "e-" links),
 * never plain credentials. File: <dir>/links.json, loaded once at startup.
 * Losing it breaks every "s-" install, so writes are atomic (temp file + rename)
 * and the previous version is kept as links.json.bak.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ID_RE = /^s-[a-z0-9]{12}$/;
const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
// ~600 bytes per entry on average → 50k ≈ 30 MB in memory at most; over the cap
// new installs fall back to self-contained "e-" links
const MAX_LINKS = 50_000;

function createStore(dir) {
  const file = path.join(dir, "links.json");
  const bak = `${file}.bak`;
  const links = new Map(); // id -> { e, c (created ms), r (revision) }

  // Load: main file, else the backup. A file that can't be parsed is kept aside
  // (never overwritten by an empty store) and reported in the logs.
  for (const candidate of [file, bak]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(candidate, "utf-8"));
      for (const [id, entry] of Object.entries(data.links || {})) {
        if (ID_RE.test(id) && entry && typeof entry.e === "string") links.set(id, entry);
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

  function serialize() {
    return JSON.stringify({ links: Object.fromEntries(links) });
  }

  function save() {
    if (writing) { dirty = true; return; }
    writing = true;
    dirty = false;
    const tmp = `${file}.tmp`;
    const data = serialize();
    fs.promises.writeFile(tmp, data)
      .then(() => fs.promises.copyFile(file, bak).catch(() => {})) // no main file yet on first save
      .then(() => fs.promises.rename(tmp, file))
      .catch((e) => { console.error("[LINKS] save failed:", e.message); dirty = true; })
      .finally(() => {
        writing = false;
        if (dirty) save();
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

  return {
    isId: (id) => ID_RE.test(id),
    size: () => links.size,
    /** Encrypted settings + revision for a link, or null */
    get(id) {
      const entry = ID_RE.test(id) ? links.get(id) : null;
      return entry ? { encrypted: entry.e, revision: entry.r || 1 } : null;
    },
    /** New link for these encrypted settings; null when the store is full */
    create(encrypted) {
      if (links.size >= MAX_LINKS) return null;
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
    saveSync,
  };
}

module.exports = { createStore, MAX_LINKS };
