# api-utils-js — ARCHIVED 2026-05-23

> **This repo is read-only.** Code inlined into each consumer service.
> Do not pin new versions. Do not vendor from this URL in new Jenkinsfiles
> or Dockerfiles — they will break when the next maintainer deletes the
> repo entirely.

## Why archived

Architectural review (manga-watcher session 2026-05-23) — only 2 consumers,
already drifted (infra-ui@v0.1.0 vs manga-watcher@v0.1.1), zero realised
sharing benefit. Carrying cost (separate repo + Vendor-via-Jenkins stages
+ Lint-before-Vendor chicken-and-egg in manga's pipeline) > benefit.
Per flatnotes [[todo-fragmentation — Phase 1 design subnote]].

## Where the code lives now

| Consumer | Path | Synced from | Commit |
|----------|------|-------------|--------|
| manga-watcher | `static/js/api-utils-vendor.js` | v0.1.1 (release-0.1 branch) | c4uran/watcher e425b05 |
| infra-ui      | `infra-ui/static/api.js`         | v0.1.1                       | c4uran/infra   e101cf0 |

Both consumers are on the same content (v0.1.1) at the time of inlining.

## Tags preserved for archaeology

- `v0.1.0` — initial extraction from infra-ui PoC (commit `fec6e98`)
- `v0.1.1` — `release-0.1` patch: `nosemgrep` + `eslint-disable` directives
  on the two wrapper-internal `fetch` calls (the file IS the wrapper; the
  `no-bare-fetch` rule is meant for callers, not the implementation)
- `v0.2.0` — `subscribe(url, cb)` reactivity primitive (no consumer ever
  adopted; lives only in this archive)

If a third consumer ever appears, do NOT resurrect this repo. Pick one
of the existing inlined copies, harden it with the new requirements, and
let it drift OR keep one canonical copy and `cp` it to the second consumer
out-of-band. Sharing-via-Jenkins-clone is no longer the house style.

## License

See `LICENSE` (unchanged).
