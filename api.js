// api.js — race-safe fetch wrapper for infra-ui.
//
// Design goals (Stage 18.2.b PoC):
//   1. Cancellable + latest-wins GETs: if the same URL is already in flight,
//      abort the older request before starting a new one. Closes the
//      "click → load A → click → load B → A returns later → stale render"
//      bug class (#4 in backlog).
//   2. URL-keyed cache with 60s TTL and auto-invalidation on mutating verbs.
//      Mutations also honor an optional `X-Cache-Invalidate` response header
//      (CSV of URL prefixes) — foundation for the 18.1.a backend complement.
//   3. Optional optimistic-concurrency: callers can pass `expectedEtag`,
//      which is sent as `If-Match` on mutating requests.
//
// Vanilla browser globals — no bundler, no ESM. Loaded via plain <script> tag
// before app.js; exposes `window.API` and `window.ApiError`.
//
// Public shape:
//   API.get(url, opts?)         → Promise<json>
//   API.put(url, body, opts?)   → Promise<json|null>
//   API.post(url, body, opts?)  → Promise<json|null>
//   API.delete(url, opts?)      → Promise<json|null>
//   API.clearCache(urlOrPrefix) → void
//   API.subscribe(url, cb)      → unsubscribe()
//
// opts for GET:    { cache?: boolean, init?: RequestInit }
// opts for mutate: { headers?: object, expectedEtag?: string }
//
// Reactivity (v0.2.0 — Stage 18.7, closes bug-class #7 "state without
// re-render"). `subscribe(url, cb)` fires the callback when:
//   - The URL's cache entry is freshly populated by a successful `API.get`.
//   - The URL is invalidated via mutating verb / `X-Cache-Invalidate` /
//     explicit `clearCache(prefix)`. The callback receives `null` as the
//     invalidation signal — consumer typically re-fetches and re-renders.
// Opt-in: existing callers see no behavioural change. See README for the
// closes-#7 usage pattern.

(function () {
  'use strict';

  const CACHE_TTL_MS = 60000;
  const _CACHE = new Map();        // url → {data, etag, cachedAt}
  const _PENDING = new Map();      // url → AbortController for the latest in-flight GET
  const _SUBSCRIBERS = new Map();  // url → Set<callback>

  // Fire every subscriber for `url` with `data` (or null for invalidation).
  // Each callback is wrapped — one throw must not break the others.
  function _notify(url, data) {
    const subs = _SUBSCRIBERS.get(url);
    if (!subs || subs.size === 0) return;
    for (const cb of subs) {
      try {
        cb(data);
      } catch (e) {
        // Surface but don't propagate — subscribers are observers, not gates.
        try { console.error('API.subscribe callback failed for', url, e); } catch {}
      }
    }
  }

  function subscribe(url, callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('API.subscribe(url, callback): callback must be a function');
    }
    let set = _SUBSCRIBERS.get(url);
    if (!set) {
      set = new Set();
      _SUBSCRIBERS.set(url, set);
    }
    set.add(callback);
    return function unsubscribe() {
      const s = _SUBSCRIBERS.get(url);
      if (!s) return;
      s.delete(callback);
      if (s.size === 0) _SUBSCRIBERS.delete(url);
    };
  }

  class ApiError extends Error {
    constructor(message, status, payload) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.payload = payload;
    }
  }

  function clearCache(urlOrPrefix) {
    if (!urlOrPrefix) {
      // Full wipe — notify every subscribed URL (whether it had a cache entry
      // or not; subscribers exist for URLs that may never have been GET'd).
      _CACHE.clear();
      for (const url of _SUBSCRIBERS.keys()) _notify(url, null);
      return;
    }
    const cleared = [];
    for (const k of Array.from(_CACHE.keys())) {
      if (
        k === urlOrPrefix ||
        k.indexOf(urlOrPrefix + '?') === 0 ||
        k.indexOf(urlOrPrefix + '/') === 0
      ) {
        _CACHE.delete(k);
        cleared.push(k);
      }
    }
    // Notify any subscriber whose URL was just invalidated, plus any
    // subscriber for the exact prefix (it may not have had a cache entry yet
    // but still wants to know the prefix was invalidated — e.g. a list view
    // that hasn't loaded yet but is wired up).
    const notified = new Set();
    for (const k of cleared) {
      if (_SUBSCRIBERS.has(k)) { _notify(k, null); notified.add(k); }
    }
    for (const url of _SUBSCRIBERS.keys()) {
      if (notified.has(url)) continue;
      if (
        url === urlOrPrefix ||
        url.indexOf(urlOrPrefix + '?') === 0 ||
        url.indexOf(urlOrPrefix + '/') === 0
      ) {
        _notify(url, null);
      }
    }
  }

  // Race-safe GET. Latest-wins: any prior in-flight request for the same URL
  // is aborted before this one starts.
  async function apiGet(url, opts) {
    const o = opts || {};
    const useCache = o.cache !== false;

    if (useCache) {
      const cached = _CACHE.get(url);
      if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return cached.data;
      }
    }

    const existing = _PENDING.get(url);
    if (existing) {
      try {
        existing.abort();
      } catch {
        // AbortController.abort() should not throw, but guard anyway.
      }
    }

    const ctrl = new AbortController();
    _PENDING.set(url, ctrl);

    try {
      const init = Object.assign({}, o.init || {}, { signal: ctrl.signal });
      const r = await fetch(url, init);
      if (!r.ok) {
        let body = '';
        try {
          body = await r.text();
        } catch {
          // Body unreadable — surface status only.
        }
        throw new ApiError('GET ' + url + ' → ' + r.status, r.status, body);
      }
      const data = await r.json();
      const etag = r.headers.get('ETag') || r.headers.get('Last-Modified');
      // Stash only if we're still the latest request — otherwise a slower
      // earlier abort might race-overwrite fresher data.
      if (_PENDING.get(url) === ctrl) {
        _CACHE.set(url, { data, etag, cachedAt: Date.now() });
        _notify(url, data);
      }
      return data;
    } finally {
      if (_PENDING.get(url) === ctrl) {
        _PENDING.delete(url);
      }
    }
  }

  // Mutating verb (PUT/POST/DELETE). Auto-invalidates cache:
  //   1. Every URL prefix listed in the `X-Cache-Invalidate` response header
  //      (CSV) is purged from cache.
  //   2. As a safety fallback, the base path of the mutated URL itself is
  //      always purged (so callers get fresh data on the next GET even if
  //      the backend hasn't opted into the header yet).
  async function apiMutate(verb, url, body, opts) {
    const o = opts || {};
    const headers = Object.assign(
      { 'Content-Type': 'application/json' },
      o.headers || {},
    );
    if (o.expectedEtag) {
      headers['If-Match'] = o.expectedEtag;
    }
    const init = {
      method: verb,
      headers,
      body: body !== null && body !== undefined ? JSON.stringify(body) : undefined,
    };
    const r = await fetch(url, init);
    if (!r.ok) {
      let errBody = '';
      try {
        errBody = await r.text();
      } catch {
        // Body unreadable — surface status only.
      }
      throw new ApiError(verb + ' ' + url + ' → ' + r.status, r.status, errBody);
    }

    const inv = r.headers.get('X-Cache-Invalidate');
    if (inv) {
      for (const pattern of inv.split(',')) {
        clearCache(pattern.trim());
      }
    }
    clearCache(url.split('?')[0]);

    if (r.status === 204) return null;
    // Some endpoints (e.g. /api/infra/<action>) return JSON; some may not.
    const ct = r.headers.get('Content-Type') || '';
    if (ct.indexOf('application/json') === -1) return null;
    return r.json();
  }

  const API = {
    get: apiGet,
    put: (url, body, opts) => apiMutate('PUT', url, body, opts),
    post: (url, body, opts) => apiMutate('POST', url, body, opts),
    delete: (url, opts) => apiMutate('DELETE', url, null, opts),
    clearCache,
    subscribe,
  };

  // Expose as globals — infra-ui has no bundler.
  window.API = API;
  window.ApiError = ApiError;
  window.API_UTILS_VERSION = '0.2.0';
})();
