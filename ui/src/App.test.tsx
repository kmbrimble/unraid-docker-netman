import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { App } from './App'
import type { Container, Network } from './lib'

type Req = Record<string, string>
const ctn = (o: Partial<Container>): Container => ({
  name: 'x', repository: '', primary: 'bridge', primary_ip: '', primary_mac: '', primary_mac_supported: false, path: 'post', rows: [],
  native_networks: [], native_overlap: [], manually_managed: false, running: true, installed: true, no_template: false,
  live_networks: { bridge: { ip: '172.17.0.5' } }, ...o,
})
const R = (network: string, ip: string | null = null) => ({ network, ip, alias: null, mac: null })
const nets: Network[] = [
  { name: 'proxynet', driver: 'bridge', internal: false, subnets: [{ subnet: '172.18.0.0/16', gateway: '172.18.0.1' }], containers: [{ name: 'Grafana', ip: '172.18.0.4' }] },
  { name: 'br0', driver: 'ipvlan', internal: false, subnets: [], containers: [] },
  { name: 'spare', driver: 'bridge', internal: false, subnets: [], containers: [] },
]
let containers: Container[]
let calls: Req[]
let replies: Record<string, (d: Req) => unknown>
let delays: Record<string, number>
let root: HTMLElement

const fetchStub = (async (_u: string, init: RequestInit) => {
  const d = Object.fromEntries(new URLSearchParams(String(init.body))) as Req
  calls.push(d)
  if (delays[d.action]) await new Promise((r) => setTimeout(r, delays[d.action]))
  const fn = replies[d.action]
  return { status: 200, text: async () => JSON.stringify(fn ? fn(d) : { ok: true }) }
}) as unknown as typeof fetch

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const click = (el: Element | null) => act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const type = (el: HTMLInputElement, v: string) => act(() => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) })
const byText = (sel: string, t: string) => Array.from(root.querySelectorAll(sel)).find((e) => (e.textContent ?? '').trim() === t) as HTMLElement | undefined
const named = () => Array.from(root.querySelectorAll('.dnm-ctn .dnm-name')).map((e) => e.textContent)
const sent = (action: string) => calls.filter((c) => c.action === action)

async function mount() {
  await act(async () => { render(<App csrf="TOK" fetchImpl={fetchStub} />, root) })
  await flush(); await flush()
}

beforeEach(() => {
  localStorage.clear()
  root = document.createElement('div'); document.body.appendChild(root)
  calls = []
  delays = {}
  containers = [
    ctn({ name: 'Grafana', rows: [R('proxynet')], live_networks: { bridge: { ip: '1' }, proxynet: { ip: '172.18.0.4' } } }),
    ctn({ name: 'alpha', rows: [R('proxynet')], live_networks: { bridge: { ip: '1' } } }), // drift
    ctn({ name: 'Beta', manually_managed: true, running: true, rows: [R('proxynet')], live_networks: { bridge: { ip: '1' }, proxynet: { ip: '2' } } }),
    ctn({ name: 'gone', installed: false, running: false, rows: [R('proxynet')] }),
    ctn({ name: 'plain', no_template: true, path: null, live_networks: { bridge: { ip: '1' }, other: { ip: '9' } } }),
  ]
  replies = {
    containers: (d) => ({ ok: true, containers: d.include_previous === '1' ? containers : containers.filter((c) => c.installed) }),
    networks: () => ({ ok: true, networks: nets }),
  }
  ;(window as unknown as { dockerNetman: unknown }).dockerNetman = {
    buildNetworkRun: (p: string, rows: { network: string }[]) => `RUN ${p} ${rows.map((r) => r.network).join(',')}`,
    buildConnectChain: (n: string, rows: { network: string }[]) => (rows.length ? `CHAIN ${n} ${rows.map((r) => r.network).join(',')}` : ''),
  }
})
afterEach(() => { render(null, root); root.remove() })

describe('containers list (parity with the old settings page)', () => {
  it('lists installed containers in server order with a sync chip each; previous apps only when toggled', async () => {
    await mount()
    expect(named()).toEqual(['Grafana', 'alpha', 'Beta', 'plain'])
    const chips = Array.from(root.querySelectorAll('.dnm-ctn')).map((li) => Array.from(li.querySelectorAll('.dnm-line > .chip')).pop()?.textContent)
    expect(chips).toEqual(['In sync', 'Drift', 'Manually managed', 'No template'])
    const prev = Array.from(root.querySelectorAll('.dnm-toggle')).find((l) => l.textContent === 'Show previous apps')!.querySelector('input')!
    await click(prev); await flush()
    expect(named()).toContain('gone')
    expect(sent('containers').map((c) => c.include_previous)).toEqual(['0', '1'])
    expect(localStorage.getItem('dnm.showPrev')).toBe('1')
  })

  it('a template-less container is read-only: no Edit button', async () => {
    await mount()
    const li = Array.from(root.querySelectorAll('.dnm-ctn')).find((l) => l.textContent!.includes('plain'))!
    expect(li.querySelector('button')).toBeNull()
    expect(li.textContent).toContain('Read-only')
    expect(li.textContent).toContain('other · 9')
  })

  it('"Only with additional networks" hides containers without any, and persists', async () => {
    await mount()
    containers.push(ctn({ name: 'solo' }))
    await click(byText('button', 'Refresh') ?? null); await flush()
    expect(named()).toContain('solo')
    const only = Array.from(root.querySelectorAll('.dnm-toggle')).find((l) => l.textContent === 'Only with additional networks')!.querySelector('input')!
    await click(only)
    expect(named()).not.toContain('solo')
    expect(localStorage.getItem('dnm.onlyExtra')).toBe('1')
  })

  it('search filters by name or network', async () => {
    await mount()
    await type(root.querySelector('#dnm-search')!, 'GRAF')
    expect(named()).toEqual(['Grafana'])
  })
})

describe('editor', () => {
  const edit = async (name: string) => { await click(root.querySelector(`button[aria-label="Edit networks for ${name}"]`)); await flush() }

  it('opens one editor at a time and shows the live fragment from the shared core', async () => {
    await mount()
    await edit('Grafana')
    expect(root.querySelectorAll('.dnm-editor').length).toBe(1)
    expect(root.querySelector('.dnm-fragment')!.textContent).toBe('&& CHAIN Grafana proxynet')
    await edit('alpha')
    expect(root.querySelectorAll('.dnm-editor').length).toBe(1)
    expect(root.querySelector('.dnm-ctn:nth-child(2) .dnm-editor')).not.toBeNull()
  })

  it('save posts the NORMALISED payload (trimmed, nulls, blank rows dropped)', async () => {
    await mount(); await edit('Grafana')
    const first = root.querySelector('input[aria-label="Network 1"]') as HTMLInputElement
    await type(first, '  proxynet  ')
    await type(root.querySelector('input[aria-label="IP 1 (optional)"]')!, ' 172.18.0.9 ')
    await click(byText('button', 'Add network')!)       // a blank row, which must be dropped
    replies.save = () => ({ ok: true, path: 'post' })
    await click(byText('button', 'Save')!); await flush()
    expect(sent('save')).toHaveLength(1)
    expect(sent('save')[0].name).toBe('Grafana')
    expect(JSON.parse(sent('save')[0].rows)).toEqual([{ network: 'proxynet', ip: '172.18.0.9', alias: null, mac: null }])
    expect(sent('save')[0].csrf_token).toBe('TOK')
    expect(root.querySelector('.dnm-toast')!.textContent).toContain('PostArgs updated')
  })

  it('after Save the editor shows the RELOADED rows even when the reload is slow (no stale remount, no revert on 2nd Save)', async () => {
    await mount(); await edit('Grafana')
    await click(byText('button', 'Add network')!)
    await type(root.querySelectorAll('input[aria-label="Network 2"]')[0] as HTMLInputElement, 'spare')
    replies.save = () => { containers[0] = ctn({ ...containers[0], rows: [R('proxynet'), R('spare')] }); return { ok: true, path: 'post' } }
    delays.containers = 30
    await click(byText('button', 'Save')!)
    await act(async () => { await new Promise((r) => setTimeout(r, 10)) })
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
    expect(root.querySelectorAll('.dnm-editor input[aria-label^="Network "]').length).toBe(2)
    expect(root.querySelector('.dnm-fragment')!.textContent).toBe('&& CHAIN Grafana proxynet,spare')
  })

  it('MAC is disabled on the PostArgs path and enabled on ExtraParams', async () => {
    containers[0] = ctn({ name: 'Grafana', path: 'extra', rows: [R('proxynet')] })
    await mount(); await edit('Grafana')
    expect((root.querySelector('input[aria-label="MAC 1 (optional)"]') as HTMLInputElement).disabled).toBe(false)
    await edit('alpha')
    expect((root.querySelector('input[aria-label="MAC 1 (optional)"]') as HTMLInputElement).disabled).toBe(true)
  })

  it('a save error is shown as an Error toast and the editor stays open', async () => {
    await mount(); await edit('Grafana')
    replies.save = () => ({ ok: false, error: 'manually managed: nope' })
    await click(byText('button', 'Save')!); await flush()
    expect(root.querySelector('.dnm-toast .chip--alert')).not.toBeNull()
    expect(root.querySelector('.dnm-toast')!.textContent).toContain('manually managed: nope')
    expect(root.querySelector('.dnm-editor')).not.toBeNull()
  })

  it('Apply now is disabled for a container that no longer exists', async () => {
    await mount()
    await click(Array.from(root.querySelectorAll('.dnm-toggle')).find((l) => l.textContent === 'Show previous apps')!.querySelector('input')!); await flush()
    await edit('gone')
    expect((byText('button', 'Apply now') as HTMLButtonElement).disabled).toBe(true)
  })

  it('a failed apply reports the failing actions', async () => {
    await mount(); await edit('alpha')
    replies.apply = () => ({ ok: false, actions: [{ op: 'connect', network: 'proxynet', ok: false, error: 'boom' }] })
    await click(byText('button', 'Apply now')!); await flush()
    expect(root.querySelector('.dnm-toast')!.textContent).toContain('connect proxynet: boom')
  })

  it('native-field networks and overlap are shown (7.4 data is optional)', async () => {
    containers[0] = ctn({ name: 'Grafana', rows: [R('proxynet')], native_networks: ['proxynet'], native_overlap: ['proxynet'] })
    await mount()
    expect(root.querySelector('.dnm-ctn')!.textContent).toContain('proxynet (native field)')
    expect(root.querySelector('.dnm-ctn .chip--alert')!.textContent).toBe('In both native field and NetMan')
    await edit('Grafana')
    expect(root.querySelector('.dnm-editor')!.textContent).toContain('listed in BOTH the native Additional Networks field')
    expect(root.querySelector('.dnm-editor')!.textContent).toContain('come from the native Additional Networks field')
  })
})

describe('adopt', () => {
  it('dry-runs first, confirms with the plan, then commits and offers live IPs', async () => {
    await mount()
    await click(root.querySelector('button[aria-label="Edit networks for Beta"]')); await flush()
    replies.adopt = (d) => (d.dry_run ? { ok: true, mode: 'normalise', field: 'PostArgs', before: 'OLD', after: 'NEW' } : { ok: true })
    await click(byText('button', 'Adopt')!); await flush()
    expect(sent('adopt')).toHaveLength(1)
    expect(sent('adopt')[0].dry_run).toBe('1')
    const modal = root.querySelector('.modal')!
    expect(modal.textContent).toContain('OLD'); expect(modal.textContent).toContain('NEW'); expect(modal.textContent).toContain('normalised')
    await click(byText('.modal button', 'Adopt')!); await flush(); await flush()
    expect(sent('adopt')).toHaveLength(2)
    expect(sent('adopt')[1].dry_run).toBeUndefined()
    expect(root.querySelector('.modal')).toBeNull()
    expect(root.querySelector('.dnm-editor')).not.toBeNull()
    expect(root.querySelector('.dnm-editor')!.textContent).toContain('currently 2')
  })

  it('a refused dry run adopts nothing', async () => {
    await mount()
    await click(root.querySelector('button[aria-label="Edit networks for Beta"]')); await flush()
    replies.adopt = () => ({ ok: false, mode: 'refuse', error: 'token not accounted for' })
    await click(byText('button', 'Adopt')!); await flush()
    expect(root.querySelector('.modal')).toBeNull()
    expect(sent('adopt')).toHaveLength(1)
    expect(root.querySelector('.dnm-toast')!.textContent).toContain('token not accounted for')
  })

  it('state_only plan says the template is not touched', async () => {
    await mount()
    await click(root.querySelector('button[aria-label="Edit networks for Beta"]')); await flush()
    replies.adopt = () => ({ ok: true, mode: 'state_only', field: 'ExtraParams', before: 'SAME' })
    await click(byText('button', 'Adopt')!); await flush()
    expect(root.querySelector('.modal')!.textContent).toContain('template is not touched')
  })
})

describe('Apply all', () => {
  it('is enabled only with drift, asks first, then applies drift containers only, one at a time', async () => {
    await mount()
    const btn = () => byText('button', 'Apply all') as HTMLButtonElement
    expect(btn().disabled).toBe(false)
    await click(btn()); await flush()
    expect(sent('apply')).toHaveLength(0)              // the confirm comes first
    expect(root.querySelector('.modal')!.textContent).toContain('alpha')
    expect(root.querySelector('.modal')!.textContent).not.toContain('Grafana')
    await click(byText('.modal button', 'Apply all')!); await flush(); await flush()
    expect(sent('apply').map((c) => c.name)).toEqual(['alpha'])
  })
  it('is disabled when nothing drifts', async () => {
    containers = [containers[0]]
    await mount()
    expect((byText('button', 'Apply all') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('networks', () => {
  it('lists case-insensitively sorted networks; protected ones have no delete; members expand', async () => {
    await mount()
    const rows = Array.from(root.querySelectorAll('.dnm-netrow'))
    expect(rows.map((r) => r.querySelector('.dnm-name')!.textContent)).toEqual(['br0', 'proxynet', 'spare'])
    expect(rows[0].querySelector('button[aria-label^="Delete"]')).toBeNull()
    expect(rows[1].textContent).toContain('172.18.0.0/16 · gw 172.18.0.1')
    expect((rows[1].querySelector('button[aria-label="Delete network proxynet"]') as HTMLButtonElement).disabled).toBe(true)
    await click(rows[1].querySelector('button[aria-expanded]'))
    expect(rows[1].querySelector('.dnm-members')!.textContent).toContain('Grafana · 172.18.0.4')
  })

  it('create posts every field including internal and parent, and reports a server error inside the dialog', async () => {
    await mount()
    await click(byText('button', 'Create network')!)
    await type(document.querySelector('#dnm-n-name')!, 'lan2')
    await type(document.querySelector('#dnm-n-parent')!, 'eth0')
    await click(Array.from(document.querySelectorAll('.dnm-toggle input')).slice(-1)[0])
    replies.network_create = () => ({ ok: false, error: 'pool overlaps' })
    await click(byText('.modal button', 'Create')!); await flush()
    const p = sent('network_create')[0]
    expect(p).toMatchObject({ name: 'lan2', driver: 'bridge', parent: 'eth0', internal: '1', subnet: '', gateway: '', ip_range: '' })
    expect(root.querySelector('.modal')!.textContent).toContain('pool overlaps')
    replies.network_create = () => ({ ok: true, error: null })
    await click(byText('.modal button', 'Create')!); await flush(); await flush()
    expect(root.querySelector('.modal')).toBeNull()
  })

  it('delete asks first; only the confirm posts', async () => {
    await mount()
    await click(root.querySelector('button[aria-label="Delete network spare"]')); await flush()
    expect(sent('network_delete')).toHaveLength(0)
    await click(byText('.modal button', 'Delete network')!); await flush()
    expect(sent('network_delete')[0].name).toBe('spare')
  })
})

describe('shell', () => {
  it('Collapse all / Expand all drive both cards', async () => {
    await mount()
    await click(byText('button', 'Collapse all')!)
    expect(root.querySelectorAll('.dnm-body').length).toBe(0)
    await click(byText('button', 'Expand all')!)
    expect(root.querySelectorAll('.dnm-body').length).toBe(2)
  })
  it('search re-opens a collapsed card', async () => {
    await mount()
    await click(byText('button', 'Collapse all')!)
    await type(root.querySelector('#dnm-search')!, 'spare')
    expect(root.querySelectorAll('.dnm-body').length).toBe(2)
    expect(Array.from(root.querySelectorAll('.dnm-netrow .dnm-name')).map((e) => e.textContent)).toEqual(['spare'])
  })
  it('a load failure is a visible error, not a blank card', async () => {
    replies.containers = () => ({ ok: false, error: 'docker unreachable' })
    await mount()
    expect(root.textContent).toContain('docker unreachable')
  })
  it('every request is urlencoded with the token as a field (api.php has no multipart path)', async () => {
    await mount()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.csrf_token === 'TOK')).toBe(true)
  })
})
