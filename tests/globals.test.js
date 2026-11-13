// Guard: the shipped page scripts must not leak globals or touch Unraid's own.
// Unraid's header script owns globals such as `before`, `now`, `timers`, `csrf_token`;
// clobbering `before` (a Date) broke its uptime ticker once. Each script is run in a vm
// sandbox seeded with sentinels, in the real code paths, against a mocked jQuery/swal.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.join(__dirname, '..', 'plugin');
let failures = 0, count = 0;
function check(name, cond) { count++; if (!cond) { failures++; console.log('FAIL: ' + name); } }

function scriptOf(page) {
  const src = fs.readFileSync(path.join(root, page), 'utf8');
  const blocks = [...src.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map(m => m[1]);
  return blocks.join('\n').replace(/<\?=\$pluginRoot\?>/g, '/plugins/docker.netman');
}

function chain() {
  const fn = function () {};
  const p = new Proxy(fn, {
    get(_, k) {
      if (k === 'length') return 0;
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'val') return () => '';
      if (k === 'is') return () => false;
      if (k === 'attr' || k === 'data') return (...a) => (a.length > 1 ? p : undefined);
      return () => p;
    },
  });
  return p;
}

function makeSandbox(posts) {
  const c = chain();
  const grafana = { name: 'Grafana', primary: 'bridge', primary_ip: '', primary_mac: '', path: 'post', rows: [{ network: 'proxynet', ip: null, alias: null, mac: null }],
    manually_managed: true, running: true, installed: true, no_template: false, live_networks: { bridge: { ip: '172.17.0.5' }, proxynet: { ip: '172.18.0.4' } } };
  const reply = (d) => {
    if (d.action === 'containers') return { ok: true, containers: [grafana] };
    if (d.action === 'networks') return { ok: true, networks: [{ name: 'proxynet', driver: 'bridge', subnets: [{ subnet: '172.18.0.0/16', gateway: '172.18.0.1' }], containers: [{ name: 'Grafana', ip: '172.18.0.4' }] }] };
    if (d.action === 'adopt') return d.dry_run ? { ok: true, mode: 'normalise', field: 'PostArgs', before: 'a', after: 'b', rows: [] } : { ok: true };
    return { ok: true };
  };
  const $ = function (a) { if (typeof a === 'function') a(); return c; };
  $.fn = {};
  $.post = (url, d, cb) => { posts.push(d); cb(reply(d)); return { fail() {} }; };
  const sb = {
    $, jQuery: $, console, location: { pathname: '/DockerNetMan' },
    swal: (o, cb) => cb && cb(true), confirm: () => true, alert() {},
    localStorage: { getItem: () => null, setItem() {} },
    __frame: { style: {}, offsetHeight: 600, getBoundingClientRect: () => ({ top: 120 }) },
    getComputedStyle: () => ({ position: 'fixed' }), innerHeight: 900, setTimeout: () => 0, addEventListener() {},
    document: { readyState: 'complete', querySelector: () => null, documentElement: { scrollHeight: 900 },
      getElementById: (id) => (id === 'dnm-frame' ? sb.__frame : id === 'footer' ? { offsetHeight: 40 } : null), querySelectorAll: () => [], addEventListener() {}, createElement: () => chain(), body: chain(), head: chain() },
    // sentinels: Unraid's own header globals
    before: new Date(), after: 'A', now: new Date(), timers: {}, csrf_token: 'tok', uptime: 1,
  };
  sb.window = sb;
  return sb;
}

function run(page, pathname, exercise) {
  const posts = [];
  const sb = makeSandbox(posts);
  sb.location.pathname = pathname;
  const ctx = vm.createContext(sb);
  const sentinels = { before: sb.before, after: sb.after, now: sb.now, timers: sb.timers, csrf_token: sb.csrf_token, uptime: sb.uptime };
  const keysBefore = new Set(Object.keys(sb));
  let err = null;
  try {
    vm.runInContext(scriptOf(page), ctx);
    if (exercise) exercise(sb, posts);
  } catch (e) { err = e; }
  check(`${page} ${pathname}: runs without error (${err && err.message})`, !err);
  for (const k of Object.keys(sentinels)) check(`${page} ${pathname}: sentinel ${k} untouched`, sb[k] === sentinels[k]);
  check(`${page} ${pathname}: before is still a Date`, typeof sb.before.getTime === 'function');
  return { sb, posts, leaked: Object.keys(sb).filter(k => !keysBefore.has(k)) };
}

// Settings page: now only the iframe host. It must add no globals at all, and it must size the frame.
// (The app itself is Preact in ui/, tested with vitest: ui/src/*.test.ts[x]; its adopt/save/apply flows live there.)
const r = run('DockerNetMan.page', '/DockerNetMan');
check('settings page: adds no globals: ' + r.leaked.join(','), r.leaked.length === 0);
check('settings page: sized the frame', r.sb.__frame.style.height !== undefined && r.sb.__frame.style.height !== '');
check('settings page: no ajax of its own (the app owns every request)', r.posts.length === 0);
check('settings page: points at the app, not at api.php', /plugins\/docker\.netman\/app\/index\.php/.test(fs.readFileSync(path.join(root, 'DockerNetMan.page'), 'utf8')));

// Injector runs on EVERY Unraid page (Menu="Buttons"): must add no globals beyond what it deliberately sets.
for (const p of ['/Dashboard', '/Docker', '/Docker/UpdateContainer']) {
  const x = run('DockerNetManInject.page', p);
  check(`injector ${p}: leaked globals: ${x.leaked.join(',')}`, x.leaked.every(k => k === 'dockerNetman'));
}

// Core library: loads via UMD onto the sandbox as window.dockerNetman only.
{
  const sb = { self: undefined }; sb.self = sb;
  const keys = new Set(Object.keys(sb));
  vm.runInContext(fs.readFileSync(path.join(root, 'docker-netman-core.js'), 'utf8'), vm.createContext(sb));
  check('core: only dockerNetman added', Object.keys(sb).filter(k => !keys.has(k)).join() === 'dockerNetman');
}

console.log(`${count - failures} of ${count} global-hygiene checks passed`);
process.exit(failures ? 1 : 0);
