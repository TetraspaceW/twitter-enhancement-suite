// Content script (isolated world). Keeps the local DB of blocked users and block reasons
// up to date from what page.js sees, asks for a reason when you block someone, draws reason
// badges, and adds the scan / mass-unblock panel to the blocked accounts page.
const { api, hasReason, keep, extractUsers, restUser, bottomCursor, waitMs } = TES;

const db = new Map();  // user id -> record (see lib.js)
const ids = new Map(); // lowercase screen name -> user id
let counts = null;     // { blocked, reasoned } for the panel; recomputed after the DB changes
let settings = TES.DEFAULTS;
let ulog = [];         // times of recent unblock attempts, shared across tabs for rate limiting
let scannedAt = 0;

function index(r) {
  const old = db.get(r.id);
  if (old && old.sn !== r.sn && ids.get(old.sn.toLowerCase()) === r.id) ids.delete(old.sn.toLowerCase());
  db.set(r.id, r);
  ids.set(r.sn.toLowerCase(), r.id);
  counts = null;
}

function unindex(id) {
  const old = db.get(id);
  if (!old) return;
  db.delete(id);
  if (ids.get(old.sn.toLowerCase()) === id) ids.delete(old.sn.toLowerCase());
  counts = null;
}

api.storage.local.get(null).then(all => {
  for (const [k, v] of Object.entries(all)) if (k.startsWith('u:')) index(v);
  settings = { ...TES.DEFAULTS, ...all.settings };
  ulog = all.ulog ?? [];
  scannedAt = all.scannedAt ?? 0;
  schedule();
});

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let redraw = false;
  for (const [k, { newValue }] of Object.entries(changes)) {
    if (k === 'ulog') { ulog = newValue ?? []; continue; }
    if (k.startsWith('u:')) newValue ? index(newValue) : unindex(k.slice(2));
    else if (k === 'settings') settings = { ...TES.DEFAULTS, ...newValue };
    else if (k === 'scannedAt') scannedAt = newValue ?? 0;
    else continue;
    redraw = true;
  }
  if (redraw) schedule();
});

function save(recs) {
  if (!recs.length) return;
  for (const r of recs) keep(r) ? index(r) : unindex(r.id);
  TES.commit(recs);
  schedule();
}

// Fold freshly seen users into the DB. `blocked` overrides what the user objects say.
function observe(users, blocked) {
  const out = [];
  for (const u of users) {
    const old = db.get(u.id);
    const b = +(blocked ?? u.blocking ?? !!old?.b);
    if (!old && !b) continue;
    const r = { tags: [], note: '', t: 0, ...old, id: u.id, sn: u.sn, nm: u.nm, b };
    if (old && old.b !== b && hasReason(r)) r.t = Date.now();
    if (!old || old.sn !== r.sn || old.nm !== r.nm || old.b !== b) out.push(r);
  }
  save(out);
}

function logUnblock() {
  const now = Date.now(), longest = Math.max(...settings.limits.map(l => l[1]));
  ulog = [...ulog.filter(t => t > now - longest), now];
  api.storage.local.set({ ulog });
}

// ---- what X's own client does (reported by page.js) ----

const seen = new Set(); // everyone X has listed as blocked in this tab
let lastList = null;    // X's latest page of the block list
const waiters = [];

// Resolves with X's next `op` response, or null after `ms`.
function next(op, ms) {
  return new Promise(resolve => {
    const w = { op, resolve };
    waiters.push(w);
    setTimeout(() => waiters.includes(w) && (waiters.splice(waiters.indexOf(w), 1), resolve(null)), ms);
  });
}

// The tweet whose ⋯ menu was opened last: blocking its author from that menu links the block to it.
let menuTweet = null; // { sn, url, at }
document.addEventListener('click', e => {
  const t = e.target;
  if (t.closest?.('[data-testid="userActions"]')) menuTweet = null; // the profile page's ⋯ menu
  const article = t.closest?.('[data-testid="caret"]')?.closest('article');
  // The first timestamp in a tweet links to the tweet itself (later ones belong to quoted tweets).
  const url = article?.querySelector('time')?.closest('a[href*="/status/"]')?.getAttribute('href');
  const sn = article && handleLink(article.querySelector('[data-testid="User-Name"]') ?? article)?.textContent.slice(1);
  if (url && sn) menuTweet = { sn, url, at: Date.now() };
}, true);

window.addEventListener('message', e => {
  if (e.data?.tes !== 'page') return;
  const { op, status, reset, body } = e.data;
  let json = null;
  try { json = JSON.parse(body); } catch {}
  const d = { op, status, reset, json };
  if (op === 'destroy') logUnblock();
  if (status === 200 && op === 'BlockedAccountsAll') {
    d.users = extractUsers(json);
    d.end = !d.users.length || !bottomCursor(json);
    d.users.forEach(u => seen.add(u.id));
    observe(d.users, true);
  } else if (status === 200 && op === 'UserByScreenName') {
    observe(extractUsers(json));
  } else if (status === 200) {
    const u = restUser(json);
    if (u) observe([u], op === 'create');
    if (u && op === 'create') {
      const tw = menuTweet;
      if (tw && tw.sn.toLowerCase() === u.sn.toLowerCase() && Date.now() - tw.at < 120e3) save([{ ...db.get(u.id), src: tw.url }]);
      if (!hasReason(db.get(u.id)) && job?.kind !== 'unblock') edit(u.id, true);
    }
  }
  if (op === 'BlockedAccountsAll') lastList = d;
  for (const w of waiters.filter(w => w.op === op)) {
    waiters.splice(waiters.indexOf(w), 1);
    w.resolve(d);
  }
});

// ---- UI helpers ----

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) k.startsWith('on') ? el.addEventListener(k.slice(2), v) : (el[k] = v);
  el.append(...kids);
  return el;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const soon = (min, max) => Date.now() + min + Math.random() * (max - min); // a human-ish moment from now
const clock = ms => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function duration(ms) {
  const m = Math.ceil(ms / 60e3);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ---- reason editor ----

function edit(id, justBlocked) {
  const r = db.get(id);
  if (!r || !document.body) return;
  document.querySelector('.tes-sheet')?.remove();
  const chosen = new Set(r.tags);
  const chips = new Map(); // reason -> its chip
  const chip = tag => {
    const el = h('button', {
      type: 'button',
      className: 'tes-chip' + (chosen.has(tag) ? ' on' : ''),
      textContent: tag,
      onclick() {
        if (chosen.has(tag)) chosen.delete(tag);
        else chosen.add(tag);
        el.classList.toggle('on', chosen.has(tag));
      },
    });
    chips.set(tag, el);
    return el;
  };
  // Your own reason becomes a chosen chip on Enter (or on Save).
  const custom = h('input', {
    className: 'tes-custom',
    placeholder: '+ your own reason',
    enterKeyHint: 'done',
    onkeydown(e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      addCustom();
    },
  });
  function addCustom() {
    const tag = custom.value.trim();
    custom.value = '';
    if (!tag) return;
    chosen.add(tag);
    if (chips.has(tag)) chips.get(tag).classList.add('on');
    else custom.before(chip(tag));
  }
  const note = h('textarea', { placeholder: 'Note (optional)', value: r.note });
  const close = () => sheet.remove();
  const sheet = h('div', {
    className: 'tes-sheet',
    onclick: e => e.target === sheet && close(),
    onkeydown(e) {
      e.stopPropagation(); // keep X's keyboard shortcuts out of the note field
      if (e.key === 'Escape') close();
    },
  }, h('div', { className: 'tes-card' },
    h('div', { className: 'tes-title', textContent: `${justBlocked ? 'Blocked' : 'Why you blocked'} @${r.sn}` }),
    ...(r.src ? [h('a', { className: 'tes-src', href: r.src, target: '_blank', textContent: 'The tweet you blocked them over ↗' })] : []),
    h('div', { className: 'tes-chips' }, ...[...new Set([...settings.reasons, ...r.tags])].map(chip), custom),
    note,
    h('div', { className: 'tes-row' },
      h('button', { type: 'button', textContent: justBlocked ? 'No reason' : 'Cancel', onclick: close }),
      h('button', {
        type: 'button',
        className: 'tes-primary',
        textContent: 'Save',
        async onclick() {
          addCustom();
          const tags = [...chosen];
          save([{ ...db.get(id), tags, note: note.value.trim(), t: Date.now() }]);
          close();
          // Offer new reasons next time too (they can be pruned in the settings).
          const s = await TES.getSettings();
          const added = tags.filter(t => !s.reasons.includes(t));
          if (added.length) api.storage.local.set({ settings: { ...s, reasons: [...s.reasons, ...added], rt: Date.now() } });
        },
      }))));
  document.body.append(sheet);
}

// ---- badges ----

let timer = 0;
function schedule() {
  timer ||= setTimeout(() => { timer = 0; render(); }, 200);
}
new MutationObserver(schedule).observe(document, { childList: true, subtree: true });

const handleLink = el => [...el.querySelectorAll('a[href^="/"]')].find(a => a.textContent.startsWith('@'));

function render() {
  // Tweets: User-Name is a row of [name, @handle · time]; the badge goes on the end.
  for (const el of document.querySelectorAll('[data-testid="User-Name"]')) {
    badge(el, handleLink(el)?.textContent.slice(1), el);
  }
  // User lists, including the blocked accounts page: badge under the @handle.
  for (const el of document.querySelectorAll('[data-testid="UserCell"]')) {
    const a = handleLink(el);
    if (a) badge(el, a.textContent.slice(1), a.parentElement.parentElement);
  }
  // Profile header.
  const profile = document.querySelector('[data-testid="UserName"]');
  if (profile) badge(profile, location.pathname.split('/')[1], profile);
  panel();
}

function badge(host, handle, parent) {
  const r = handle && db.get(ids.get(handle.toLowerCase()));
  const key = r ? [r.id, r.b, r.t, r.src].join() : '';
  const pill = host.querySelector('.tes-pill');
  if (host.dataset.tes === key && !!pill === !!r) return;
  host.dataset.tes = key;
  pill?.remove();
  if (!r) return;
  const reason = [...r.tags, r.note].filter(Boolean).join(' · ');
  parent.append(h('span', {
    className: 'tes-pill' + (!r.b ? ' was' : reason ? '' : ' none'),
    title: reason ? `Blocked: ${reason}\n(click to edit)` : 'Blocked with no reason (click to add one)',
    onclick(e) {
      e.preventDefault();
      e.stopPropagation();
      edit(r.id);
    },
  },
  h('span', { className: 'tes-why', textContent: (r.b ? '🚫 ' : 'was blocked: ') + (reason || 'no reason') }),
  ...(r.src ? [h('a', {
    className: 'tes-src',
    href: r.src,
    textContent: '↗',
    title: 'The tweet you blocked them over',
    onclick: e => e.stopPropagation(), // follow the link, don't open the editor or the surrounding tweet
  })] : [])));
}

// ---- blocked accounts page: scan + mass unblock ----

let job = null; // { kind: 'scan' | 'unblock', done, total, msg, stop }
let lastMsg = ''; // outcome of the last job, shown once it's over
let ui = null;
let armed = 0;  // when the unblock button was first clicked (it needs a second click)

function panel() {
  const show = job || location.pathname.startsWith('/settings/blocked');
  if (!show) return ui?.root.remove();
  if (!ui) {
    ui = {};
    ui.root = h('div', { className: 'tes-panel' },
      h('div', { className: 'tes-title', textContent: 'Block reasons' }),
      ui.stats = h('div'),
      ui.bar = h('progress', { hidden: true }),
      ui.msg = h('div', { className: 'tes-msg' }),
      h('div', { className: 'tes-row' },
        ui.scan = h('button', { type: 'button', textContent: 'Scan block list', onclick: () => scan() }),
        ui.unblock = h('button', { type: 'button', className: 'tes-primary', onclick: () => unblockClicked() }),
        ui.stop = h('button', { type: 'button', textContent: 'Stop', hidden: true, onclick: () => job && (job.stop = true) })));
  }
  if (!ui.root.isConnected && document.body) document.body.append(ui.root);
  paint();
}

const unreasoned = skip => [...db.values()].filter(r => r.b && !hasReason(r) && !skip?.has(r.id));

// Only touch the DOM when something changed: our own mutations would otherwise re-trigger render().
const set = (el, k, v) => el[k] !== v && (el[k] = v);

function paint() {
  if (!ui) return;
  if (!counts) {
    counts = { blocked: 0, reasoned: 0 };
    for (const r of db.values()) if (r.b) { counts.blocked++; if (hasReason(r)) counts.reasoned++; }
  }
  const { blocked, reasoned } = counts, without = blocked - reasoned;
  set(ui.stats, 'textContent', `${blocked} blocked · ${reasoned} with a reason · ${without} without` +
    (scannedAt ? ` · scanned ${new Date(scannedAt).toLocaleDateString()}` : ''));
  set(ui.bar, 'hidden', job?.kind !== 'unblock');
  if (job) { set(ui.bar, 'max', job.total || 1); set(ui.bar, 'value', job.done); }
  set(ui.msg, 'textContent', job?.msg || lastMsg ||
    (scannedAt ? '' : 'Not fully scanned yet: unblocking picks up the rest as it works down the list.'));
  set(ui.scan, 'hidden', !!job);
  set(ui.unblock, 'hidden', !!job);
  set(ui.stop, 'hidden', !job);
  // Before a full scan there may be more further down than we know of: hence the "+".
  const n = without + (scannedAt ? '' : '+');
  set(ui.unblock, 'disabled', !without && !!scannedAt);
  set(ui.unblock, 'textContent', Date.now() - armed < 5e3
    ? `Really unblock ${n}? (takes ≈${eta(without)}${scannedAt ? '' : ' or more'})`
    : `Unblock ${n} without a reason`);
}

// At the long-window rate, how long n unblocks take.
function eta(n) {
  const [max, win] = settings.limits.at(-1);
  return duration(n / max * win);
}

function unblockClicked() {
  if (Date.now() - armed < 5e3) { armed = 0; unblockAll(); return; }
  armed = Date.now();
  paint();
  setTimeout(paint, 5e3);
}

function say(msg) {
  if (job) job.msg = msg;
  else lastMsg = msg;
  paint();
}

// Sleep until `until`, waking every second so Stop stays responsive.
async function pause(until) {
  while (!job.stop && Date.now() < until) await sleep(Math.min(until - Date.now(), 1e3));
}

// Only one tab at a time may run a job, or the rate limiting falls apart. The lock lives in
// x.com's localStorage (shared by all X tabs) so its heartbeat doesn't wake the rest of the extension.
const tabId = Math.random().toString(36).slice(2);
const LOCK = 'tes-job-lock';
function lock() {
  const l = JSON.parse(localStorage.getItem(LOCK) || 'null');
  if (l && l.tab !== tabId && l.until > Date.now()) return false;
  localStorage.setItem(LOCK, JSON.stringify({ tab: tabId, until: Date.now() + 30e3 }));
  return true;
}

async function begin(kind) {
  if (job) return false;
  job = { kind, done: 0, total: 0, msg: 'Starting…', stop: false };
  lastMsg = '';
  paint();
  if (!lock()) {
    job = null;
    say('Another X tab is already scanning or unblocking.');
    return false;
  }
  const beat = setInterval(lock, 10e3);
  job.end = msg => {
    clearInterval(beat);
    localStorage.removeItem(LOCK);
    job = null;
    say(msg);
  };
  return true;
}

const onBlockedPage = () => location.pathname.startsWith('/settings/blocked/all');

// Scroll the block list at a reading pace and let X's own client load each page;
// the message listener records what it loads.
async function scan() {
  if (!onBlockedPage()) return say('Open the “All” tab of your blocked accounts first.');
  if (!(await begin('scan'))) return;
  let quiet = 0;
  while (!job.stop && onBlockedPage()) {
    say(`Found ${seen.size} blocked accounts so far…`);
    const page = next('BlockedAccountsAll', 10e3);
    window.scrollTo(0, document.documentElement.scrollHeight);
    const res = await page;
    if (!res) {
      if (++quiet >= 3) break; // X isn't loading any more
      continue;
    }
    quiet = 0;
    if (res.status !== 200 || res.end) break;
    await pause(soon(2e3, 5e3));
  }
  if (job.stop || !onBlockedPage()) return job.end('Scan stopped. What it found is kept.');
  if (lastList?.status === 429) return job.end(`X rate-limited the scan; try again after ${clock(lastList.reset || Date.now() + 15 * 60e3)}.`);
  if (!listDone()) {
    return job.end('X stopped loading the list before the end (if the page says “Something went wrong”, X is rate-limiting you). Try again in 15 minutes or so.');
  }
  job.end(`Scan complete: ${seen.size} blocked accounts.`);
}

// Once X has served the whole list in this tab, mark the scan done. Anyone we thought was
// blocked but X didn't list was unblocked somewhere we couldn't see.
function listDone() {
  if (!lastList?.end || !seen.size) return false;
  const now = Date.now(), gone = [];
  for (const r of db.values()) {
    if (r.b && !seen.has(r.id)) gone.push({ ...r, b: 0, t: hasReason(r) ? now : r.t });
  }
  save(gone);
  scannedAt = now;
  api.storage.local.set({ scannedAt });
  return true;
}

// A row's unblock button: its only button (X gives it no test id on this page).
function rowButton(cell) {
  const buttons = cell.querySelectorAll('button');
  return buttons.length === 1 ? buttons[0] : null;
}

const rowUser = cell => db.get(ids.get(handleLink(cell)?.textContent.slice(1).toLowerCase()));

// A row on screen whose account is blocked without a reason and hasn't been tried this run.
function dueRow(tried) {
  for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
    const r = rowUser(cell);
    if (r?.b && !hasReason(r) && !tried.has(r.id) && rowButton(cell)) return { cell, r };
  }
  return null;
}

// Click X's own unblock buttons down the list, at your measured pace plus some randomness.
async function unblockAll() {
  if (!onBlockedPage()) return say('Open the “All” tab of your blocked accounts first.');
  if (!(await begin('unblock'))) return;
  // Pull reasons from other devices first so we never unblock someone you tagged elsewhere.
  if (settings.gistToken) {
    say('Syncing reasons from your other devices…');
    const res = await api.runtime.sendMessage({ type: 'sync' }).catch(e => ({ error: e.message }));
    if (!res?.ok) return job.end(`Sync failed, so nothing was unblocked: ${res?.error}`);
  }
  const tried = new Set(); // one click per account per run: a second click on the toggle would re-block
  let fails = 0, pauseUntil = 0, bottom = 0;
  window.scrollTo(0, 0);
  // Runs to the end of the list rather than until the known accounts run out:
  // before a full scan, more turn up as X loads further pages.
  while (!job.stop && onBlockedPage()) {
    const left = unreasoned(tried).length;
    job.total = job.done + left;
    const progress = `${job.done} of ${job.total}${scannedAt ? '' : '+'} unblocked`;
    const now = Date.now(), limited = waitMs(ulog, now, settings.limits), wait = Math.max(limited, pauseUntil - now);
    if (wait > 0) {
      // A long wait is either X refusing (429) or the pacing limit, which counts earlier runs too.
      const [n, win] = settings.limits.at(-1);
      const why = pauseUntil - now >= limited ? 'X refused the last one'
        : `${ulog.filter(t => t > now - win).length} of ${n} unblocks per ${win / 60e3} min used, earlier runs included`;
      say(`${progress} · ` +
        (wait > 90e3 ? `paused until ${clock(now + wait)} (${why})` : `next in ${Math.ceil(wait / 1e3)} s`) +
        ` · ≈${eta(left)} to go`);
      await pause(Date.now() + Math.min(wait, 1e3));
      continue;
    }
    const row = dueRow(tried);
    if (!row) {
      // Nobody due on screen: scroll on and let X load more of the list.
      const atBottom = innerHeight + scrollY >= document.documentElement.scrollHeight - 100;
      bottom = atBottom ? bottom + 1 : 0;
      if (bottom >= 4) break;
      say(`${progress} · looking further down the list…`);
      window.scrollBy(0, innerHeight * (0.5 + Math.random() * 0.5));
      await pause(soon(1500, 3500));
      continue;
    }
    bottom = 0;
    const { cell, r } = row;
    cell.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await pause(soon(700, 2000));
    // X recycles rows as you scroll: make sure this one still shows the same person.
    if (job.stop || rowUser(cell) !== db.get(r.id) || !rowButton(cell)) continue;
    tried.add(r.id);
    say(`Unblocking @${r.sn}…`);
    const reply = next('destroy', 10e3);
    rowButton(cell).click();
    await sleep(600);
    document.querySelector('[data-testid="confirmationSheetConfirm"]')?.click(); // in case X asks first
    const res = await reply;
    if (res?.status === 200) {
      job.done++;
      fails = 0;
      pauseUntil = soon(1e3, 5e3);
      continue;
    }
    // X answers 404 once the short-window limit trips and 429 for the long one.
    pauseUntil = res?.status === 429 ? res.reset || Date.now() + 15 * 60e3 : Date.now() + 60e3;
    if (++fails >= 5) {
      return job.end(res
        ? `Stopped: X refused ${fails} unblocks in a row (HTTP ${res.status}).`
        : 'Stopped: clicking X’s Blocked button isn’t doing anything. X may have changed the page.');
    }
    say(`X said ${res ? 'HTTP ' + res.status : 'nothing'} for @${r.sn}; waiting until ${clock(pauseUntil)}`);
  }
  const failed = tried.size - job.done;
  const outcome = job.stop || !onBlockedPage() ? 'Stopped'
    : listDone() ? 'Done'
    : 'X stopped loading the list partway; run it again later to carry on';
  job.end(`${outcome}: unblocked ${job.done}.` +
    (failed ? ` ${failed} didn’t go through; run it again later to retry them.` : ''));
}
