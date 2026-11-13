export class ApiError extends Error {}

export interface Row { network: string; ip: string | null; alias: string | null; mac: string | null }
export interface Live { ip: string | null; mac?: string | null }
export interface Container {
  name: string
  repository: string
  primary: string
  primary_ip: string
  primary_mac: string
  primary_mac_supported: boolean
  path: 'extra' | 'post' | null
  rows: Row[]
  /** Unraid 7.4's native "Additional Networks" names (absent from servers that do not know about it). */
  native_networks?: string[]
  native_overlap?: string[]
  manually_managed: boolean
  running: boolean
  live_networks: Record<string, Live>
  installed: boolean
  no_template: boolean
}
export interface NetMember { name: string; ip: string | null; mac?: string | null }
export interface Network {
  name: string
  driver: string
  internal: boolean
  subnets: { subnet: string | null; gateway: string | null; ip_range?: string | null }[]
  containers: NetMember[]
}
export interface AdoptPlan { ok: boolean; mode: string; field?: string; before?: string; after?: string; error?: string }
export interface ApplyAction { op: string; network: string; ok: boolean; error: string | null }

/**
 * POST urlencoded with the CSRF token as both a body field and a header. Never multipart: this host's nginx
 * auth_request times out on multipart bodies. A CSRF failure is HTTP 200 with an empty body (csrf_terminate()
 * exits without a status), so an empty body is reported as exactly that.
 */
export async function postRaw<T extends { ok?: boolean; error?: string | null }>(
  url: string,
  data: Record<string, string>,
  csrf: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const body = new URLSearchParams({ ...data, csrf_token: csrf }).toString()
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf },
      body,
    })
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.')
  }
  const text = await res.text()
  if (text === '') {
    throw new ApiError('The server returned an empty response: your session or security token has probably expired. Reload this page.')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(`The server returned something unreadable (HTTP ${res.status}).`)
  }
}

/** Like postRaw, but ok:false becomes an ApiError carrying the server's message. */
export async function postJson<T extends { ok?: boolean; error?: string | null } = { ok: boolean }>(
  url: string,
  data: Record<string, string>,
  csrf: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const json = await postRaw<T>(url, data, csrf, fetchImpl)
  if (!json.ok) throw new ApiError(json.error || 'The request failed.')
  return json
}

export const primaryName = (c: Container): string => c.primary.split(':')[0]

/** Reserved networks: never deletable, never an additional-network target. Same rule as the old page and the server. */
export const isProtectedNet = (name: string): boolean => /^(bridge|host|none)$/.test(name) || /^br\d/.test(name)

export type SyncState = 'notemplate' | 'previous' | 'overlap' | 'stopped' | 'manual' | 'sync' | 'drift'

/** Precedence is deliberate and unchanged from the old settings page. */
export function syncState(c: Container): SyncState {
  if (c.no_template) return 'notemplate'
  if (!c.installed) return 'previous'
  if ((c.native_overlap ?? []).length) return 'overlap'
  if (!c.running) return 'stopped'
  if (c.manually_managed) return 'manual'
  const desired = c.rows.map((r) => r.network)
  const live = Object.keys(c.live_networks).filter((n) => n !== primaryName(c))
  return desired.length === live.length && desired.every((n) => live.includes(n)) ? 'sync' : 'drift'
}

export const driftNames = (list: Container[]): string[] => list.filter((c) => syncState(c) === 'drift').map((c) => c.name)

/** Networks shown as chips: the template's rows, or (no template) whatever is live besides the primary. */
export function extraNets(c: Container): { network: string; ip: string | null }[] {
  if (c.no_template) {
    return Object.keys(c.live_networks).filter((n) => n !== primaryName(c)).map((n) => ({ network: n, ip: c.live_networks[n].ip }))
  }
  return c.rows
}

/**
 * The row payload for `save`. Trimmed, empty optionals null, rows without a network dropped: the server compares what
 * it parses back against state.json, so a different shape here could flip a container to "manually managed".
 */
export function normalizeRows(rows: { network: string; ip: string | null; alias: string | null; mac: string | null }[]): Row[] {
  const out: Row[] = []
  for (const r of rows) {
    const network = (r.network ?? '').trim()
    if (!network) continue
    out.push({ network, ip: (r.ip ?? '').trim() || null, alias: (r.alias ?? '').trim() || null, mac: (r.mac ?? '').trim() || null })
  }
  return out
}

export function filterContainers(list: Container[], o: { onlyExtra: boolean; query: string }): Container[] {
  const q = o.query.trim().toLowerCase()
  return list.filter((c) => {
    if (o.onlyExtra && extraNets(c).length === 0) return false
    if (!q) return true
    return `${c.name} ${c.primary} ${extraNets(c).map((n) => n.network).join(' ')}`.toLowerCase().includes(q)
  })
}

export const compareNames = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' })

// Per-browser toggle state. Keys are the old settings page's (`dnm.<key>`, '1'/'0'); storage can be blocked, so never throw.
export function getFlag(key: string, storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try { return storage.getItem('dnm.' + key) === '1' } catch { return false }
}
export function setFlag(key: string, on: boolean, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try { storage.setItem('dnm.' + key, on ? '1' : '0') } catch { /* blocked storage: the toggle just does not persist */ }
}

export type ThemePref = 'auto' | 'light' | 'dark'
export const THEME_KEY = 'netman-theme'
export const parseThemePref = (raw: string | null | undefined): ThemePref => (raw === 'light' || raw === 'dark' ? raw : 'auto')

export function readThemePref(storage: Pick<Storage, 'getItem'> = localStorage): ThemePref {
  try { return parseThemePref(storage.getItem(THEME_KEY)) } catch { return 'auto' }
}
export function saveThemePref(pref: ThemePref, storage: Pick<Storage, 'setItem'> = localStorage): boolean {
  try { storage.setItem(THEME_KEY, pref); return true } catch { return false }
}
/** auto = the theme the server derived from the Unraid setting (data-server-theme); light/dark override it. */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', pref === 'auto' ? (root.dataset.serverTheme === 'dark' ? 'dark' : 'light') : pref)
}

/** The shared parse/build code (plugin/docker-netman-core.js, loaded by app/index.php) for the live fragment preview. */
interface Core {
  buildNetworkRun(primary: string, rows: Row[], mac: string | null, macSupported: boolean): string
  buildConnectChain(name: string, rows: Row[]): string
}
export function fragmentFor(c: Container, rows: Row[], core: Core | undefined = (window as unknown as { dockerNetman?: Core }).dockerNetman): string {
  if (!core || !c.path) return ''
  if (c.path === 'extra') return core.buildNetworkRun(c.primary, rows, c.primary_mac || null, !!c.primary_mac_supported)
  const chain = core.buildConnectChain(c.name, rows)
  return chain === '' ? '' : '&& ' + chain
}

export function applyMessage(r: { error?: string | null; actions?: ApplyAction[] }): string {
  return r.error || (r.actions ?? []).filter((a) => !a.ok).map((a) => `${a.op} ${a.network}: ${a.error}`).join('; ') || 'Apply failed.'
}
