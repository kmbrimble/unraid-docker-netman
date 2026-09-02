// node tests/js.test.js — mirrors tests/run.php's cases for the JS side
// (plugin/multinet-core.js) of the same parse/serialize design.
const assert = require('assert');
const multinet = require('../plugin/multinet-core.js');

let count = 0;
function check(name, cond) {
  count++;
  assert.ok(cond, name);
}

const rows = [
  { network: 'proxynet', ip: '172.18.0.5', alias: 'foo', mac: null },
  { network: 'other', ip: null, alias: null, mac: null },
];
const run = multinet.buildNetworkRun('br0', rows, null, false);
check('extra: build run', run === '--network br0 --network name=proxynet,ip=172.18.0.5,alias=foo --network name=other');

const extraParams = multinet.serializeExtra('--dns=1.1.1.1', run);
const parsed = multinet.parseExtra(extraParams, 'br0', rows);
check('extra: found', parsed.found);
check('extra: not manually managed', !parsed.manually_managed);
check('extra: remaining preserved', parsed.remaining === '--dns=1.1.1.1');
check('extra: rows round-trip', multinet.rowsEqual(parsed.rows, rows));

const macRun = multinet.buildNetworkRun('proxynet', [], '02:11:22:33:44:55', true);
check('mac: primary carries mac-address', macRun === '--network name=proxynet,mac-address=02:11:22:33:44:55');
const macParsed = multinet.parseExtra(macRun, 'proxynet', []);
check('mac: parsed back out', macParsed.primary_mac === '02:11:22:33:44:55');

const foreign = '--network br0 --network name=other,ip=10.0.0.5';
const parsedForeign = multinet.parseExtra(foreign, 'br0', []);
check('manually-managed: no state entry -> refuse', parsedForeign.manually_managed);

const postRows = [{ network: 'proxynet', ip: '172.18.0.3', alias: 'butler', mac: null }];
const chain = multinet.buildConnectChain('terrible-butler', postRows);
check('post: build chain', chain === 'docker network connect --ip 172.18.0.3 --alias butler proxynet terrible-butler');

const postArgs = multinet.serializePost('--foo bar', chain);
check('post: appended after existing args', postArgs === '--foo bar && docker network connect --ip 172.18.0.3 --alias butler proxynet terrible-butler');
const parsedPost = multinet.parsePost(postArgs, 'terrible-butler', postRows);
check('post: remaining preserved', parsedPost.remaining === '--foo bar');
check('post: rows round-trip', multinet.rowsEqual(parsedPost.rows, postRows));

check('path: bridge -> post', multinet.choosePath('bridge') === 'post');
check('path: br0 -> extra', multinet.choosePath('br0') === 'extra');

console.log(`${count} checks passed`);
