// Runs in X's own page context (world: MAIN) to watch the web app's API traffic, which
// content.js can't see from its isolated world. Read-only: it never sends requests itself.
(() => {
  const WATCH = /\/graphql\/[^/]+\/(BlockedAccountsAll|UserByScreenName)\b|\/1\.1\/blocks\/(create|destroy)\b/;

  // X's web client uses XHR for its API calls. Bodies go across as strings, which cross
  // into the content script's isolated world cleanly in every browser.
  const { open } = XMLHttpRequest.prototype;
  XMLHttpRequest.prototype.open = function (method, url) {
    const m = WATCH.exec(String(url));
    if (m) {
      this.addEventListener('load', () => window.postMessage({
        tes: 'page',
        op: m[1] || m[2],
        status: this.status,
        reset: +this.getResponseHeader('x-rate-limit-reset') * 1000 || 0,
        body: this.responseType === 'json' ? JSON.stringify(this.response) : this.responseText,
      }, location.origin));
    }
    return open.apply(this, arguments);
  };
})();
