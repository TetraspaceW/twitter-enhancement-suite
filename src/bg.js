// Background: opens the settings page from the toolbar button and syncs block reasons
// between browsers through one secret GitHub gist (optionally encrypted with a passphrase).
if (typeof importScripts === 'function') importScripts('lib.js'); // Chromium service worker; Firefox loads it via the manifest

const { api } = TES;
const FILE = 'twitter-enhancement-suite.json';

api.action.onClicked.addListener(() => api.runtime.openOptionsPage());

const schedule = () => api.alarms.create('sync', { periodInMinutes: 30 });
api.runtime.onInstalled.addListener(schedule);
api.runtime.onStartup.addListener(() => { schedule(); sync(); });
api.alarms.onAlarm.addListener(a => a.name.startsWith('sync') && sync());

// Push soon after any reason (or the reason list) changes.
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.entries(changes).some(([k, c]) => TES.needsSync(k, c))) api.alarms.create('sync-soon', { delayInMinutes: 0.5 });
});

api.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'sync') return;
  sync().then(reply);
  return true;
});

let running = null;
function sync() {
  return running ??= run().then(
    r => ({ ok: true, ...r }),
    e => ({ ok: false, error: e.message || String(e) }),
  ).then(async r => {
    running = null;
    if (!r.skipped) await api.storage.local.set({ syncStatus: { at: Date.now(), ...r } });
    return r;
  });
}

async function run() {
  const all = await api.storage.local.get(null);
  const s = { ...TES.DEFAULTS, ...all.settings };
  if (!s.gistToken) return { skipped: true };

  const gh = async (path, init = {}) => {
    const r = await fetch('https://api.github.com' + path, {
      ...init,
      headers: { authorization: 'Bearer ' + s.gistToken, accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw Object.assign(new Error(`GitHub said ${r.status}: ${(await r.text()).slice(0, 140)}`), { status: r.status });
    return r.json();
  };

  let gist = s.gistId ? await gh('/gists/' + s.gistId).catch(e => { if (e.status !== 404) throw e; }) : null;
  for (let page = 1; !gist && page <= 10; page++) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const found = list.find(g => g.files[FILE]);
    if (found) gist = await gh('/gists/' + found.id);
    if (list.length < 100) break;
  }

  let remote = { users: {}, reasons: null, rt: 0 };
  if (gist) {
    const f = gist.files[FILE];
    remote = await decode(f.truncated ? await (await fetch(f.raw_url)).text() : f.content, s.passphrase);
    remote.rt ??= 0;
  }

  const local = {};
  for (const [k, r] of Object.entries(all)) {
    if (k.startsWith('u:') && r.t > 0) local[r.id] = { sn: r.sn, nm: r.nm, b: r.b, tags: r.tags, note: r.note, src: r.src, t: r.t };
  }
  const { merged, toLocal, dirty } = TES.merge(local, remote.users ?? {});
  if (toLocal.length) await TES.commit(toLocal.map(r => ({ ...all['u:' + r.id], ...r })));

  let { reasons, rt } = s;
  const pullReasons = remote.rt > rt;
  if (pullReasons) ({ reasons, rt } = remote);

  if (!gist || dirty || remote.rt < rt) {
    const content = await encode({ v: 1, reasons, rt, users: merged }, s.passphrase);
    const body = JSON.stringify({
      description: 'Twitter Enhancement Suite: block reasons',
      public: false,
      files: { [FILE]: { content } },
    });
    gist = await gh(gist ? '/gists/' + gist.id : '/gists', { method: gist ? 'PATCH' : 'POST', body });
  }
  if (pullReasons || gist.id !== s.gistId) {
    // Re-read so we don't clobber an edit made while we were talking to GitHub.
    const fresh = await TES.getSettings();
    await api.storage.local.set({ settings: { ...fresh, gistId: gist.id, ...(pullReasons && { reasons, rt }) } });
  }
  return { pulled: toLocal.length, pushed: dirty };
}

// ---- optional end-to-end encryption of the gist ----

const b64 = u8 => {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function key(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function encode(data, passphrase) {
  const text = JSON.stringify(data);
  if (!passphrase) return text;
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(passphrase, salt), new TextEncoder().encode(text));
  return JSON.stringify({ salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) });
}

async function decode(text, passphrase) {
  const d = JSON.parse(text);
  if (!d.ct) return d;
  if (!passphrase) throw new Error('The sync gist is encrypted: enter the passphrase.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(d.iv) }, await key(passphrase, unb64(d.salt)), unb64(d.ct))
    .catch(() => { throw new Error('Wrong sync passphrase.'); });
  return JSON.parse(new TextDecoder().decode(pt));
}
