# Enhancement Suite for Twitter

Remembers why you blocked people on X, and mass-unblocks the ones you didn't give a reason for.

- **Block with a reason.** Block someone the usual way and a sheet pops up: pick reasons, type your own (it's
  offered again next time), and/or write a note. Block from a tweet's ⋯ menu and the tweet is remembered too.
- **See the reason later.** Blocked accounts get a badge next to their name in tweets, lists, their profile and
  your blocked accounts page. Click it to edit; its ↗ opens the tweet you blocked them over.
- **Mass-unblock everyone without a reason.** On `x.com/settings/blocked/all`, a panel scans your block list and
  unblocks every account that has no reason, slowly enough to stay under X's limits. Scanning first is optional:
  the unblocker works down the whole list and picks up accounts it hadn't seen yet as X loads them.
- **Sync** reasons between Firefox and Brave through one secret GitHub gist, optionally encrypted.

About 16 KB zipped, no dependencies, no build tooling beyond Node's standard library.

## It only ever drives X's own page

The extension never sends its own requests to X. It watches the requests X's web app makes (to learn who you
block and unblock), scrolls your block list at a reading pace so X's app loads it, and unblocks by clicking X's
own Blocked buttons. So every request X sees comes from its own client, with its own headers. What remains
visible to X is the volume and rhythm: pacing defaults to just under the limits you measured (≈10 per 45 s,
≈50 per 15 min) with some randomness, and you can lower it in the settings.

At that pace, unblocking N accounts takes about N / 50 × 15 minutes (≈5 hours per 1,000), with the blocked
accounts tab open and in the foreground. **Stop** any time; the next run carries on where it left off. Spreading
a big list over several days is gentler on your account than one marathon.

## Build

```sh
node build.mjs        # → dist/firefox, dist/brave, and a zip of each
node --test test/     # unit tests
```

## Publish

Bump `"version"` in `manifest.base.json` (both stores refuse a version they've already seen), then:

```sh
node publish.mjs firefox "What changed"   # tests, builds, submits to addons.mozilla.org (notes optional)
node publish.mjs chrome                   # tests, builds, submits to the Chrome Web Store for review
```

Each waits for its store to check the upload and prints how long it's taking. They only update an existing
listing: submit the first version by hand on each store's site (listing, screenshots, privacy answers, and
Android as well as Firefox on AMO). Credentials go in `.env`, which git ignores:

```sh
AMO_API_KEY=user:12345:67          # addons.mozilla.org/developers/addon/api/key/
AMO_API_SECRET=…
CWS_PUBLISHER_ID=…                 # Chrome Web Store dashboard → Publisher → Settings
CWS_EXTENSION_ID=…                 # the item's ID, once the first version is up
CWS_SERVICE_ACCOUNT_KEY=/home/you/.config/tes-cws-key.json   # keep the key out of the repo
```

For the Chrome key: in Google Cloud, create a project, enable the *Chrome Web Store API*, create a service account
with no roles and download a JSON key for it, then add the service account's email under *Account* in the
Chrome Web Store dashboard.

The privacy policy both stores ask for is [PRIVACY.md](PRIVACY.md).

## Install

**Firefox (desktop or Android):** `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on…* →
`dist/firefox/manifest.json`. Temporary add-ons disappear on restart *along with their data*, so for daily use
either sign it as an unlisted add-on (`npx web-ext sign --channel=unlisted` with AMO API keys, then install the
`.xpi`) or use Firefox Developer Edition/Nightly with `xpinstall.signatures.required` set to `false`.

**Brave desktop:** `brave://extensions` → enable *Developer mode* → *Load unpacked* → `dist/brave`.

**Brave Android:** stable Brave can't run extensions yet. Brave has started adding support behind a flag in
Brave Nightly/Canary, which will take unpacked or `.crx` extensions; `dist/brave` is a standard Chromium MV3
extension and is what to load there. Vivaldi and Lemur on Android already accept Chromium extensions today, and
Firefox for Android takes the Firefox build.

## Sync

Settings (toolbar button) → *Sync between browsers*. Create a fine-grained GitHub token with only the
**Gists: read and write** account permission, paste it into each browser, and use the same passphrase everywhere
if you want the gist encrypted (AES-GCM, key from PBKDF2). Firefox asks your permission to send block reasons to
GitHub the first time you press *Save and sync now*. The first device creates a secret gist; the others find it. Each person's reason is merged by last edit wins. Only accounts with reasons are synced: each device learns
the block list itself from X. Before a mass unblock, the extension syncs first and refuses to start if that fails,
so nobody you tagged on another device gets unblocked.

## Backup

Removing the extension deletes its data. Settings → *Export* saves everything as JSON; *Import* merges it back.

## Layout

| File | Runs in | Does |
|---|---|---|
| `src/page.js` | X's page (`world: MAIN`) | Watches X's own block-list, profile and block/unblock requests (read-only) |
| `src/content.js` | x.com content script | Local DB, reason sheet, badges, scan / mass-unblock panel |
| `src/lib.js` | everywhere | Record helpers, response parsing, rate limiter, sync merge |
| `src/bg.js` | background | Toolbar button, gist sync |
| `src/options.*` | settings page | Reasons list, sync, pacing, backup |
| `manifest.base.json`, `build.mjs` | — | Shared manifest; per-browser tweaks |
| `publish.mjs` | — | Submits a build to addons.mozilla.org or the Chrome Web Store |
