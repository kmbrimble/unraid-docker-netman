import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyTheme, driftNames, extraNets, filterContainers, getFlag, isProtectedNet, normalizeRows, parseThemePref, postJson,
  readThemePref, saveThemePref, setFlag, syncState, THEME_KEY, type Container,
} from './lib'

const base: Container = {
  name: 'Grafana', repository: '', primary: 'bridge', primary_ip: '', primary_mac: '', primary_mac_supported: false, path: 'post',
  rows: [], native_networks: [], native_overlap: [], manually_managed: false, running: true, installed: true, no_template: false,
  live_networks: { bridge: { ip: '172.17.0.5' } },
}
const c = (o: Partial<Container>): Container => ({ ...base, ...o })

describe('syncState precedence (parity with the old page)', () => {
  it('no template wins over everything', () => expect(syncState(c({ no_template: true, installed: false }))).toBe('notemplate'))
  it('a template with no container is "previous"', () => expect(syncState(c({ installed: false }))).toBe('previous'))
  it('native overlap beats stopped and manual', () =>
    expect(syncState(c({ native_overlap: ['proxynet'], running: false, manually_managed: true }))).toBe('overlap'))
  it('stopped beats manual', () => expect(syncState(c({ running: false, manually_managed: true }))).toBe('stopped'))
  it('manual beats sync/drift', () => expect(syncState(c({ manually_managed: true, rows: [{ network: 'x', ip: null, alias: null, mac: null }] }))).toBe('manual'))
  it('in sync when desired equals live minus the primary', () =>
    expect(syncState(c({ rows: [{ network: 'proxynet', ip: null, alias: null, mac: null }], live_networks: { bridge: { ip: '1' }, proxynet: { ip: '2' } } }))).toBe('sync'))
  it('drift when a desired network is not live', () =>
    expect(syncState(c({ rows: [{ network: 'proxynet', ip: null, alias: null, mac: null }] }))).toBe('drift'))
  it('drift when a live extra network is not desired', () =>
    expect(syncState(c({ live_networks: { bridge: { ip: '1' }, stray: { ip: '2' } } }))).toBe('drift'))
  it('the primary is the part of "primary" before a colon', () =>
    expect(syncState(c({ primary: 'container:foo', live_networks: { container: { ip: '' } } }))).toBe('sync'))
})

describe('extraNets', () => {
  it('uses the template rows when there is a template', () => {
    const rows = [{ network: 'a', ip: '1.1.1.1', alias: null, mac: null }]
    expect(extraNets(c({ rows }))).toEqual(rows)
  })
  it('without a template, falls back to live networks except the primary', () =>
    expect(extraNets(c({ no_template: true, live_networks: { bridge: { ip: '1' }, other: { ip: '2' } } }))).toEqual([{ network: 'other', ip: '2' }]))
})

describe('driftNames', () => {
  it('lists only containers whose state is drift, in order', () => {
    const list = [c({ name: 'a' }), c({ name: 'b', rows: [{ network: 'n', ip: null, alias: null, mac: null }] }), c({ name: 'c', running: false })]
    expect(driftNames(list)).toEqual(['b'])
  })
})

describe('isProtectedNet', () => {
  it.each(['bridge', 'host', 'none', 'br0', 'br0.66'])('%s is protected', (n) => expect(isProtectedNet(n)).toBe(true))
  it.each(['proxynet', 'mybr0', 'Bridge2'])('%s is not', (n) => expect(isProtectedNet(n)).toBe(false))
})

describe('normalizeRows: the payload the server compares against state.json', () => {
  it('trims, turns empty optionals into null, and drops rows with no network', () => {
    expect(normalizeRows([
      { network: '  proxynet ', ip: ' 172.18.0.5 ', alias: '', mac: '  ' },
      { network: '   ', ip: '1.2.3.4', alias: 'x', mac: '' },
    ])).toEqual([{ network: 'proxynet', ip: '172.18.0.5', alias: null, mac: null }])
  })
  it('keeps key order network, ip, alias, mac', () =>
    expect(Object.keys(normalizeRows([{ network: 'n', ip: '', alias: '', mac: '' }])[0])).toEqual(['network', 'ip', 'alias', 'mac']))
})

describe('filterContainers', () => {
  const list = [
    c({ name: 'Grafana', rows: [{ network: 'proxynet', ip: null, alias: null, mac: null }] }),
    c({ name: 'immich', rows: [] }),
  ]
  it('onlyExtra hides containers with no additional networks', () => expect(filterContainers(list, { onlyExtra: true, query: '' }).map((x) => x.name)).toEqual(['Grafana']))
  it('search matches name or network, case-insensitively', () => {
    expect(filterContainers(list, { onlyExtra: false, query: 'GRAF' }).map((x) => x.name)).toEqual(['Grafana'])
    expect(filterContainers(list, { onlyExtra: false, query: 'proxy' }).map((x) => x.name)).toEqual(['Grafana'])
  })
})

describe('toggle flags keep the old dnm.* localStorage keys', () => {
  beforeEach(() => localStorage.clear())
  it('writes "1"/"0" under dnm.<key> and reads them back', () => {
    expect(getFlag('showPrev')).toBe(false)
    setFlag('showPrev', true)
    expect(localStorage.getItem('dnm.showPrev')).toBe('1')
    expect(getFlag('showPrev')).toBe(true)
    setFlag('showPrev', false)
    expect(localStorage.getItem('dnm.showPrev')).toBe('0')
  })
  it('survives blocked storage', () => {
    const bad = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }
    expect(getFlag('x', bad)).toBe(false)
    expect(() => setFlag('x', true, bad)).not.toThrow()
  })
})

describe('theme preference (key netman-theme)', () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('data-theme'); document.documentElement.dataset.serverTheme = 'dark' })
  it('only light and dark are real choices', () => {
    expect(parseThemePref('light')).toBe('light'); expect(parseThemePref('dark')).toBe('dark')
    expect(parseThemePref('purple')).toBe('auto'); expect(parseThemePref(null)).toBe('auto')
  })
  it('persists under one key', () => {
    expect(THEME_KEY).toBe('netman-theme')
    saveThemePref('light'); expect(readThemePref()).toBe('light')
  })
  it('auto follows the server theme; light/dark override', () => {
    applyTheme('auto'); expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    applyTheme('light'); expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })
  it('blocked storage reads as auto', () => expect(readThemePref({ getItem() { throw new Error('x') } })).toBe('auto'))
})

describe('postJson', () => {
  const resp = (text: string, status = 200) => (async () => ({ status, text: async () => text })) as unknown as typeof fetch
  it('sends urlencoded with the token as field and header, never multipart', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return { status: 200, text: async () => '{"ok":true}' } }) as unknown as typeof fetch
    await postJson('../include/api.php', { action: 'networks' }, 'TOK', f)
    const init = seen!.init
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBe('TOK')
    expect(init.body).toContain('csrf_token=TOK'); expect(init.body).toContain('action=networks')
  })
  it('an empty 200 body is reported as an expired session/token', async () =>
    await expect(postJson('u', {}, 't', resp(''))).rejects.toThrow(/empty response/))
  it('ok:false surfaces the server error text', async () =>
    await expect(postJson('u', {}, 't', resp('{"ok":false,"error":"nope"}'))).rejects.toThrow('nope'))
  it('unreadable JSON is reported', async () => await expect(postJson('u', {}, 't', resp('<html>', 502))).rejects.toThrow(/unreadable/))
})
