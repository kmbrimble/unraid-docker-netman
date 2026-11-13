import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { ApiError, postJson, postRaw } from './lib'
import { Toasts, ThemeSwitch, type Toast } from './ui'
import { Containers } from './Containers'
import { Networks } from './Networks'

const API = '../include/api.php'

export interface Api {
  /** ok:false throws an ApiError with the server's message. */
  post: <T extends { ok?: boolean; error?: string | null } = { ok: boolean }>(action: string, data?: Record<string, string>) => Promise<T>
  /** The response as sent, ok:false included (adopt and apply carry detail alongside ok:false). */
  raw: <T extends { ok?: boolean; error?: string | null }>(action: string, data?: Record<string, string>) => Promise<T>
}
export interface Notify { ok: (text: string) => void; err: (e: unknown) => void }

export function App({ csrf, fetchImpl }: { csrf: string; fetchImpl?: typeof fetch }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++seq.current
    setToasts((t) => [...t, { id, kind, text }])
    if (kind === 'ok') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 12000)
  }, [])
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const notify: Notify = useMemo(() => ({
    ok: (text) => push('ok', text),
    err: (e) => push('alert', e instanceof Error ? e.message : String(e)),
  }), [push])
  const api: Api = useMemo(() => ({
    post: (action, data = {}) => postJson(API, { ...data, action }, csrf, fetchImpl),
    raw: (action, data = {}) => postRaw(API, { ...data, action }, csrf, fetchImpl),
  }), [csrf, fetchImpl])

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState({ containers: true, networks: true })
  // Bumped when networks change (create/delete) so the container editors' network suggestions and member counts follow.
  const [netVersion, setNetVersion] = useState(0)

  useEffect(() => {
    if (!csrf) push('alert', 'No security token was provided by the page. Reload it from the NetMan tab.')
  }, [])

  const searching = query.trim() !== ''
  return (
    <div class="dnm-wrap">
      <header class="card dnm-head">
        <div class="dnm-head-top">
          <div>
            <h1 class="dnm-title">Docker NetMan</h1>
            <p class="dnm-sub">Give a container more than one network. Each extra network is saved in the container&rsquo;s own template, so it survives a reinstall or force update.</p>
          </div>
          <ThemeSwitch />
        </div>
        <div class="dnm-toolbar">
          <div class="dnm-search">
            <label for="dnm-search" class="dnm-label">Search containers and networks</label>
            <input id="dnm-search" class="input" type="search" placeholder="Name or network" value={query} autocomplete="off"
              onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="dnm-toolbar-btns">
            <button type="button" class="btn btn--secondary" onClick={() => setOpen({ containers: true, networks: true })}>Expand all</button>
            <button type="button" class="btn btn--secondary" onClick={() => setOpen({ containers: false, networks: false })}>Collapse all</button>
          </div>
        </div>
      </header>
      <Containers api={api} notify={notify} query={query} open={open.containers || searching} netVersion={netVersion}
        onToggleOpen={() => setOpen((o) => ({ ...o, containers: !o.containers }))} />
      <Networks api={api} notify={notify} query={query} open={open.networks || searching}
        onToggleOpen={() => setOpen((o) => ({ ...o, networks: !o.networks }))} onChanged={() => setNetVersion((v) => v + 1)} />
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  )
}

export { ApiError }
