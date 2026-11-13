import { useEffect, useMemo, useState } from 'preact/hooks'
import { compareNames, isProtectedNet, type Network } from './lib'
import { Field, Modal, TrashIcon } from './ui'
import type { Api, Notify } from './App'

const EMPTY = { name: '', driver: 'bridge', subnet: '', gateway: '', ip_range: '', parent: '', internal: false }

export function Networks({ api, notify, query, open, onToggleOpen, onChanged }: {
  api: Api; notify: Notify; query: string; open: boolean; onToggleOpen: () => void; onChanged: () => void
}) {
  const [nets, setNets] = useState<Network[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [members, setMembers] = useState<Record<string, boolean>>({})
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState(EMPTY)
  const [formError, setFormError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const reload = () =>
    api.post<{ ok: boolean; networks: Network[] }>('networks')
      .then((d) => { setNets([...d.networks].sort((a, b) => compareNames(a.name, b.name))); setLoadError(null) })
      .catch((e: Error) => setLoadError(e.message))
  useEffect(() => { void reload() }, [])

  const q = query.trim().toLowerCase()
  const shown = useMemo(() => (nets ?? []).filter((n) => !q || n.name.toLowerCase().includes(q)), [nets, q])

  const create = async () => {
    setFormError(null)
    try {
      await api.post('network_create', { ...form, internal: form.internal ? '1' : '0' })
      setCreating(false); setForm(EMPTY)
      notify.ok(`Created network ${form.name}.`)
      void reload(); onChanged()
    } catch (e) { setFormError((e as Error).message) }
  }
  const remove = async () => {
    const name = deleting!
    setDeleting(null)
    try {
      await api.post('network_delete', { name })
      notify.ok(`Deleted network ${name}.`)
      void reload(); onChanged()
    } catch (e) { notify.err(e) }
  }
  const set = (k: keyof typeof EMPTY) => (e: Event) => setForm((f) => ({ ...f, [k]: (e.currentTarget as HTMLInputElement).value }))
  const needsParent = form.driver !== 'bridge'

  return (
    <section class="card dnm-block" aria-labelledby="dnm-n-h">
      <div class="dnm-sec-bar">
        <h2 id="dnm-n-h" class="dnm-sec-h">
          <button type="button" class="dnm-sec-toggle" aria-expanded={open} onClick={onToggleOpen}>
            <span class="dnm-chev" aria-hidden="true" />
            <span class="dnm-sec-name">Networks</span>
            {nets && <span class="chip">{shown.length}{shown.length !== nets.length ? ` of ${nets.length}` : ''}</span>}
          </button>
        </h2>
        <button type="button" class="btn btn--secondary dnm-small" onClick={() => void reload()} aria-label="Refresh networks">Refresh</button>
        <button type="button" class="btn btn--secondary dnm-small" onClick={() => { setFormError(null); setCreating(true) }}>Create network</button>
      </div>
      {open && (
        <div class="dnm-body">
          {loadError && <div class="dnm-err" role="alert"><span class="chip chip--alert">Error</span> {loadError}</div>}
          {!nets && !loadError && <p class="dnm-note">Loading&hellip;</p>}
          {nets && (
            <ul class="dnm-rows">
              {shown.map((n) => {
                const subnets = n.subnets.map((s) => s.subnet).filter(Boolean).join(', ')
                const gws = n.subnets.map((s) => s.gateway).filter(Boolean).join(', ')
                const cnt = n.containers.length
                const names = [...n.containers].sort((a, b) => compareNames(a.name, b.name))
                return (
                  <li class="dnm-row dnm-netrow" key={n.name}>
                    <div class="dnm-line">
                      <span class="dnm-name">{n.name}</span>
                      <span class="chip">{n.driver}{n.internal ? ' · internal' : ''}</span>
                      <span class="dnm-primary">{subnets || '—'}{gws ? ` · gw ${gws}` : ''}</span>
                      <span class="dnm-nets">
                        <button type="button" class="btn btn--ghost dnm-small" disabled={cnt === 0} aria-expanded={!!members[n.name]}
                          onClick={() => setMembers((m) => ({ ...m, [n.name]: !m[n.name] }))}>
                          {cnt} container{cnt === 1 ? '' : 's'}
                        </button>
                      </span>
                      {isProtectedNet(n.name)
                        ? <span class="dnm-note" title="Reserved network">Reserved</span>
                        : <button type="button" class="btn-icon dnm-danger" aria-label={`Delete network ${n.name}`} title={cnt ? 'Containers are still attached' : 'Delete network'} disabled={cnt > 0} onClick={() => setDeleting(n.name)}><TrashIcon /></button>}
                    </div>
                    {members[n.name] && cnt > 0 && (
                      <div class="dnm-members">{names.map((m) => <span class="dnm-net" key={m.name}>{m.name}{m.ip ? ` · ${m.ip}` : ''}</span>)}</div>
                    )}
                  </li>
                )
              })}
              {shown.length === 0 && <li class="dnm-row dnm-note">Nothing to show.</li>}
            </ul>
          )}
        </div>
      )}
      {creating && (
        <Modal title="Create network" onClose={() => setCreating(false)} wide>
          <div class="dnm-grid">
            <Field label="Name" id="dnm-n-name"><input id="dnm-n-name" class="input" value={form.name} onInput={set('name')} autocomplete="off" /></Field>
            <Field label="Driver" id="dnm-n-driver">
              <select id="dnm-n-driver" class="input" value={form.driver} onChange={set('driver')}><option>bridge</option><option>ipvlan</option><option>macvlan</option></select>
            </Field>
            <Field label="Subnet" id="dnm-n-subnet" hint="e.g. 172.30.0.0/24"><input id="dnm-n-subnet" class="input" value={form.subnet} onInput={set('subnet')} /></Field>
            <Field label="Gateway" id="dnm-n-gw" hint="e.g. 172.30.0.1"><input id="dnm-n-gw" class="input" value={form.gateway} onInput={set('gateway')} /></Field>
            <Field label="IP range" id="dnm-n-range" hint="e.g. 172.30.0.128/25"><input id="dnm-n-range" class="input" value={form.ip_range} onInput={set('ip_range')} /></Field>
            <Field label="Parent interface" id="dnm-n-parent" hint={needsParent ? 'Required for ipvlan and macvlan, e.g. eth0' : 'Only for ipvlan and macvlan'}>
              <input id="dnm-n-parent" class="input" value={form.parent} onInput={set('parent')} />
            </Field>
          </div>
          <label class="dnm-toggle"><input type="checkbox" checked={form.internal} onChange={(e) => setForm((f) => ({ ...f, internal: (e.currentTarget as HTMLInputElement).checked }))} /><span>Internal (no outside access)</span></label>
          {formError && <div class="dnm-err" role="alert"><span class="chip chip--alert">Error</span> {formError}</div>}
          <div class="dnm-actions">
            <button type="button" class="btn btn--secondary" onClick={() => setCreating(false)}>Cancel</button>
            <button type="button" class="btn btn--primary" onClick={() => void create()}>Create</button>
          </div>
        </Modal>
      )}
      {deleting && (
        <Modal title="Delete network?" onClose={() => setDeleting(null)}>
          <p class="dnm-note">Delete the network <b>{deleting}</b>? This cannot be undone. It is refused while any container is still attached.</p>
          <div class="dnm-actions">
            <button type="button" class="btn btn--secondary" onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" class="btn btn--secondary dnm-danger" onClick={() => void remove()}>Delete network</button>
          </div>
        </Modal>
      )}
    </section>
  )
}
