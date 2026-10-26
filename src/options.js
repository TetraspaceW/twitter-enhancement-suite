const { api, hasReason } = TES;
const $ = id => document.getElementById(id);

async function update(patch) {
  await api.storage.local.set({ settings: { ...(await TES.getSettings()), ...patch } });
}

// Form fields: filled once (and after an import), so typing is never clobbered.
async function load() {
  const s = await TES.getSettings();
  $('reasons').value = s.reasons.join('\n');
  $('token').value = s.gistToken;
  $('pass').value = s.passphrase;
  $('n0').value = s.limits[0][0];
  $('w0').value = s.limits[0][1] / 1e3;
  $('n1').value = s.limits[1][0];
  $('w1').value = s.limits[1][1] / 60e3;
}

// Counts and sync state: live.
async function status() {
  const all = await api.storage.local.get(null);
  const s = { ...TES.DEFAULTS, ...all.settings };
  let blocked = 0, reasoned = 0;
  for (const [k, r] of Object.entries(all)) if (k.startsWith('u:') && r.b) { blocked++; if (hasReason(r)) reasoned++; }
  $('stats').textContent = `${blocked} blocked accounts known, ${reasoned} with a reason, ${blocked - reasoned} without.` +
    (all.scannedAt ? ` Block list last scanned ${new Date(all.scannedAt).toLocaleString()}.` : ' Block list never scanned: open x.com/settings/blocked/all and press Scan.');
  const st = all.syncStatus;
  $('syncMsg').textContent = !s.gistToken ? 'Not syncing.'
    : !st ? 'Not synced yet.'
    : st.ok ? `Last synced ${new Date(st.at).toLocaleString()}.` : `Last sync failed: ${st.error}`;
}

$('saveReasons').onclick = async () => {
  const reasons = [...new Set($('reasons').value.split('\n').map(s => s.trim()).filter(Boolean))];
  await update({ reasons, rt: Date.now() });
  $('reasonsMsg').textContent = 'Saved.';
};

$('saveSync').onclick = async () => {
  const s = await TES.getSettings();
  const gistToken = $('token').value.trim(), passphrase = $('pass').value;
  // A different token may be a different GitHub account: look the gist up again.
  await update({ gistToken, passphrase, gistId: gistToken === s.gistToken ? s.gistId : '' });
  if (!gistToken) return status();
  $('syncMsg').textContent = 'Syncing…';
  const r = await api.runtime.sendMessage({ type: 'sync' }).catch(e => ({ error: e.message }));
  $('syncMsg').textContent = r?.ok ? `Synced: pulled ${r.pulled} change(s)${r.pushed ? ', pushed yours' : ''}.` : `Sync failed: ${r?.error}`;
};

$('savePace').onclick = async () => {
  const limits = [[+$('n0').value, $('w0').value * 1e3], [+$('n1').value, $('w1').value * 60e3]];
  if (limits.flat().some(v => !(v > 0))) return ($('paceMsg').textContent = 'All four numbers must be positive.');
  // Longest window last: the unblock panel uses it for time estimates.
  await update({ limits: limits.sort((a, b) => a[1] - b[1]) });
  $('paceMsg').textContent = 'Saved.';
};

$('export').onclick = async () => {
  const all = await api.storage.local.get(null);
  const { reasons, rt } = { ...TES.DEFAULTS, ...all.settings };
  const users = Object.entries(all).filter(([k]) => k.startsWith('u:')).map(([, r]) => r);
  const blob = new Blob([JSON.stringify({ v: 1, exported: new Date().toISOString(), reasons, rt, users })], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `block-reasons-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
};

$('import').onchange = async e => {
  try {
    const data = JSON.parse(await e.target.files[0].text());
    const all = await api.storage.local.get(null);
    const recs = data.users.filter(r => r?.id && r.sn).filter(r => {
      const old = all['u:' + r.id];
      return !old || (r.t ?? 0) > (old.t ?? 0);
    }).map(r => ({ ...all['u:' + r.id], tags: [], note: '', t: 0, b: 0, ...r }));
    await TES.commit(recs);
    const s = await TES.getSettings();
    if (data.reasons && data.rt > s.rt) await update({ reasons: data.reasons, rt: data.rt });
    $('importMsg').textContent = `Imported ${recs.length} record(s).`;
    load();
  } catch (err) {
    $('importMsg').textContent = `Couldn’t import that file: ${err.message}`;
  }
};

let pending = 0;
api.storage.onChanged.addListener(() => { clearTimeout(pending); pending = setTimeout(status, 300); });
load();
status();
