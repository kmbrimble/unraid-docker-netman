// node tests/js.test.js — mirrors tests/run.php's cases for the JS side
// (plugin/docker-netman-core.js) of the same parse/serialize design.
const assert = require('assert');
const dockerNetman = require('../plugin/docker-netman-core.js');

let count = 0;
function check(name, cond) {
  count++;
  assert.ok(cond, name);
}

const rows = [
  { network: 'proxynet', ip: '172.18.0.5', alias: 'foo', mac: null },
  { network: 'other', ip: null, alias: null, mac: null },
];
const run = dockerNetman.buildNetworkRun('br0', rows, null, false);
check('extra: build run', run === '--network br0 --network name=proxynet,ip=172.18.0.5,alias=foo --network name=other');

const extraParams = dockerNetman.serializeExtra('--dns=1.1.1.1', run);
const parsed = dockerNetman.parseExtra(extraParams, 'br0', rows);
check('extra: found', parsed.found);
check('extra: not manually managed', !parsed.manually_managed);
check('extra: remaining preserved', parsed.remaining === '--dns=1.1.1.1');
check('extra: rows round-trip', dockerNetman.rowsEqual(parsed.rows, rows));

const macRun = dockerNetman.buildNetworkRun('proxynet', [], '02:11:22:33:44:55', true);
check('mac: primary carries mac-address', macRun === '--network name=proxynet,mac-address=02:11:22:33:44:55');
const macParsed = dockerNetman.parseExtra(macRun, 'proxynet', []);
check('mac: parsed back out', macParsed.primary_mac === '02:11:22:33:44:55');

const foreign = '--network br0 --network name=other,ip=10.0.0.5';
const parsedForeign = dockerNetman.parseExtra(foreign, 'br0', []);
check('manually-managed: no state entry -> refuse', parsedForeign.manually_managed);

const postRows = [{ network: 'proxynet', ip: '172.18.0.3', alias: 'butler', mac: null }];
const chain = dockerNetman.buildConnectChain('terrible-butler', postRows);
check('post: build chain', chain === 'docker network connect --ip 172.18.0.3 --alias butler proxynet terrible-butler');

const postArgs = dockerNetman.serializePost('--foo bar', chain);
check('post: appended after existing args', postArgs === '--foo bar && docker network connect --ip 172.18.0.3 --alias butler proxynet terrible-butler');
const parsedPost = dockerNetman.parsePost(postArgs, 'terrible-butler', postRows);
check('post: remaining preserved', parsedPost.remaining === '--foo bar');
check('post: rows round-trip', dockerNetman.rowsEqual(parsedPost.rows, postRows));

check('path: bridge -> post', dockerNetman.choosePath('bridge') === 'post');
check('path: br0 -> extra', dockerNetman.choosePath('br0') === 'extra');

// Regression: expected=null (the browser injector has no state.json client-side
// and must pass "unknown", not []) used to crash rowsEqual with
// "Cannot read properties of null (reading 'length')", which aborted parsing
// entirely and made an existing, correct row disappear from the edit page.
check('extra: expected=null does not throw', (function () {
  try { dockerNetman.parseExtra(run, 'br0', null); return true; } catch (e) { return false; }
})());
const parsedExtraNull = dockerNetman.parseExtra(run, 'br0', null);
check('extra: expected=null -> not manually managed', !parsedExtraNull.manually_managed);
check('extra: expected=null -> rows still parsed', dockerNetman.rowsEqual(parsedExtraNull.rows, rows));

check('post: expected=null does not throw', (function () {
  try { dockerNetman.parsePost(postArgs, 'terrible-butler', null); return true; } catch (e) { return false; }
})());
const parsedPostNull = dockerNetman.parsePost(postArgs, 'terrible-butler', null);
check('post: expected=null -> not manually managed', !parsedPostNull.manually_managed);
check('post: expected=null -> rows still parsed', dockerNetman.rowsEqual(parsedPostNull.rows, postRows));

// The exact real-world terrible-butler PostArgs string (see CLAUDE.md "Live
// verification") through the renamed/fixed parser, with expected=null exactly
// as the injector calls it on the Update Container page.
const realWorldPostArgs = '&& docker network connect --ip 172.18.0.3 proxynet terrible-butler';
const realWorldParsed = dockerNetman.parsePost(realWorldPostArgs, 'terrible-butler', null);
check('post: real-world string does not throw and yields one row', realWorldParsed.rows.length === 1);
check('post: real-world row is proxynet@172.18.0.3', realWorldParsed.rows[0].network === 'proxynet' && realWorldParsed.rows[0].ip === '172.18.0.3');
check('post: real-world -> not manually managed', !realWorldParsed.manually_managed);


// ---- native Additional Networks control (Unraid 7.4) ----
{
  const merged = dockerNetman.mergeNativeRows([{ network: 'proxynet', ip: '172.18.0.3', alias: null, mac: null }],
    ['proxynet', 'other', 'br0', 'bridge', ''], 'br0');
  check('native merge: dedupes against block, skips primary/reserved/empty',
    merged.length === 2 && merged[0].ip === '172.18.0.3' && merged[1].network === 'other' && merged[1].ip === null);

  // Minimal DOM stand-in, shaped like rc2's rendered row:
  //   <dl><dt>Additional Networks:</dt><dd><select multiple>…</select></dd></dl><blockquote>help</blockquote>
  const el = (tagName, extra) => Object.assign({ tagName, style: { display: '' }, previousElementSibling: null, nextElementSibling: null, parentElement: null }, extra);
  function fixture(selected) {
    const sel = el('SELECT', { options: ['proxynet', 'other'].map(v => ({ value: v, selected: selected.includes(v) })) });
    const dt = el('DT'), dd = el('DD'), dl = el('DL'), help = el('BLOCKQUOTE');
    sel.closest = (t) => (t === 'dd' ? dd : null);
    dt.nextElementSibling = dd; dd.previousElementSibling = dt; dd.parentElement = dl;
    dl.nextElementSibling = help;
    return { doc: { querySelector: (q) => (q === dockerNetman.NATIVE_SELECT ? sel : null) }, sel, dt, dd, help };
  }
  const f = fixture(['proxynet']);
  const t = dockerNetman.takeOverNative(f.doc);
  check('native: names read from selected options', t.names.length === 1 && t.names[0] === 'proxynet');
  check('native: dt, dd and help blockquote hidden', [f.dt, f.dd, f.help].every(e => e.style.display === 'none'));
  t.clear();
  check('native: clear() deselects everything', f.sel.options.every(o => !o.selected));

  // 7.3.x: control absent -> null, nothing touched
  check('native absent (7.3.x): takeOverNative returns null', dockerNetman.takeOverNative({ querySelector: () => null }) === null);

  // fail soft: hiding the second element throws -> first is restored, error propagates, selection untouched
  const g = fixture(['proxynet']);
  Object.defineProperty(g.dd.style, 'display', { get() { return ''; }, set() { throw new Error('boom'); } });
  let threw = false;
  try { dockerNetman.takeOverNative(g.doc); } catch (e) { threw = true; }
  check('native fail-soft: throws', threw);
  check('native fail-soft: dt restored, selection intact', g.dt.style.display === '' && g.sel.options[0].selected);

  // row not found -> throws before touching anything
  const h2 = fixture([]);
  h2.sel.closest = () => null;
  let threw2 = false;
  try { dockerNetman.takeOverNative(h2.doc); } catch (e) { threw2 = true; }
  check('native fail-soft: missing dd throws, nothing hidden', threw2 && h2.dt.style.display === '');
}
console.log(`${count} checks passed`);
