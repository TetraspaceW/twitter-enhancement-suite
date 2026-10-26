# Privacy policy

*Enhancement Suite for Twitter. Last updated 26 October 2026.*

The extension has no server, no analytics and no ads. Nobody but you, and GitHub if you turn on sync, ever sees your
data.

## What it keeps, in your browser

- Accounts you've blocked: X user ID, @handle, display name, and whether they're still blocked.
- The reasons and notes you give, when you gave them, and the link to the tweet you blocked someone over.
- Your settings: your list of reasons, unblock pacing, and, if you set up sync, your GitHub token and passphrase.

It learns who you block by reading the responses X's own page receives, inside that page. It never sends requests of
its own to X: scanning and unblocking scroll the page and click X's own buttons, and only when you press Scan or
Unblock. All of this stays in the extension's local storage. Removing the extension deletes it.

## What leaves your browser: only sync, and only if you turn it on

If you paste a GitHub token into *Sync between browsers*, the extension keeps one secret gist on your GitHub account.
On Firefox it first asks your permission to send this data. It then sends to `api.github.com`:

- your list of reasons, and
- for every account you've given a reason or note (including ones you've since cleared, so the clearing syncs):
  their X user ID, @handle, display name, whether they're blocked, your reasons and note, the tweet link, and when
  you last edited them.

Accounts you never gave a reason are never sent. The token is sent to GitHub only, to authenticate. With a
passphrase, the gist is encrypted in your browser (AES-GCM with a PBKDF2 key) before it's sent, and GitHub only ever
holds ciphertext. Without one, it's plain JSON: a secret gist isn't listed anywhere, but anyone who has its URL can
read it.

Sync runs when you press *Save and sync now*, when the browser starts, every 30 minutes, shortly after you edit a
reason, and before a mass unblock. To stop it, clear the token. The gist stays on GitHub until you delete it at gist.github.com. GitHub's
handling of it is covered by [GitHub's privacy statement](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement).

## Export

*Export* saves everything above, except your token and passphrase, to a file on your computer. Nothing is uploaded.

## Questions

Open an issue at https://github.com/TetraspaceW/twitter-enhancement-suite/issues.
