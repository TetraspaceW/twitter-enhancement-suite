// Tests, builds, and submits an update to one store. No dependencies.
//   node publish.mjs firefox ["release notes"]   → addons.mozilla.org
//   node publish.mjs chrome                      → Chrome Web Store (Chrome, Brave, …)
// Bump "version" in manifest.base.json first: both stores refuse a version they've already seen.
// Credentials come from .env; see README → Publish.
import { createHmac, createSign, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [store, notes] = process.argv.slice(2);
const publish = { __proto__: null, firefox, chrome }[store];
if (!publish) fail('Usage: node publish.mjs firefox ["release notes"]\n       node publish.mjs chrome');
if (existsSync('.env')) process.loadEnvFile('.env');

execFileSync(process.execPath, ['--test', 'test/'], { stdio: 'inherit' });
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit' });
await publish();

async function firefox() {
  const zip = 'twitter-enhancement-suite-firefox.zip';
  const { version, browser_specific_settings: { gecko: { id } } } = JSON.parse(readFileSync('dist/firefox/manifest.json', 'utf8'));
  // Every request gets a fresh JWT signed with the API secret; AMO allows them 5 minutes at most.
  const amo = (path, init = {}) => {
    const now = Math.floor(Date.now() / 1e3);
    const token = jwt('HS256', { iss: env('AMO_API_KEY'), jti: randomUUID(), iat: now, exp: now + 60 },
      s => createHmac('sha256', env('AMO_API_SECRET')).update(s).digest('base64url'));
    return call('https://addons.mozilla.org/api/v5/addons/' + path, { ...init, headers: { authorization: 'JWT ' + token, ...init.headers } });
  };

  const form = new FormData();
  form.append('upload', new Blob([readFileSync('dist/' + zip)]), zip);
  form.append('channel', 'listed');
  const { uuid } = await amo('upload/', { method: 'POST', body: form });
  const upload = await waitFor(`Mozilla is validating ${version}`, async () => {
    const u = await amo(`upload/${uuid}/`);
    return u.processed && u;
  });
  if (!upload.valid) {
    fail(`Mozilla rejected ${version}:\n` + (upload.validation?.messages ?? [])
      .filter(m => m.type === 'error').map(m => `- ${m.message}${m.file ? ` (${m.file})` : ''}`).join('\n'));
  }

  await amo(`addon/${encodeURIComponent(id)}/versions/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upload: uuid, compatibility: ['firefox', 'android'], ...(notes && { release_notes: { 'en-US': notes } }) }),
  });
  console.log(`Submitted ${version} to Firefox Add-ons: https://addons.mozilla.org/developers/addons`);
}

async function chrome() {
  const zip = 'dist/twitter-enhancement-suite-brave.zip';
  const { version } = JSON.parse(readFileSync('dist/brave/manifest.json', 'utf8'));
  const item = `publishers/${env('CWS_PUBLISHER_ID')}/items/${env('CWS_EXTENSION_ID')}`;
  const headers = { authorization: 'Bearer ' + await googleToken() };
  const cws = (path, init = {}) => call('https://chromewebstore.googleapis.com/' + path, { ...init, headers: { ...headers, ...init.headers } });

  let { uploadState: state } = await cws(`upload/v2/${item}:upload`, { method: 'POST', body: readFileSync(zip) });
  if (state === 'IN_PROGRESS') {
    state = await waitFor(`Chrome Web Store is processing ${version}`, async () => {
      const s = (await cws(`v2/${item}:fetchStatus`)).lastAsyncUploadState;
      return s !== 'IN_PROGRESS' && s;
    });
  }
  if (state !== 'SUCCEEDED') fail(`Chrome Web Store upload of ${version} ended ${state}: see https://chrome.google.com/webstore/devconsole`);

  const published = await cws(`v2/${item}:publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log(`Submitted ${version} to the Chrome Web Store (${published.state}): https://chrome.google.com/webstore/devconsole`);
}

// The service account's key, traded for an hour-long access token.
// https://developers.google.com/identity/protocols/oauth2/service-account#httprest
async function googleToken() {
  const key = JSON.parse(readFileSync(env('CWS_SERVICE_ACCOUNT_KEY'), 'utf8'));
  const now = Math.floor(Date.now() / 1e3);
  const assertion = jwt('RS256', {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/chromewebstore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 600,
  }, s => createSign('RSA-SHA256').update(s).sign(key.private_key, 'base64url'));
  const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
  return (await call('https://oauth2.googleapis.com/token', { method: 'POST', body })).access_token;
}

function jwt(alg, claims, sign) {
  const unsigned = [{ alg, typ: 'JWT' }, claims].map(o => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.');
  return unsigned + '.' + sign(unsigned);
}

async function call(url, init = {}) {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) fail(`${init.method ?? 'GET'} ${url} → ${r.status} ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : {};
}

// Polls every 5 s until check() returns something, saying how long it's been.
async function waitFor(what, check) {
  const start = Date.now();
  for (let done; ; await sleep(5e3)) {
    if ((done = await check())) return done;
    console.log(`${what}… ${Math.round((Date.now() - start) / 1e3)} s`);
  }
}

function env(name) {
  return process.env[name] || fail(`${name} isn't set: put it in .env (see README → Publish).`);
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}
