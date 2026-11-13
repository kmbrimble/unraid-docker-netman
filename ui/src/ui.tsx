import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { applyTheme, readThemePref, saveThemePref, THEME_KEY, type ThemePref } from './lib'

export interface Toast { id: number; kind: 'ok' | 'alert'; text: string }

/** Toasts carry a word (Success / Error), never colour alone. Errors stay until dismissed; they are never cleared by a refresh. */
export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div class="dnm-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div class="card dnm-toast" key={t.id}>
          <span class={`chip chip--${t.kind}`}>{t.kind === 'ok' ? 'Success' : 'Error'}</span>
          <span class="dnm-toast-text">{t.text}</span>
          <button class="btn btn--ghost" type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss message">Dismiss</button>
        </div>
      ))}
    </div>
  )
}

export function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    ref.current?.querySelector<HTMLElement>('input:not([readonly]), select, button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && ref.current) {
        const list = Array.from(ref.current.querySelectorAll<HTMLElement>('input, select, button, textarea, a[href]')).filter((el) => !(el as HTMLButtonElement).disabled)
        if (!list.length) return
        const a = list[0]
        const z = list[list.length - 1]
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus() }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey); prev?.focus() }
  }, [])
  return (
    <div class="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div class={`modal dnm-modal${wide ? ' dnm-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="dnm-modal-title" ref={ref}>
        <h2 id="dnm-modal-title" class="dnm-modal-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function Field({ label, id, hint, children }: { label: string; id: string; hint?: string; children: ComponentChildren }) {
  return (
    <div class="dnm-field">
      <label for={id} class="dnm-label">{label}</label>
      {children}
      {hint && <div class="dnm-hint">{hint}</div>}
    </div>
  )
}

export function TrashIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /><path d="M10 11v6" /><path d="M14 11v6" />
    </svg>
  )
}

const THEMES: { pref: ThemePref; label: string }[] = [{ pref: 'auto', label: 'Auto' }, { pref: 'light', label: 'Light' }, { pref: 'dark', label: 'Dark' }]

/** Auto follows the Unraid theme (the default). The choice is kept in localStorage, shared by the tab's iframe and the standalone page. */
export function ThemeSwitch() {
  const [pref, setPref] = useState<ThemePref>(() => readThemePref())
  useEffect(() => { applyTheme(pref) }, [pref])
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === THEME_KEY) setPref(readThemePref()) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  const choose = (p: ThemePref) => { saveThemePref(p); setPref(p) }
  return (
    <div class="dnm-theme" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.pref} type="button" class="btn btn--ghost dnm-theme-btn" aria-pressed={pref === t.pref}
          title={t.pref === 'auto' ? 'Follow the Unraid theme' : `Always ${t.label.toLowerCase()}`} onClick={() => choose(t.pref)}>
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** A labelled checkbox with a 44px target, for the two persisted toggles. */
export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label class="dnm-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)} />
      <span>{label}</span>
    </label>
  )
}
