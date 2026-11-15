// StreamVault configure page (linked from configure.html). A classic script, not a
// module: the page's onclick/oninput attributes call these functions by name.
if (new URLSearchParams(location.search).get('from') === 'tile') {
  document.getElementById('tileBanner').style.display = 'block';
}

// Scroll to top when returning from Stremio or another app
document.addEventListener('visibilitychange', function() {
  if (!document.hidden) window.scrollTo(0, 0);
});

// Theme toggle
function applyTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
  document.getElementById('iconSun').style.display = theme === 'light' ? 'none' : 'block';
  document.getElementById('iconMoon').style.display = theme === 'light' ? 'block' : 'none';
  document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#f5f5fa' : '#0a0a16';
}
function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light');
  const newTheme = isLight ? 'dark' : 'light';
  localStorage.setItem('sv-theme', newTheme);
  applyTheme(newTheme);
}
applyTheme(localStorage.getItem('sv-theme') || 'dark');

let source = 'xtream';

function setTab(t) {
  source = t;
  document.getElementById('tabXtream').classList.toggle('active', t === 'xtream');
  document.getElementById('tabM3u').classList.toggle('active', t === 'm3u');
  document.getElementById('panelXtream').classList.toggle('active', t === 'xtream');
  document.getElementById('panelM3u').classList.toggle('active', t === 'm3u');
  closeResult();
  // Categories belong to one source — start fresh on switch
  allCategories = [];
  selectedCategories.clear();
  document.getElementById('catSearch').value = '';
  document.getElementById('catSearchWrap').style.display = 'none';
  document.getElementById('catList').style.display = 'none';
  document.getElementById('catTools').style.display = 'none';
  document.getElementById('catHint').style.display = '';
  lastCheckKey = null;
  renderCategoryList(true);
  renderSelectedTags();
  updateButtons();
}

// --- Connection check (shared by Test, Load Categories and Install) ---
let lastCheckKey = null;   // request body that last passed the check
let editingLink = '';      // install link this page was opened from (an app's Configure)
let checking = false;      // a Test / Load Categories request is running

// Playlist text pasted instead of its link (a text box joins the lines)
const PASTED_PLAYLIST_TEXT = 'Paste the playlist link (http://…), not the playlist text';
const looksLikePlaylistText = (v) => /#EXT(M3U|INF)/i.test(v) || v.length > 2048;

// Validates the form; returns the /api/test body, or null (showing why unless quiet)
function getCheckBody(quiet) {
  const fail = (msg) => {
    if (!quiet) showToast(msg);
    return null;
  };
  if (source === 'xtream') {
    const server = document.getElementById('server').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    if (!server || !username || !password) return fail('Fill in server, username and password first');
    // Without http:// is fine: the server tries http and https and the field
    // gets the address that worked. Only checks the address can be parsed, never
    // connects (the server picks http or https):
    // eslint-disable-next-line sonarjs/no-clear-text-protocols
    if (!isValidUrl(server) && !isValidUrl('http://' + server)) return fail('Server URL must be a valid URL (http://...)');
    return { type: 'xtream', server, username, password };
  }
  const m3uUrl = document.getElementById('m3uUrl').value.trim();
  if (!m3uUrl) return fail('Enter the playlist URL first');
  if (looksLikePlaylistText(m3uUrl)) return fail(PASTED_PLAYLIST_TEXT);
  if (!isValidUrl(m3uUrl)) return fail('Playlist URL must be a valid URL (http://...)');
  return { type: 'm3u', m3uUrl };
}

// One main button: "Test Connection" until the test passes for exactly the
// details in the form, then "Install". Editing anything after a pass brings
// Test back. Test needs valid details.
// What's missing in the form, for the hint under the button
function missingDetailsHint() {
  if (source === 'xtream') return 'Enter a valid server URL (http://...), username and password';
  if (looksLikePlaylistText(document.getElementById('m3uUrl').value.trim())) return PASTED_PLAYLIST_TEXT;
  return 'Enter a valid playlist URL (http://...)';
}

function updateButtons() {
  const body = getCheckBody(true);
  const passed = !!body && lastCheckKey === JSON.stringify(body);
  const btnTest = document.getElementById('btnTest');
  const btnInstall = document.getElementById('btnInstall');
  btnTest.style.display = passed ? 'none' : 'flex';
  btnInstall.style.display = passed ? 'flex' : 'none';
  btnTest.disabled = !body || checking;
  btnTest.classList.toggle('incomplete', !body && !checking);
  btnInstall.disabled = checking;
  const hint = document.getElementById('installHint');
  if (!body) {
    hint.textContent = missingDetailsHint();
  } else if (!passed) {
    // matches the button: "Save changes" once an installed setup has loaded
    hint.textContent = `${document.getElementById('btnInstallText').textContent === 'Save changes' ? 'Save' : 'Install'} becomes available after a successful test`;
  } else if (document.getElementById('btnInstallText').textContent === 'Save changes') {
    hint.textContent = 'Saving also reloads your channel list from your provider';
  } else {
    hint.textContent = '';
  }
  hint.style.display = hint.textContent ? 'block' : 'none';
}

// Pasted the provider's full link (".../get.php?username=..&password=..") into
// the server field? Keep just the server and fill username/password from it.
function splitXtreamLink() {
  const serverEl = document.getElementById('server');
  let u;
  try {
    u = new URL(serverEl.value.trim());
  } catch (_) {
    return; // not a full URL yet: nothing to split
  }
  // A playlist link (".../index.m3u") belongs in the M3U tab
  // (checks the path, or the host when there's no path: "http://name.m3u")
  if (/\.m3u8?$/i.test(u.pathname === '/' ? u.hostname : u.pathname)) {
    const link = serverEl.value.trim();
    serverEl.value = '';
    setTab('m3u');
    document.getElementById('m3uUrl').value = link;
    updateButtons();
    showToast('This is a playlist link — moved it to the M3U tab', true);
    return;
  }
  const isFullLink = /\/(get|player_api|xmltv|panel_api)\.php$/i.test(u.pathname) || u.searchParams.has('username');
  if (!isFullLink) return;
  const userEl = document.getElementById('username');
  const passEl = document.getElementById('password');
  if (!userEl.value.trim() && u.searchParams.get('username')) userEl.value = u.searchParams.get('username');
  if (!passEl.value.trim() && u.searchParams.get('password')) passEl.value = u.searchParams.get('password');
  serverEl.value = u.origin;
  showToast('Filled in server, username and password from your link', true);
}
// On paste (value is updated right after the event) and when leaving the field,
// not on every keystroke — a link typed by hand would be split halfway through
document.getElementById('server').addEventListener('paste', () => setTimeout(() => { splitXtreamLink(); updateButtons(); }, 0));
document.getElementById('server').addEventListener('change', splitXtreamLink);

// The other way round: an Xtream provider's playlist link (".../get.php?username=
// ..&password=..") pasted into the M3U tab. As Xtream it gets the TV guide and
// account status, so fill in the Xtream tab instead. The link stays in the M3U
// field: tapping M3U goes back to it. Not when editing an installed setup.
function m3uLinkToXtream() {
  if (editingLink) return;
  let u;
  try {
    u = new URL(document.getElementById('m3uUrl').value.trim());
  } catch (_) {
    return;
  }
  const username = u.searchParams.get('username');
  const password = u.searchParams.get('password');
  if (!/\/get\.php$/i.test(u.pathname) || !username || !password) return;
  setTab('xtream');
  document.getElementById('server').value = u.origin;
  document.getElementById('username').value = username;
  document.getElementById('password').value = password;
  updateButtons();
  showToast('This is an Xtream link — filled in the Xtream tab (adds the TV guide). To use it as a playlist, tap M3U', true);
}
document.getElementById('m3uUrl').addEventListener('paste', () => setTimeout(m3uLinkToXtream, 0));
document.getElementById('m3uUrl').addEventListener('change', m3uLinkToXtream);

// 'change' too: browser/password-manager autofill doesn't always fire 'input'
['server', 'username', 'password', 'm3uUrl'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('input', updateButtons);
  el.addEventListener('change', updateButtons);
});

// One request: checks the provider and returns its categories / playlist groups
async function runCheck(body) {
  try {
    const res = await fetch('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.ok) {
      // Server typed without http(s)://: show the address that worked
      if (body.type === 'xtream' && data.server && data.server !== body.server) {
        document.getElementById('server').value = data.server;
        body = { ...body, server: data.server };
      }
      lastCheckKey = JSON.stringify(body);
      applyCategories(data);
    } else {
      lastCheckKey = null;
    }
    return data;
  } catch (_) {
    lastCheckKey = null;
    return { ok: false, error: "Couldn't reach StreamVault — check your internet connection" };
  }
}

function applyCategories(data) {
  const items = data.categories
    ? data.categories.map(c => ({ id: String(c.category_id), name: c.category_name || '' }))
    : (data.groups || []).map(g => ({ id: g.name, name: g.name, count: g.count }));
  allCategories = items.sort((a, b) => a.name.localeCompare(b.name));
  // Keep earlier choices that still exist (e.g. editing an installed setup)
  selectedCategories = new Set([...selectedCategories].filter(id => allCategories.some(c => c.id === id)));
  const show = allCategories.length > 0 ? 'block' : 'none';
  document.getElementById('catSearchWrap').style.display = show;
  document.getElementById('catList').style.display = show;
  document.getElementById('catTools').style.display = allCategories.length > 0 ? 'flex' : 'none';
  document.getElementById('catHint').style.display = allCategories.length > 0 ? 'none' : '';
  renderCategoryList(true);
  renderSelectedTags();
}

// Settings to save for the tested details, or { error } when the selection is too long
function buildInstallSettings(body) {
  if (source === 'xtream') {
    const categoryIds = [...selectedCategories].join(',');
    if (categoryIds.length > 2048) return { error: 'Too many categories selected — pick fewer' };
    return { settings: { t: 'xtream', s: body.server, u: body.username, p: body.password, c: categoryIds } };
  }
  const settings = { t: 'm3u', m: body.m3uUrl, c: '' };
  // Selected group-titles (empty = whole playlist)
  if (selectedCategories.size > 0) {
    const g = JSON.stringify([...selectedCategories]);
    if (g.length > 2048) return { error: 'Too many groups selected — pick fewer' };
    settings.g = g;
  }
  return { settings };
}

// Viewer's timezone so TV guide times show in local time ('' when unknown)
function viewerTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch (_) {
    return ''; // old browser without Intl time zones: the guide uses the provider's times
  }
}

// Result box: "Saved" (same link updated) or the install steps (new link)
function showInstallResult(encData, manifestUrl) {
  const updated = encData.updated === true;
  document.getElementById('resultTitle').textContent = updated ? 'Saved — StreamVault updated' : 'Ready to install';
  document.getElementById('updatedHint').style.display = updated ? 'block' : 'none';
  document.getElementById('restartHint').textContent = savedHint();
  document.getElementById('savedSupport').style.display = updated ? 'block' : 'none';
  for (const id of ['installHints', 'tvTip', 'installSupport']) {
    document.getElementById(id).style.display = updated ? 'none' : '';
  }
  // Open in app = stremio:// link: Stremio, or Nuvio (phones ask which app to use)
  document.getElementById('stremioLink').href = stremioAppLink(manifestUrl);
  document.getElementById('installUrl').value = manifestUrl;
  openResult();
  return updated;
}

// Result pop-up: Esc / × / tap outside closes it; focus goes back to the button
// Result pop-up (native <dialog>): ×, Esc (browser) or a tap on the dimmed
// area closes it; focus goes back to the button
function openResult() {
  const dialog = document.getElementById('result');
  if (dialog.open) return;
  // Very old browsers (iOS Safari < 15.4) have no showModal: show it in place
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  document.documentElement.style.overflow = 'hidden';
}

function closeResult() {
  const dialog = document.getElementById('result');
  if (!dialog.open) return;
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
  resultClosed();
}

// Page scroll and focus back. Called directly and on the dialog's own cancel
// (Esc) / close events, so it doesn't depend on when the browser fires them
function resultClosed() {
  if (document.documentElement.style.overflow !== 'hidden') return;
  document.documentElement.style.overflow = '';
  document.getElementById('btnInstall').focus();
}

const resultDialog = document.getElementById('result');
resultDialog.addEventListener('cancel', resultClosed);
resultDialog.addEventListener('close', resultClosed);
resultDialog.addEventListener('click', (event) => {
  if (event.target === resultDialog) closeResult(); // the backdrop, not the content
});

// How the app picks up saved changes. Stremio keeps its stored copy until the
// addon is installed again: the page opens it (same link → "Update", no second
// StreamVault). Nuvio reads it again on a full restart.
function savedHint() {
  const stremio = ON_PHONE
    ? 'The Stremio phone app has no Upgrade button: tap Open in app, press Uninstall and then Install, then fully close and reopen Stremio.'
    : 'Stremio opens StreamVault — press Upgrade there to load the changes.';
  return `${stremio}\nIn Nuvio: fully close and reopen the app.`;
}

// Phones: the Stremio app's dialog for an installed addon has no Upgrade (the
// desktop app's does) — saving there doesn't open it; the hint says what to do
const ON_PHONE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

// The Stremio app's own link for this install link (opens its addon dialog)
function stremioAppLink(manifestUrl) {
  return manifestUrl.replace(/^https?:\/\//, 'stremio://');
}

// Open the new link in the app (Stremio, or whichever app handles stremio://)
function openInApp(manifestUrl) {
  // Prefetch manifest to warm up server/DNS/TLS, then open the app
  fetch(manifestUrl).finally(() => {
    window.location.href = stremioAppLink(manifestUrl);
  });
}

async function install() {
  const body = getCheckBody();
  if (!body) return;
  // Install is only enabled after these exact details passed the test
  if (lastCheckKey !== JSON.stringify(body)) {
    updateButtons();
    showToast('Test the connection first');
    return;
  }
  const { settings, error } = buildInstallSettings(body);
  if (error) {
    showToast(error);
    return;
  }
  const tz = viewerTimezone();
  if (tz) settings.z = tz;

  const btn = document.getElementById('btnInstall');
  btn.classList.add('loading');
  try {
    // Settings are encrypted and saved server-side under a stable link; when
    // editing an installed StreamVault the same link is updated in place
    const encRes = await fetch('/api/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, ...(editingLink ? { editing: editingLink } : {}), ...(rowsMoved ? { rowsMoved } : {}) })
    });
    const encData = await encRes.json();
    if (encData.error) {
      showToast(encData.error);
      return;
    }
    rowsMoved = ''; // counted once; a second save counts only new moves
    const manifestUrl = `${window.location.origin}/${encData.config}/manifest.json`;
    // Same link, new settings. Stremio on a PC still opens it: only a
    // (re)install replaces the copy it stored (same link → Upgrade, no
    // duplicate). Not on phones (no Upgrade there).
    const updated = showInstallResult(encData, manifestUrl);
    if (!updated || !ON_PHONE) openInApp(manifestUrl);
  } catch (_) {
    showToast('Failed to generate install URL');
  } finally {
    btn.classList.remove('loading');
  }
}

function copyUrl() {
  const input = document.getElementById('installUrl');
  input.select();
  input.setSelectionRange(0, 99999); // mobile
  const done = () => {
    const label = document.getElementById('copyText');
    label.textContent = 'Copied';
    clearTimeout(copyUrl.timer);
    copyUrl.timer = setTimeout(() => { label.textContent = 'Copy'; }, 2000);
  };
  navigator.clipboard.writeText(input.value).then(done).catch(() => {
    document.execCommand('copy');
    done();
  });
}

function togglePassword() {
  const input = document.getElementById('password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  const btn = document.getElementById('pwToggle');
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  btn.setAttribute('aria-pressed', String(show));
  document.getElementById('pwEye').style.display = show ? 'none' : '';
  document.getElementById('pwEyeOff').style.display = show ? '' : 'none';
  input.focus();
}

function showToast(msg, success) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.background = success ? 'var(--green)' : 'var(--red)';
  t.style.color = success ? '#000' : '#fff';
  t.classList.add('show');
  // Longer messages (e.g. with account info) stay up long enough to read
  setTimeout(() => t.classList.remove('show'), Math.max(2500, msg.length * 60));
}

// Normalised { id, name, count? }: Xtream id = category_id, M3U id = group-title
let allCategories = [];
let selectedCategories = new Set();

// Background check for an installed setup opened from an app's Configure:
// loads the category list (saved choices ticked) and unlocks Install
async function loadCategories() {
  const body = getCheckBody(true);
  if (!body) return;
  checking = true;
  updateButtons();
  try {
    const data = await runCheck(body);
    if (!data.ok) showToast(data.error || "Couldn't load your categories");
  } finally {
    checking = false;
    updateButtons();
  }
}

// Category search: every typed word must appear in the name, in any order,
// ignoring case, accents, brackets and punctuation ("uk ppv" and "ppv uk" find
// "[UK] NORTH PPV"; a plain substring search needed the exact "uk] north ppv")
const searchWords = (text) => String(text).toLowerCase().normalize('NFD')
  .replace(/\p{M}/gu, '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
function categoryMatcher() {
  const words = searchWords(document.getElementById('catSearch').value || '');
  return (c) => {
    const nameWords = searchWords(c.name);
    return words.every(w => nameWords.some(n => n.includes(w)));
  };
}

// Select all = exactly what the search currently shows: it replaces the
// selection, so a new search + Select all doesn't keep the previous results
function selectAllCategories() {
  const matches = categoryMatcher();
  selectedCategories = new Set(allCategories.filter(matches).map(c => c.id));
  renderCategoryList(true);
  renderSelectedTags();
}

function clearCategories() {
  selectedCategories.clear();
  renderCategoryList(true);
  renderSelectedTags();
}

// Ticked categories are listed first (in home-row order), then the rest A–Z.
// The order is fixed when the list is built (categories loaded, an installed
// setup opened for editing, search typed or cleared, Select all / Clear), never
// on a tap: a category jumping to the top under the finger would make the next
// tap hit a different one. Ticking just marks it where it is.
let pinnedIds = [];
function renderCategoryList(rebuild) {
  if (rebuild) pinnedIds = [...selectedCategories];
  const list = document.getElementById('catList');
  const matches = categoryMatcher();
  const pinned = pinnedIds.map(id => allCategories.find(c => c.id === id)).filter(c => c && matches(c));
  const pinnedSet = new Set(pinned.map(c => c.id));
  const rest = allCategories.filter(c => matches(c) && !pinnedSet.has(c.id));

  list.innerHTML = '';
  if (pinned.length && rest.length) {
    // thin line between the ticked block and the rest (decorative)
    const line = document.createElement('div');
    line.className = 'cat-split';
    line.setAttribute('aria-hidden', 'true');
    rest.unshift(line);
  }
  [...pinned, ...rest].forEach(cat => {
    if (cat instanceof HTMLElement) { list.appendChild(cat); return; }
    const div = document.createElement('div');
    div.className = 'cat-item' + (selectedCategories.has(cat.id) ? ' selected' : '');
    div.onclick = () => toggleCategory(cat.id);

    const check = document.createElement('span');
    check.className = 'cat-check';

    const label = document.createElement('span');
    label.textContent = cat.count ? `${cat.name} (${cat.count})` : cat.name;

    div.appendChild(check);
    div.appendChild(label);
    list.appendChild(div);
  });
  // A re-sort puts the ticked ones first; without this the list stayed scrolled
  // where it was (e.g. after clearing the search) and they were out of view
  if (rebuild) list.scrollTop = 0;
}

function toggleCategory(id) {
  if (selectedCategories.has(id)) {
    selectedCategories.delete(id);
  } else {
    selectedCategories.add(id);
  }
  renderCategoryList();
  renderSelectedTags();
}

// Same as MAX_CATEGORY_ROWS in addon.js: the first 8 picked categories become
// home-screen rows; the rest are only in Discover's category dropdown
const MAX_HOME_ROWS = 8;
const categoryName = (id) => (allCategories.find(c => c.id === id) || {}).name || id;

function renderSelectedTags(focus) {
  const container = document.getElementById('catSelected');
  container.innerHTML = '';
  document.getElementById('catCount').textContent = selectedCategories.size > 0
    ? `${selectedCategories.size} of ${allCategories.length} selected`
    : `None selected — all ${allCategories.length} will show`;
  if (selectedCategories.size === 0) return;
  if (selectedCategories.size === 1) {
    const [id] = selectedCategories;
    const tag = document.createElement('span');
    tag.className = 'cat-tag';
    tag.textContent = categoryName(id) + ' ';
    const remove = document.createElement('span');
    remove.className = 'remove-tag';
    remove.textContent = '×';
    remove.onclick = () => removeCategory(id);
    tag.appendChild(remove);
    container.appendChild(tag);
    return;
  }
  // Two or more: the order decides the home rows (and the channel order), so
  // show it as a list that can be reordered
  const hint = document.createElement('p');
  hint.className = 'row-hint';
  hint.textContent = `Your home rows: the first ${MAX_HOME_ROWS} become rows on the app's home screen, in this order.`;
  container.appendChild(hint);
  const list = document.createElement('ol');
  list.className = 'row-list';
  const order = [...selectedCategories];
  order.forEach((id, i) => {
    if (i === MAX_HOME_ROWS) {
      const divider = document.createElement('li');
      divider.className = 'row-divider';
      divider.textContent = 'Below: no home row, still in the category filter';
      list.appendChild(divider);
    }
    const name = categoryName(id);
    const item = document.createElement('li');
    item.className = 'row-item' + (i < MAX_HOME_ROWS ? '' : ' row-extra');
    item.dataset.id = id;
    const num = document.createElement('span');
    num.className = 'row-num';
    num.textContent = i + 1;
    const label = document.createElement('span');
    label.className = 'row-name';
    label.textContent = name;
    item.append(num, label,
      rowButton('⤒', 'top', `Move ${name} to the top`, i === 0, () => moveCategory(id, -i, 'down', true)),
      rowButton('↑', 'up', `Move ${name} up`, i === 0, () => moveCategory(id, -1, 'up')),
      rowButton('↓', 'down', `Move ${name} down`, i === order.length - 1, () => moveCategory(id, 1, 'down')),
      rowButton('×', 'remove', `Remove ${name}`, false, () => removeCategory(id)));
    list.appendChild(item);
  });
  container.appendChild(list);
  // Keep keyboard focus on the moved category's button so it can be pressed again
  if (focus) {
    const item = [...list.querySelectorAll('.row-item')].find(el => el.dataset.id === focus.id);
    const btn = item && item.querySelector(`[data-dir="${focus.dir}"]`);
    if (btn && !btn.disabled) btn.focus();
  }
}

function rowButton(text, dir, label, disabled, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'row-btn';
  b.textContent = text;
  b.dataset.dir = dir;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.disabled = disabled;
  b.onclick = onClick;
  return b;
}

// Move by delta places (to the top: delta = -position); the Set keeps
// insertion order, so rebuild it. Screen readers hear the new position.
// Whether this visit reordered the rows ("top" if Move to the top was used):
// sent with Install / Save changes only to be counted, never saved
let rowsMoved = '';
function moveCategory(id, delta, dir, toTop) {
  const order = [...selectedCategories];
  const i = order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return;
  rowsMoved = toTop || rowsMoved === 'top' ? 'top' : 'yes';
  order.splice(j, 0, ...order.splice(i, 1));
  selectedCategories = new Set(order);
  renderSelectedTags({ id, dir });
  document.getElementById('rowLive').textContent =
    `${categoryName(id)}: now ${j + 1} of ${order.length}${j < MAX_HOME_ROWS ? '' : ', no home row'}`;
}

function removeCategory(id) {
  selectedCategories.delete(id);
  renderCategoryList();
  renderSelectedTags();
}

function filterCategories() {
  renderCategoryList(true);
}

async function testConnection() {
  const btn = document.getElementById('btnTest');
  const btnText = document.getElementById('btnTestText');
  checking = true;
  updateButtons();
  btn.className = 'btn-test';
  btnText.textContent = 'Testing...';

  try {
    const body = getCheckBody();
    if (!body) return;

    // Also fills the category list, so "Load Categories" isn't needed after a test
    const data = await runCheck(body);
    document.getElementById('reportHint').hidden = data.ok;
    if (data.ok) {
      // The button swaps to "Install" (updateButtons in finally)
      showToast(data.account ? `${data.message} ${data.account}` : data.message, true);
    } else {
      btn.classList.add('error');
      btnText.textContent = 'Connection failed';
      showToast(data.error || 'Connection failed');
    }
  } catch (e) {
    document.getElementById('reportHint').hidden = false;
    btn.classList.add('error');
    btnText.textContent = 'Connection failed';
    showToast('Connection failed: ' + e.message);
  } finally {
    checking = false;
    updateButtons();
    setTimeout(() => {
      btn.className = 'btn-test';
      btnText.textContent = 'Test Connection';
    }, 4000);
  }
}

function isValidUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false; // not parseable as a URL
  }
}

// Opened from Stremio's "Configure" on an installed addon (/<config>/configure):
// fill in the saved details and categories so nothing has to be retyped
(async function prefillInstalledSetup() {
  const match = window.location.pathname.match(/^\/([^/]+)\/configure\/?$/);
  if (!match) return;
  editingLink = decodeURIComponent(match[1]);
  try {
    const res = await fetch(`/api/config/${encodeURIComponent(match[1])}`);
    if (!res.ok) return;
    const cfg = await res.json();
    setTab(cfg.type);
    if (cfg.type === 'xtream') {
      document.getElementById('server').value = cfg.server || '';
      document.getElementById('username').value = cfg.username || '';
      document.getElementById('password').value = cfg.password || '';
    } else {
      document.getElementById('m3uUrl').value = cfg.m3uUrl || '';
    }
    selectedCategories = new Set((cfg.categories || []).map(String));
    updateButtons();
    // Editing an installed StreamVault: saving updates it in place, nothing to install
    document.getElementById('btnInstallText').textContent = 'Save changes';
    showToast('Your installed setup is loaded — change it and press Save changes', true);
    // Test right away: loads the category list (saved choices ticked) and unlocks Install
    loadCategories();
  } catch (_) {
    editingLink = ''; // couldn't load the installed setup: behave like a fresh setup
  }
})();

updateButtons();
