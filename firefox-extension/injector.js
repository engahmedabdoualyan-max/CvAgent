// ===========================================================================
// CvAgent — injector.js (runs in the page's MAIN world)
// FEATURE 11 — Shadow API discovery (passive sniffer):
// Hooks window.fetch + XHR, records candidate application API endpoints
// (POST/PUT with JSON bodies) and mirrors them to the content script via
// postMessage. Read-only: it NEVER mutates or replays requests.
// ===========================================================================
(function () {
  if (window.__cvagentSniffer) return;
  window.__cvagentSniffer = true;

  const endpoints = [];
  const interesting = (url, method) =>
    /post|put|patch/i.test(method) &&
    /(apply|application|candidate|job|profile|submit|form|workflow)/i.test(url);

  const record = (url, method, bodyHint) => {
    try {
      const u = new URL(url, location.href);
      if (u.origin === location.origin && interesting(u.pathname + u.search, method)) {
        endpoints.push({ method: method.toUpperCase(), url: u.href.slice(0, 300), bodyHint: (bodyHint || "").slice(0, 120) });
        if (endpoints.length <= 25) {
          window.postMessage({ source: "cvagent-sniffer", endpoints: endpoints.slice(-25) }, "*");
        }
      }
    } catch (e) { /* ignore cross-origin parse errors */ }
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && init.method) || (input && input.method) || "GET";
      if (init && init.body) record(url, method, typeof init.body === "string" ? init.body : "[non-string body]");
    } catch (e) { /* ignore */ }
    return origFetch.apply(this, arguments);
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__cvagentMethod = method;
    this.__cvagentUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try { record(this.__cvagentUrl, this.__cvagentMethod || "GET", typeof body === "string" ? body : ""); } catch (e) { /* ignore */ }
    return origSend.apply(this, arguments);
  };
})();
