import { useEffect, useMemo, useState } from 'preact/hooks'
import {
  applyMessage, driftNames, extraNets, filterContainers, fragmentFor, getFlag, normalizeRows, primaryName, setFlag, syncState,
  type AdoptPlan, type ApplyAction, type Container, type Row, type SyncState,
} from './lib'
import { Field, Modal, Toggle, TrashIcon } from './ui'
import type { Api, Notify } from './App'

const CHIPS: Record<SyncState, { cls: string; label: string }> = {
  sync: { cls: 'chip--ok', label: 'In sync' },
  drift: { cls: 'chip--warn', label: 'Drift' },
  manual: { cls: 'chip--alert', label: 'Manually managed' },
  overlap: { cls: 'chip--alert', label: 'In both native field and NetMan' },
  stopped: { cls: '', label: 'Stopped' },
  previous: { cls: '', label: 'Previous app' },
  notemplate: { cls: '', label: 'No template' },
}

interface EditRow { id: number; network: string; ip: string; alias: string; mac: string }
let rowSeq = 0
const toEdit = (r: Row): EditRow => ({ id: ++rowSeq, network: r.network, ip: r.ip ?? '', alias: r.alias ?? '', mac: r.mac ?? '' })
const toRows = (rows: EditRow[]): Row[] => normalizeRows(rows.map((r) => ({ network: r.network, ip: r.ip, alias: r.alias, mac: r.mac })))

export function Containers({ api, notify, query, open, onToggleOpen, netVersion }: {
  api: Api; notify: Notify; query: string; open: boolean; onToggleOpen: () => void; netVersion: number
}) {
  const [list, setList] = useState<Container[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showPrev, setShowPrev] = useState(() => getFlag('showPrev'))
  const [onlyExtra, setOnlyExtra] = useState(() => getFlag('onlyExtra'))
  const [openName, setOpenName] = useState<string | null>(null)
  const [hintFor, setHintFor] = useState<string | null>(null)
  const [version, setVersion] = useState(0) // bumped after a save/adopt so the open editor re-reads the server's rows
  const [plan, setPlan] = useState<{ name: string; plan: AdoptPlan } | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [busy, setBusy] = useState(false)
  const [known, setKnown] = useState<string[]>([])

  // Background reload: touches only the list state. Results of user actions live in the toasts, which this never clears.
  const reload = (prev = showPrev) =>
    api.post<{ ok: boolean; containers: Container[] }>('containers', { include_previous: prev ? '1' : '0' })
      .then((d) => { setList(d.containers); setLoadError(null) })
      .catch((e: Error) => setLoadError(e.message))
  useEffect(() => { void reload() }, [showPrev])
  useEffect(() => {
    api.post<{ ok: boolean; networks: { name: string }[] }>('networks').then((d) => setKnown(d.networks.map((n) => n.name))).catch(() => setKnown([]))
  }, [netVersion])

  const shown = useMemo(() => filterContainers(list ?? [], { onlyExtra, query }), [list, onlyExtra, query])
  const drift = list ? driftNames(list) : []

  const doApplyAll = async () => {
    setConfirmAll(false)
    setBusy(true)
    const failed: string[] = []
    for (const name of drift) {
      try {
        const r = await api.raw<{ ok: boolean; error?: string | null; actions?: ApplyAction[] }>('apply', { name })
        if (!r.ok) failed.push(`${name}: ${applyMessage(r)}`)
      } catch (e) { failed.push(`${name}: ${(e as Error).message}`) }
    }
    setBusy(false)
    if (failed.length) notify.err(new Error(`Apply failed for ${failed.length} of ${drift.length}: ${failed.join('; ')}`))
    else notify.ok(`Applied to ${drift.length} container${drift.length === 1 ? '' : 's'}.`)
    void reload()
  }

  const startAdopt = async (name: string) => {
    try {
      const p = await api.raw<AdoptPlan>('adopt', { name, dry_run: '1' })
      if (!p.ok) { notify.err(new Error(`Cannot adopt: ${p.error}`)); return }
      setPlan({ name, plan: p })
    } catch (e) { notify.err(e) }
  }
  const doAdopt = async () => {
    if (!plan) return
    const name = plan.name
    setPlan(null)
    try {
      await api.post('adopt', { name })
      notify.ok(`Adopted ${name}.`)
      setOpenName(name); setHintFor(name); setVersion((v) => v + 1)
      void reload()
    } catch (e) { notify.err(new Error(`Adopt failed: ${(e as Error).message}`)) }
  }

  return (
    <section class="card dnm-block" aria-labelledby="dnm-c-h">
      <div class="dnm-sec-bar">
        <h2 id="dnm-c-h" class="dnm-sec-h">
          <button type="button" class="dnm-sec-toggle" aria-expanded={open} onClick={onToggleOpen}>
            <span class="dnm-chev" aria-hidden="true" />
            <span class="dnm-sec-name">Containers</span>
            {list && <span class="chip">{shown.length}{shown.length !== list.length ? ` of ${list.length}` : ''}</span>}
          </button>
        </h2>
        <button type="button" class="btn btn--secondary dnm-small" aria-label="Refresh containers" onClick={() => void reload()}>Refresh</button>
        <button type="button" class="btn btn--primary dnm-small" disabled={busy || drift.length === 0} onClick={() => setConfirmAll(true)}
          title={drift.length ? `Reconcile ${drift.length} container${drift.length === 1 ? '' : 's'} in drift` : 'No container is in drift'}>
          {busy ? 'Applying…' : 'Apply all'}
        </button>
      </div>
      {open && (
        <div class="dnm-body">
          <div class="dnm-toggles">
            <Toggle label="Show previous apps" checked={showPrev} onChange={(on) => { setFlag('showPrev', on); setShowPrev(on) }} />
            <Toggle label="Only with additional networks" checked={onlyExtra} onChange={(on) => { setFlag('onlyExtra', on); setOnlyExtra(on) }} />
          </div>
          {loadError && <div class="dnm-err" role="alert"><span class="chip chip--alert">Error</span> {loadError}</div>}
          {!list && !loadError && <p class="dnm-note">Loading&hellip;</p>}
          {list && (
            <ul class="dnm-rows">
              {shown.map((c) => (
                <li class={`dnm-row dnm-ctn${c.installed ? '' : ' dnm-prev'}`} key={c.name}>
                  <ContainerLine c={c} isOpen={openName === c.name}
                    onToggle={() => { setHintFor((h) => (h === c.name ? h : null)); setOpenName(openName === c.name ? null : c.name) }} />
                  {openName === c.name && !c.no_template && (
                    <Editor key={`${c.name}:${version}`} c={c} api={api} notify={notify} known={known}
                      hint={hintFor === c.name && c.running}
                      onSaved={() => { setVersion((v) => v + 1); void reload() }}
                      onApplied={() => void reload()}
                      onAdopt={() => void startAdopt(c.name)} />
                  )}
                </li>
              ))}
              {shown.length === 0 && <li class="dnm-row dnm-note">Nothing to show.</li>}
            </ul>
          )}
        </div>
      )}
      {confirmAll && (
        <Modal title="Apply all?" onClose={() => setConfirmAll(false)}>
          <p class="dnm-note">This connects and disconnects live networks on {drift.length} running container{drift.length === 1 ? '' : 's'} so they match their templates. Nothing is recreated or restarted.</p>
          <ul class="dnm-plain">{drift.map((n) => <li key={n}>{n}</li>)}</ul>
          <div class="dnm-actions">
            <button type="button" class="btn btn--secondary" onClick={() => setConfirmAll(false)}>Cancel</button>
            <button type="button" class="btn btn--primary" onClick={() => void doApplyAll()}>Apply all</button>
          </div>
        </Modal>
      )}
      {plan && (
        <Modal title={`Adopt ${plan.name}?`} onClose={() => setPlan(null)} wide>
          {plan.plan.mode === 'state_only' ? (
            <>
              <p class="dnm-note">The {plan.plan.field} block already matches what this plugin would write. Only the plugin&rsquo;s own record (state.json) changes; the template is <b>not</b> touched.</p>
              <pre class="dnm-pre">{plan.plan.before}</pre>
            </>
          ) : (
            <>
              <p class="dnm-note">The block would be rewritten differently, so the template will be <b>normalised</b> ({plan.plan.field} only).</p>
              <p class="dnm-label">Before</p><pre class="dnm-pre">{plan.plan.before}</pre>
              <p class="dnm-label">After</p><pre class="dnm-pre">{plan.plan.after}</pre>
            </>
          )}
          <div class="dnm-actions">
            <button type="button" class="btn btn--secondary" onClick={() => setPlan(null)}>Cancel</button>
            <button type="button" class="btn btn--primary" onClick={() => void doAdopt()}>Adopt</button>
          </div>
        </Modal>
      )}
    </section>
  )
}

function ContainerLine({ c, isOpen, onToggle }: { c: Container; isOpen: boolean; onToggle: () => void }) {
  const st = CHIPS[syncState(c)]
  const ip = c.live_networks[primaryName(c)]?.ip || c.primary_ip
  const natives = c.native_networks ?? []
  return (
    <div class="dnm-line">
      <span class="dnm-name">{c.name}</span>
      <span class={`chip ${c.installed && c.running ? 'chip--ok' : ''}`}>{!c.installed ? 'Not installed' : c.running ? 'Running' : 'Stopped'}</span>
      <span class="dnm-primary"><code>{c.primary || 'unknown'}</code>{ip ? ` · ${ip}` : ''}</span>
      <span class="dnm-nets">
        {extraNets(c).map((n) => (
          <span class="dnm-net" key={n.network}>{n.network}{n.ip ? ` · ${n.ip}` : ''}{natives.includes(n.network) ? ' (native field)' : ''}</span>
        ))}
        {extraNets(c).length === 0 && <span class="dnm-note">no additional networks</span>}
      </span>
      <span class={`chip ${st.cls}`}>{st.label}</span>
      {c.no_template
        ? <span class="dnm-note" title="No dockerMan template: read-only">Read-only</span>
        : <button type="button" class="btn btn--secondary dnm-small" aria-expanded={isOpen} aria-label={`${isOpen ? 'Close' : 'Edit'} networks for ${c.name}`} onClick={onToggle}>{isOpen ? 'Close' : 'Edit'}</button>}
    </div>
  )
}

function Editor({ c, api, notify, known, hint, onSaved, onApplied, onAdopt }: {
  c: Container; api: Api; notify: Notify; known: string[]; hint: boolean; onSaved: () => void; onApplied: () => void; onAdopt: () => void
}) {
  const [rows, setRows] = useState<EditRow[]>(() => c.rows.map(toEdit))
  const [busy, setBusy] = useState(false)
  const macDisabled = c.path === 'post'
  const fragment = fragmentFor(c, toRows(rows))
  const update = (id: number, patch: Partial<EditRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const natives = c.native_networks ?? []
  const overlap = c.native_overlap ?? []

  const save = async () => {
    setBusy(true)
    try {
      const r = await api.post<{ ok: boolean; path: string }>('save', { name: c.name, rows: JSON.stringify(toRows(rows)) })
      notify.ok(`Saved. ${r.path === 'extra' ? 'ExtraParams' : 'PostArgs'} updated in the template.`)
      onSaved()
    } catch (e) { notify.err(e) } finally { setBusy(false) }
  }
  const apply = async () => {
    setBusy(true)
    try {
      const r = await api.raw<{ ok: boolean; error?: string | null; actions?: ApplyAction[] }>('apply', { name: c.name })
      if (r.ok) notify.ok('Applied.'); else notify.err(new Error(applyMessage(r)))
    } catch (e) { notify.err(e) } finally { setBusy(false); onApplied() }
  }

  return (
    <div class="dnm-editor">
      {c.manually_managed && (
        <div class="dnm-err" role="alert"><span class="chip chip--alert">Manually managed</span> {c.path === 'extra' ? 'ExtraParams' : 'PostArgs'} already contains a network block this plugin did not write &mdash; refusing to rewrite it. Remove it by hand first, adopt it, or use the other path.</div>
      )}
      {overlap.length > 0 && (
        <div class="dnm-err" role="alert"><span class="chip chip--alert">Listed twice</span> {overlap.join(', ')} listed in BOTH the native Additional Networks field and NetMan&rsquo;s block &mdash; Unraid would connect it twice and the second connect fails. Save to clear the native field.</div>
      )}
      {natives.length > 0 && <p class="dnm-note">{natives.join(', ')} come from the native Additional Networks field &mdash; they move into NetMan on Save.</p>}
      <datalist id={`dnm-nets-${c.name}`}>{known.filter((n) => n !== primaryName(c)).map((n) => <option key={n} value={n} />)}</datalist>
      {rows.map((r, i) => {
        const liveIp = c.live_networks[r.network]?.ip
        return (
          <div key={r.id} class="dnm-edit-row">
            <div class="dnm-edit-fields">
              <input class="input" aria-label={`Network ${i + 1}`} placeholder="network" list={`dnm-nets-${c.name}`} value={r.network} onInput={(e) => update(r.id, { network: (e.currentTarget as HTMLInputElement).value })} />
              <input class="input" aria-label={`IP ${i + 1} (optional)`} placeholder="ip (optional)" value={r.ip} onInput={(e) => update(r.id, { ip: (e.currentTarget as HTMLInputElement).value })} />
              <input class="input" aria-label={`Alias ${i + 1} (optional)`} placeholder="alias (optional)" value={r.alias} onInput={(e) => update(r.id, { alias: (e.currentTarget as HTMLInputElement).value })} />
              <input class="input" aria-label={`MAC ${i + 1} (optional)`} placeholder="mac (optional)" value={r.mac} disabled={macDisabled}
                title={macDisabled ? 'MAC is not supported on the PostArgs path' : undefined} onInput={(e) => update(r.id, { mac: (e.currentTarget as HTMLInputElement).value })} />
              <button type="button" class="btn-icon dnm-danger" aria-label={`Remove network row ${i + 1}`} title="Remove this row" onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}><TrashIcon /></button>
            </div>
            {hint && liveIp && !r.ip && (
              <div class="dnm-hint">currently {liveIp} &mdash; set as fixed IP?{' '}
                <button type="button" class="btn btn--ghost dnm-small" onClick={() => update(r.id, { ip: liveIp })}>Use it</button></div>
            )}
          </div>
        )
      })}
      {rows.length === 0 && <p class="dnm-note">No additional networks. Add one below.</p>}
      <div class="dnm-edit-meta">
        <Field label="Stored in" id={`dnm-path-${c.name}`}><span id={`dnm-path-${c.name}`}><code>{c.path}</code> ({c.path === 'extra' ? 'ExtraParams' : 'PostArgs'})</span></Field>
        <Field label="Fragment written to the template" id={`dnm-frag-${c.name}`}><code id={`dnm-frag-${c.name}`} class="dnm-fragment">{fragment || '(nothing)'}</code></Field>
      </div>
      <div class="dnm-actions dnm-actions-left">
        <button type="button" class="btn btn--secondary" onClick={() => setRows((rs) => [...rs, toEdit({ network: '', ip: null, alias: null, mac: null })])}>Add network</button>
        <button type="button" class="btn btn--primary" disabled={busy} onClick={() => void save()}>Save</button>
        {c.manually_managed && <button type="button" class="btn btn--secondary" disabled={busy} onClick={onAdopt}>Adopt</button>}
        <button type="button" class="btn btn--secondary" disabled={busy || !c.installed}
          title={c.installed ? 'Connect/disconnect live networks to match the template (no restart)' : 'Nothing to apply to: this container no longer exists'} onClick={() => void apply()}>Apply now</button>
      </div>
    </div>
  )
}
