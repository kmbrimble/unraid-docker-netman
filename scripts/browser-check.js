#!/usr/bin/env node
// Loads Unraid pages in headless Chromium and reports load time, page errors, console
// errors and leaked globals. Read-only: it only navigates. Not shipped in the txz.
// Usage: NODE_PATH=<dir with node_modules/playwright-core> node scripts/browser-check.js /Main /Docker /Settings/DockerNetMan
// Env: UNRAID_HOST (default 192.168.0.10), UNRAID_SSH_KEY (default /root/.ssh/unraid_secretsman).
// Auth: reuses the newest active root PHP session on the host as cookie unraid_<md5(host)>
// (host WITHOUT port — local_prepend.php's session_name). The session id is never printed.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const HOST = process.env.UNRAID_HOST || '192.168.0.10';
const KEY = process.env.UNRAID_SSH_KEY || '/root/.ssh/unraid_secretsman';
const paths = process.argv.slice(2);
if (!paths.length) { console.error('usage: browser-check.js /Main /Docker ...'); process.exit(2); }

function sessionId() {
  const out = execFileSync('ssh', ['-o', 'StrictHostKeyChecking=no', '-i', KEY, `root@${HOST}`,
    'for f in $(ls -t /var/lib/php/sess_*); do grep -q "unraid_user|s:4:\\"root\\"" $f && { echo ${f##*sess_}; break; }; done']).toString().trim();
  if (!out) throw new Error('no active root session found on host');
  return out;
}

function headlessShell() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  const dir = fs.readdirSync(base).find(d => d.startsWith('chromium_headless_shell-'));
  if (!dir) throw new Error('no chromium_headless_shell in ' + base);
  const found = require('child_process').execFileSync('find', [path.join(base, dir), '-name', 'chrome-headless-shell', '-type', 'f']).toString().split('\n')[0];
  if (!found) throw new Error('chrome-headless-shell binary not found');
  return found;
}

// Names that must never appear on window: this plugin's own helpers.
const LEAK_PROBES = ['h', 'API', 'dnmPost', 'dnmRender', 'dnmBanner', 'dnmList', 'renderContainers'];

(async () => {
  const browser = await chromium.launch({ executablePath: headlessShell() });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1012 } });
  await ctx.addCookies([{ name: 'unraid_' + crypto.createHash('md5').update(HOST).digest('hex'), value: sessionId(), domain: HOST, path: '/' }]);
  let bad = 0;
  for (const p of paths) {
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
    const t0 = Date.now();
    await page.goto(`http://${HOST}:81${p}`, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(2500); // let the uptime ticker and page XHRs run
    const ms = Date.now() - t0;
    const r = await page.evaluate(probes => ({
      before: typeof window.before, leaked: probes.filter(k => k in window),
      height: document.documentElement.scrollHeight, hscroll: document.documentElement.scrollWidth > window.innerWidth,
    }), LEAK_PROBES);
    const ok = !errors.length && !r.leaked.length && r.before === 'object';
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${p}  ${ms}ms  typeof before=${r.before}  leaked=[${r.leaked}]  height=${r.height}px  hscroll=${r.hscroll}`);
    errors.forEach(e => console.log('     ' + e));
    await page.close();
  }
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
