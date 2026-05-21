# api-utils-js

Canonical browser-side fetch wrapper for services that talk to FastAPI/Starlette
backends using the `c4uran/api-utils-py` cache-coordination headers
(`X-Cache-Invalidate` / `Last-Modified` / `If-Match`).

Source of truth for the frontend half of the cache-coordination contract first
prototyped in `infra-ui` (Stage 18.2.b).

## Features

- **Cancellable + latest-wins GETs**: same-URL in-flight requests are aborted
  when a new one starts. Closes the classic "click A, click B, A returns later,
  stale render" race.
- **URL-keyed cache, 60s TTL**, auto-invalidated on mutating verbs.
- **`X-Cache-Invalidate` consumption**: mutating responses can list CSV URL
  prefixes for the wrapper to purge.
- **Optional optimistic concurrency**: `expectedEtag` is sent as `If-Match`.
- **Vanilla browser globals** — no bundler, no ESM. Exposes `window.API`,
  `window.ApiError`, and `window.API_UTILS_VERSION`.

## Distribution model: static file vendor

This library is **not** published to npm. Consumers copy `api.js` into their
own `static/` directory at build time. Pinning to a git ref means a deliberate
migration step per service — same model as `c4uran/api-utils-py` and
`c4uran/bus-client-py`.

### Option A — `docker build` vendor step (preferred)

Add to your service's `Dockerfile`, **before** the `COPY static/` step:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth=1 --branch v0.1.0 https://github.com/c4uran/api-utils-js /tmp/au \
    && mkdir -p /app/static \
    && cp /tmp/au/api.js /app/static/api.js \
    && rm -rf /tmp/au
```

(Skip the `apt-get` line if your base image already has `git`.) Then in your
service's `static/` directory, **do not commit** the vendored `api.js` — let
the build pull it. The application's HTML loads it as a plain script:

```html
<script src="static/api.js"></script>
<script src="static/app.js"></script>
```

After load, `window.API_UTILS_VERSION === "0.1.0"`.

### Option B — Jenkinsfile / CI vendor step

If you'd rather keep the Docker image build pure, do the clone+copy from
Jenkins before invoking `docker build`, into a build-context `static/`
directory that is then `COPY`-ed into the image normally.

## Public API

```js
API.get(url, opts?)         // → Promise<json>
API.put(url, body, opts?)   // → Promise<json|null>
API.post(url, body, opts?)  // → Promise<json|null>
API.delete(url, opts?)      // → Promise<json|null>
API.clearCache(urlOrPrefix) // → void
```

`opts` for `get`:    `{ cache?: boolean, init?: RequestInit }`
`opts` for mutate:   `{ headers?: object, expectedEtag?: string }`

`ApiError` carries `.status` (HTTP code) and `.payload` (raw body text).
Throws on non-2xx; aborted `get`s reject with `AbortError`.

## Versioning

`window.API_UTILS_VERSION` is hardcoded in `api.js` (and mirrored in
`version.js`). Bump on every behavioural change. Services pin their vendor
`git clone` to a tag, then bump deliberately.

## Tests

```sh
node tests/test-api.mjs
```

A 12-assertion Node harness that loads `api.js` into a `vm` sandbox with a
fake `window`, stands up an `http.createServer`, and exercises GET caching,
cancellation, mutate-invalidates, `X-Cache-Invalidate`, latest-wins race,
`If-Match`, `ApiError`, and prefix `clearCache`. No browser needed.

## License

MIT, see `LICENSE`.
