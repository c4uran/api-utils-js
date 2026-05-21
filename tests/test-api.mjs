// Minimal harness — load api.js into a fake `window` and exercise it.
// Resolves api.js relative to this file so the harness is portable
// (works from `node tests/test-api.mjs` at the repo root).
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '..', 'api.js'), 'utf8');

const sandbox = {
  window: {},
  fetch: globalThis.fetch,
  AbortController: globalThis.AbortController,
  Map: globalThis.Map,
  Set: globalThis.Set,
  TypeError: globalThis.TypeError,
  Date: globalThis.Date,
  Object: globalThis.Object,
  console: globalThis.console,
  Promise: globalThis.Promise,
  Array: globalThis.Array,
  Error: globalThis.Error,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const API = sandbox.window.API;
const ApiError = sandbox.window.ApiError;
if (!API) throw new Error('API not exposed');

// ── Fake backend ──
let reqLog = [];
let delayMs = 0;
let counter = 0;
const srv = http.createServer((req, res) => {
  reqLog.push({ method: req.method, url: req.url, headers: req.headers });
  const myCount = ++counter;
  setTimeout(() => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"v${myCount}"` });
      res.end(JSON.stringify({ n: myCount, url: req.url }));
    } else {
      // mutate
      const inv = req.headers['x-test-invalidate'] || '';
      let chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const headers = { 'Content-Type': 'application/json' };
        if (inv) headers['X-Cache-Invalidate'] = inv;
        res.writeHead(200, headers);
        res.end(JSON.stringify({ ok: true, body: Buffer.concat(chunks).toString() }));
      });
    }
  }, delayMs);
});

await new Promise(r => srv.listen(0, r));
const port = srv.address().port;
const base = `http://127.0.0.1:${port}`;

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra || ''); }
}

// ── T1: basic GET works ──
console.log('T1 basic GET');
let d = await API.get(`${base}/a`);
check('returns json', d && d.url === '/a');

// ── T2: cache hit (no 2nd request) ──
console.log('T2 cache hit');
reqLog.length = 0;
let d2 = await API.get(`${base}/a`);
check('cached value', d2.n === d.n);
check('no network call', reqLog.length === 0);

// ── T3: cache:false bypasses ──
console.log('T3 cache:false bypass');
reqLog.length = 0;
let d3 = await API.get(`${base}/a`, { cache: false });
check('fresh fetch issued', reqLog.length === 1);
check('new counter value', d3.n !== d.n);

// ── T4: mutate invalidates URL prefix ──
console.log('T4 mutate clears cache');
await API.post(`${base}/a`, { x: 1 });
reqLog.length = 0;
let d4 = await API.get(`${base}/a`);
check('cache cleared by mutation', reqLog.length === 1, `reqLog=${reqLog.length}`);

// ── T5: X-Cache-Invalidate header clears other URL ──
console.log('T5 X-Cache-Invalidate');
await API.get(`${base}/b`);  // warm
await API.get(`${base}/c`);
reqLog.length = 0;
await API.post(`${base}/z`, { x: 1 }, { headers: { 'x-test-invalidate': `${base}/b, ${base}/c` } });
let postCount = reqLog.length;
let dB = await API.get(`${base}/b`);
let dC = await API.get(`${base}/c`);
check('both /b and /c re-fetched', reqLog.length === postCount + 2,
  `postCount=${postCount} after=${reqLog.length}`);

// ── T6: latest-wins race — fire 3 GETs rapidly, only last data returned ──
console.log('T6 race latest-wins');
delayMs = 80;
API.clearCache(`${base}/race`);
const p1 = API.get(`${base}/race`).catch(e => ({ aborted: e.name === 'AbortError' }));
const p2 = API.get(`${base}/race`).catch(e => ({ aborted: e.name === 'AbortError' }));
const p3 = API.get(`${base}/race`).catch(e => ({ aborted: e.name === 'AbortError' }));
const results = await Promise.all([p1, p2, p3]);
const aborted = results.filter(r => r && r.aborted).length;
const succeeded = results.filter(r => r && r.n).length;
check('two earlier requests aborted', aborted === 2, `aborted=${aborted}`);
check('one request succeeded', succeeded === 1, `succeeded=${succeeded}`);
delayMs = 0;

// ── T7: expectedEtag → If-Match ──
console.log('T7 expectedEtag → If-Match');
reqLog.length = 0;
await API.put(`${base}/x`, { v: 1 }, { expectedEtag: '"v1"' });
check('If-Match header sent', reqLog[0].headers['if-match'] === '"v1"',
  `headers=${JSON.stringify(reqLog[0].headers)}`);

// ── T8: ApiError carries status ──
console.log('T8 ApiError');
const srv2 = http.createServer((req, res) => {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"err":"nope"}');
});
await new Promise(r => srv2.listen(0, r));
try {
  await API.get(`http://127.0.0.1:${srv2.address().port}/missing`);
  check('throws on 4xx', false);
} catch (e) {
  check('throws ApiError', e.status === 404 && e.name === 'ApiError',
    `name=${e.name} status=${e.status}`);
}
srv2.close();

// ── T9: clearCache(prefix) wildcard ──
console.log('T9 clearCache prefix');
await API.get(`${base}/api/users`);
await API.get(`${base}/api/users?page=2`);
await API.get(`${base}/api/users/42`);
await API.get(`${base}/api/other`);
API.clearCache(`${base}/api/users`);
reqLog.length = 0;
await API.get(`${base}/api/users`);
await API.get(`${base}/api/users?page=2`);
await API.get(`${base}/api/users/42`);
await API.get(`${base}/api/other`);
check('prefix-cleared paths re-fetched, others cached', reqLog.length === 3,
  `reqLog=${reqLog.length}`);

// ── T10: subscribe — get fires callback ──
console.log('T10 subscribe on GET');
API.clearCache(`${base}/sub1`);
let events = [];
let unsub = API.subscribe(`${base}/sub1`, (d) => events.push(d));
await API.get(`${base}/sub1`);
check('subscribe fires on cache populate', events.length === 1 && events[0] && events[0].url === '/sub1',
  `events=${JSON.stringify(events)}`);

// ── T11: subscribe — invalidation via mutate fires null ──
console.log('T11 subscribe on invalidate (mutate)');
events.length = 0;
await API.post(`${base}/sub1`, { x: 1 });
check('subscribe fires null on mutate-invalidate',
  events.length === 1 && events[0] === null,
  `events=${JSON.stringify(events)}`);

// ── T12: subscribe — clearCache(prefix) fires null ──
console.log('T12 subscribe on clearCache prefix');
await API.get(`${base}/sub1`);  // re-populate
events.length = 0;
API.clearCache(`${base}/sub1`);
check('subscribe fires null on clearCache(prefix)',
  events.length === 1 && events[0] === null);

// ── T13: unsubscribe stops callbacks ──
console.log('T13 unsubscribe');
unsub();
events.length = 0;
await API.get(`${base}/sub1`);
check('callback silent after unsubscribe', events.length === 0,
  `events=${JSON.stringify(events)}`);

// ── T14: subscribe — full closes-#7 flow (init → mutate → auto re-render) ──
console.log('T14 closes-#7 flow');
API.clearCache(`${base}/api/users`);
const renderLog = [];
let renderUnsub = API.subscribe(`${base}/api/users`, (data) => {
  if (data === null) {
    // Invalidated — re-fetch (which will fire subscriber again with data).
    API.get(`${base}/api/users`);
  } else {
    renderLog.push(data.n);
  }
});
await API.get(`${base}/api/users`);  // initial — renderLog gets 1 entry
const beforeMutate = renderLog.length;
// Backend signals "list URL invalidated" via X-Cache-Invalidate header —
// this is exactly the closes-#7 contract from the README.
await API.delete(`${base}/api/users/42`, {
  headers: { 'x-test-invalidate': `${base}/api/users` },
});
// Allow microtask for the re-fetch chain.
await new Promise(r => setTimeout(r, 50));
check('renderLog got re-render after mutate w/o manual call',
  renderLog.length === beforeMutate + 1,
  `before=${beforeMutate} after=${renderLog.length}`);
renderUnsub();

// ── T15: callback exception doesn't break sibling subscribers ──
console.log('T15 callback isolation');
API.clearCache(`${base}/iso`);
let goodFired = false;
const u1 = API.subscribe(`${base}/iso`, () => { throw new Error('boom'); });
const u2 = API.subscribe(`${base}/iso`, () => { goodFired = true; });
await API.get(`${base}/iso`);
check('sibling subscriber still ran', goodFired);
u1(); u2();

srv.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
