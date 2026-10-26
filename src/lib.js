// Shared by the content script, background and options page (exposed as globalThis.TES).
//
// A user record, stored under "u:<id>":
//   { id, sn: screen name, nm: display name, b: 1 if currently blocked,
//     tags: [reason, ...], note: free text, src: path of the tweet they were blocked from (if any),
//     t: ms when tags/note/b last changed (0 = never had a reason) }
(() => {
  const api = globalThis.browser ?? globalThis.chrome;

  const DEFAULTS = {
    reasons: [
      'said doxxing is acceptable',
      'wants offline harm',
      'kinda sus, maybe changed',
      'harassment',
      'spam / bot',
    ],
    rt: 0, // when the reasons list was last edited, for sync
    // [max unblocks, per ms]. X's web limits measure at ~10/45s (then 404s) and ~50/15min (then 429s).
    limits: [[9, 45e3], [48, 15 * 60e3]],
    gistToken: '',
    gistId: '',
    passphrase: '',
  };

  const hasReason = r => !!(r && (r.tags?.length || r.note));
  // Records worth keeping locally: blocked users, plus anyone who ever had a reason (so cleared reasons sync).
  const keep = r => !!(r.b || r.t > 0);

  async function getSettings() {
    return { ...DEFAULTS, ...(await api.storage.local.get('settings')).settings };
  }

  // Write records, dropping the ones no longer worth keeping.
  function commit(recs) {
    const set = {}, del = [];
    for (const r of recs) keep(r) ? (set['u:' + r.id] = r) : del.push('u:' + r.id);
    return Promise.all([api.storage.local.set(set), del.length && api.storage.local.remove(del)]);
  }

  // Firefox asks the user before an add-on sends data out of the browser (data_collection_permissions in
  // build.mjs); gist sync is the only thing that does. Chromium has no such consent, so nothing to ask there.
  const sends = () => api.runtime.getManifest().browser_specific_settings?.gecko?.data_collection_permissions?.optional ?? [];
  // Call straight from a click, before any await: Firefox only shows its prompt in response to one.
  const askToSend = () => sends().length ? api.permissions.request({ data_collection: sends() }) : Promise.resolve(true);
  async function maySend() {
    const { data_collection: granted = [] } = sends().length ? await api.permissions.getAll() : {};
    return sends().every(c => granted.includes(c));
  }

  // Every User object in a GraphQL response, wherever it sits.
  function extractUsers(json) {
    const out = new Map();
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      const sn = o.rest_id && (o.core?.screen_name ?? o.legacy?.screen_name);
      if (sn) {
        out.set(o.rest_id, {
          id: o.rest_id,
          sn,
          nm: o.core?.name ?? o.legacy?.name ?? '',
          blocking: o.relationship_perspectives?.blocking ?? o.legacy?.blocking,
        });
      }
      for (const k in o) walk(o[k]);
    })(json);
    return [...out.values()];
  }

  // The user object returned by the v1.1 REST endpoints (blocks/create, blocks/destroy).
  const restUser = j => j?.id_str ? { id: j.id_str, sn: j.screen_name, nm: j.name ?? '' } : null;

  function bottomCursor(json) {
    let found = null;
    (function walk(o) {
      if (found || !o || typeof o !== 'object') return;
      if (o.cursorType === 'Bottom' && o.value) found = o.value;
      else for (const k in o) walk(o[k]);
    })(json);
    return found;
  }

  // How long to wait before the next unblock so every [count, windowMs] limit holds, given past attempt times.
  function waitMs(log, now, limits) {
    let wait = 0;
    for (const [n, win] of limits) {
      const recent = log.filter(t => t > now - win);
      if (recent.length >= n) wait = Math.max(wait, recent[recent.length - n] + win - now + 1);
    }
    return wait;
  }

  // Whether a storage change needs syncing: a reason edit, or an edit to the reasons list.
  // Untagged records coming and going (t absent vs 0) don't count.
  const needsSync = (key, { oldValue, newValue }) => key.startsWith('u:')
    ? (newValue?.t ?? 0) !== (oldValue?.t ?? 0)
    : key === 'settings' && newValue?.rt !== oldValue?.rt;

  // Last-writer-wins per user on t. `local` and `remote` map id -> {sn, nm, b, tags, note, t}.
  // Returns the merged map, the remote entries local should adopt, and whether remote is missing anything.
  function merge(local, remote) {
    const merged = { ...remote }, toLocal = [];
    let dirty = false;
    for (const [id, l] of Object.entries(local)) {
      if (!remote[id] || l.t > remote[id].t) { merged[id] = l; dirty = true; }
    }
    for (const [id, r] of Object.entries(remote)) {
      // Don't materialise cleared reasons for people we have no record of.
      if (local[id] ? r.t > local[id].t : hasReason(r)) toLocal.push({ id, ...r });
    }
    return { merged, toLocal, dirty };
  }

  globalThis.TES = { api, DEFAULTS, hasReason, keep, getSettings, commit, askToSend, maySend, extractUsers, restUser, bottomCursor, waitMs, needsSync, merge };
})();
