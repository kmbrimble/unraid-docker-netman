// Drives the REAL DockerNetManInject.page script in headless Chromium against Add/Update-Container
// fixtures: one modelled on rc2's native "Additional Networks" row (Unraid 7.4), one without it
// (7.3.x). The rc2 markup is reconstructed from CreateDocker.php source, not a live 7.4 page.
// Needs playwright-core + a cached chromium_headless_shell; skips (exit 0) when unavailable.
//   NODE_PATH=<dir with node_modules> node tests/inject-browser.test.js
const fs = require('fs'), os = require('os'), path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (e) { console.log('SKIP: playwright-core not available'); process.exit(0); }
const base = path.join(os.homedir(), '.cache', 'ms-playwright');
const shellDir = fs.existsSync(base) && fs.readdirSync(base).filter(d => d.startsWith('chromium_headless_shell-')).sort().pop();
if (!shellDir) { console.log('SKIP: no chromium_headless_shell cached'); process.exit(0); }
const exe = (function find(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) { const r = find(p); if (r) return r; } else if (f.name === 'chrome-headless-shell') return p;
  }
})(path.join(base, shellDir));

const plugin = path.join(__dirname, '..', 'plugin');
const injectSrc = fs.readFileSync(path.join(plugin, 'DockerNetManInject.page'), 'utf8').match(/<script>\n([\s\S]*?)<\/script>/)[1];
const coreSrc = fs.readFileSync(path.join(plugin, 'docker-netman-core.js'), 'utf8');

const NATIVE_ROW = `
<dl><dt>Network Type:</dt><dd><select name="contNetwork"><option value="bridge" selected>Bridge</option><option value="br0">br0</option></select></dd></dl>
<dl><dt>Additional Networks:</dt><dd><select id="contExtraNetworks" name="contExtraNetworks[]" multiple="multiple" style="display:none">
  <option value="proxynet" selected>proxynet</option><option value="other">other</option></select>
  <span class="ui-dropdownchecklist ui-dropdownchecklist-selector-wrapper" id="ddcl-contExtraNetworks">widget</span></dd></dl>
<blockquote class="inline_help">Attach the container to more custom networks…</blockquote>`;
const PLAIN_NET = `<dl><dt>Network Type:</dt><dd><select name="contNetwork"><option value="bridge" selected>Bridge</option></select></dd></dl>`;

function page(withNative, extra) {
  return `<!doctype html><html><head></head><body><form id="f">
<input name="contName" value="Grafana">${withNative ? NATIVE_ROW : PLAIN_NET}
<dl><dt>Fixed IP:</dt><dd><input name="contMyIP"></dd></dl>
<dl><dt>MAC:</dt><dd><input name="contMyMAC"></dd></dl>
<input name="contExtraParams" value=""><input name="contPostArgs" value="${extra || ''}">
</form><script>var csrf_token='t';</script><script>${injectSrc}</script></body></html>`;
}

let n = 0, fail = 0;
const check = (name, ok) => { n++; if (!ok) { fail++; console.log('FAIL: ' + name); } };

async function run(browser, html, { apiBroken } = {}) {
  const ctx = await browser.newContext();
  const pg = await ctx.newPage();
  const errors = [];
  pg.on('pageerror', e => errors.push(String(e)));
  await pg.route('**/*', route => {
    const u = route.request().url();
    if (u.endsWith('/docker-netman-core.js')) return route.fulfill({ contentType: 'text/javascript', body: coreSrc });
    if (u.endsWith('/api.php')) return apiBroken ? route.abort() : route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, networks: [{ name: 'proxynet' }, { name: 'other' }] }) });
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  await pg.goto('http://unraid.test/Docker/UpdateContainer?x=1');
  await pg.waitForTimeout(400);
  return { pg, errors };
}

const submitted = pg => pg.evaluate(() => new Promise(res => {
  const f = document.getElementById('f');
  f.addEventListener('submit', e => { e.preventDefault(); const d = new FormData(f); res({ nets: d.getAll('contExtraNetworks[]'), post: d.get('contPostArgs') }); });
  f.requestSubmit();
}));
const shown = (pg, sel) => pg.evaluate(s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.offsetParent !== null; }, sel);

(async () => {
  const browser = await chromium.launch({ executablePath: exe });
  try {
    // 7.4 / rc2 shape
    let { pg, errors } = await run(browser, page(true));
    check('rc2: native select row hidden (dt, dd/widget)', !(await shown(pg, '#contExtraNetworks')) && !(await shown(pg, '#ddcl-contExtraNetworks')));
    check('rc2: native help blockquote hidden', !(await shown(pg, 'blockquote.inline_help')));
    check('rc2: neighbouring rows untouched', (await shown(pg, 'select[name=contNetwork]')) && (await shown(pg, 'input[name=contMyMAC]')));
    check('rc2: NetMan section present', await shown(pg, '.dnm-block'));
    check('rc2: native proxynet imported as a NetMan row (exactly one)', (await pg.$$eval('.dnm-f-network', e => e.map(x => x.value))).join() === 'proxynet');
    const s = await submitted(pg);
    check('rc2: submit posts NO contExtraNetworks[]', s.nets.length === 0);
    check('rc2: PostArgs carries the imported network', /docker network connect proxynet Grafana/.test(s.post));
    check('rc2: no page errors', errors.length === 0);

    // endpoint unreachable -> fail soft: native control stays visible and selected
    ({ pg, errors } = await run(browser, page(true), { apiBroken: true }));
    check('rc2 fail-soft (endpoint down): native row left visible', (await shown(pg, '#ddcl-contExtraNetworks')) && (await shown(pg, 'blockquote.inline_help')));
    check('rc2 fail-soft: native selection still posted', (await submitted(pg)).nets.join() === 'proxynet');

    // hide step throws -> native row visible, no NetMan duplicate rows
    const sabotaged = page(true).replace('<script>var csrf_token', '<script>Object.defineProperty(HTMLElement.prototype,"style",{get(){throw new Error("boom")},configurable:true});</script><script>var csrf_token');
    ({ pg, errors } = await run(browser, sabotaged));
    check('rc2 fail-soft (hide throws): native row still visible', await shown(pg, '#ddcl-contExtraNetworks'));
    check('rc2 fail-soft: no imported duplicate rows', (await pg.$$eval('.dnm-f-network', e => e.length)) === 0);
    check('rc2 fail-soft: native selection still posted', (await submitted(pg)).nets.join() === 'proxynet');

    // 7.3.x shape: no native control -> behaviour unchanged
    ({ pg, errors } = await run(browser, page(false)));
    check('7.3.x: NetMan section present, zero rows', (await shown(pg, '.dnm-block')) && (await pg.$$eval('.dnm-f-network', e => e.length)) === 0);
    check('7.3.x: no stray hidden elements', (await pg.evaluate(() => [...document.querySelectorAll('dl,dt,dd,blockquote')].every(e => e.style.display === ''))));
    check('7.3.x: submit leaves PostArgs empty', (await submitted(pg)).post === '' && errors.length === 0);
  } finally { await browser.close(); }
  console.log(`${n} browser checks, ${fail} failures`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
