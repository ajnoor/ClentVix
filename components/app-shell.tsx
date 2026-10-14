'use client'

import useSWR from 'swr'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpRight, BarChart3, Bell, Check, ChevronDown, CircleHelp, ExternalLink, Filter, LayoutDashboard, Lightbulb,
  ListFilter, Loader2, Menu, MoreHorizontal, Plus, RefreshCw, Search, Settings, Sparkles, Target, Trash2, Users, X, Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { signOutAction } from '@/app/actions'
import { STAGES, type DiscoveryResult, type DiscoveryRun, type ProviderStatus, type Prospect, type Stage, type UserSettings } from '@/lib/types'
import { FOCUS_OPTIONS } from '@/lib/validation-options'

class ApiError extends Error {}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body && !(init.headers as Record<string, string> | undefined)?.['content-type'] ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError((body as { error?: string }).error ?? `Request failed (${response.status}).`)
  return body as T
}
const fetcher = <T,>(url: string) => api<T>(url)

const safeHref = (value: string | null | undefined) => (value && /^https?:\/\//i.test(value) ? value : undefined)
const initials = (name: string) => name.split(/\s+/).map((p) => p[0] ?? '').join('').slice(0, 2).toUpperCase() || '?'
const COLORS = ['violet', 'blue', 'amber', 'rose']
const colorFor = (id: string) => COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length]
const ago = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`
}

type Nav = 'Overview' | 'Discover' | 'Pipeline' | 'Saved prospects' | 'Settings'
const navItems: Array<{ label: Nav; icon: typeof Target }> = [
  { label: 'Overview', icon: LayoutDashboard }, { label: 'Discover', icon: Target }, { label: 'Pipeline', icon: BarChart3 }, { label: 'Saved prospects', icon: Users },
]
type Filters = { query: string; stage: Stage | 'All'; priority: 'All' | 'High' | 'Medium' | 'Low'; verifiedOnly: boolean; minScore: number }
const noFilters: Filters = { query: '', stage: 'All', priority: 'All', verifiedOnly: false, minScore: 0 }

export function AppShell({ user }: { user: { name: string | null; email: string | null } }) {
  const [nav, setNav] = useState<Nav>('Overview')
  const [mobileNav, setMobileNav] = useState(false)
  const [showDiscovery, setShowDiscovery] = useState(false)
  const [showNotifs, setShowNotifs] = useState(false)
  const [showProfile, setShowProfile] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filters, setFilters] = useState<Filters>(noFilters)
  const [actionError, setActionError] = useState<string | null>(null)

  const prospectsQ = useSWR<{ prospects: Prospect[] }>('/api/prospects', fetcher)
  const settingsQ = useSWR<{ settings: UserSettings }>('/api/settings', fetcher)
  const statusQ = useSWR<{ status: ProviderStatus }>('/api/status', fetcher)
  const notifsQ = useSWR<{ notifications: DiscoveryRun[] }>('/api/notifications', fetcher, { refreshInterval: 60000 })

  const prospects = useMemo(() => prospectsQ.data?.prospects ?? [], [prospectsQ.data])
  const selected = prospects.find((p) => p.id === selectedId) ?? null
  const unread = (notifsQ.data?.notifications ?? []).filter((n) => n.unread).length

  const filtered = useMemo(() => prospects.filter((p) => {
    const q = filters.query.trim().toLowerCase()
    if (q && !`${p.name} ${p.domain} ${p.category} ${p.location}`.toLowerCase().includes(q)) return false
    if (filters.stage !== 'All' && p.stage !== filters.stage) return false
    if (filters.priority !== 'All' && p.priority !== filters.priority) return false
    if (filters.verifiedOnly && p.verificationStatus !== 'verified') return false
    if (filters.minScore > 0 && (p.score ?? -1) < filters.minScore) return false
    return true
  }), [prospects, filters])
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(noFilters)

  async function patch(id: string, change: { stage?: Stage; saved?: boolean }) {
    setActionError(null)
    try {
      await api('/api/prospects', { method: 'PATCH', body: JSON.stringify({ id, ...change }) })
      await prospectsQ.mutate()
    } catch (e) { setActionError(e instanceof Error ? e.message : 'Update failed.') }
  }
  async function remove(id: string) {
    if (!window.confirm('Delete this prospect permanently?')) return
    try { await api(`/api/prospects?id=${id}`, { method: 'DELETE' }); setSelectedId(null); await prospectsQ.mutate() }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Delete failed.') }
  }
  async function analyze(id: string) {
    setActionError(null)
    try { await api(`/api/prospects/${id}/analyze`, { method: 'POST' }) }
    catch (e) { setActionError(e instanceof Error ? e.message : 'Analysis failed.') }
    await prospectsQ.mutate()
  }
  async function toggleNotifs() {
    const next = !showNotifs
    setShowNotifs(next); setShowProfile(false)
    if (next && unread > 0) { await api('/api/notifications', { method: 'POST' }).catch(() => {}); await notifsQ.mutate() }
  }
  const go = (n: Nav) => { setNav(n); setMobileNav(false) }
  const display = user.name ?? user.email ?? 'You'

  const sidebar = (
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Sparkles size={17} /></div><span>clentvix</span></div>
      <div className="workspace-switcher"><div className="workspace-avatar">{initials(display)}</div><div><p>{settingsQ.data?.settings.serviceName || display}</p><span>Personal workspace</span></div></div>
      <nav className="nav-list" aria-label="Main navigation">
        <p className="eyebrow">Workspace</p>
        {navItems.map(({ label, icon: Icon }) => (
          <button key={label} className={`nav-item ${nav === label ? 'active' : ''}`} onClick={() => go(label)}>
            <Icon size={17} /><span>{label}</span>
            {label === 'Discover' && prospects.length > 0 && <span className="nav-pill">{prospects.length}</span>}
          </button>
        ))}
        <p className="eyebrow nav-spacer">Manage</p>
        <button className={`nav-item ${nav === 'Settings' ? 'active' : ''}`} onClick={() => go('Settings')}><Settings size={17} /><span>Settings</span></button>
      </nav>
      <div className="sidebar-bottom">
        <button className="help-box" style={{ width: '100%', border: 0, textAlign: 'left' }} onClick={() => setShowHelp((v) => !v)}><CircleHelp size={17} /><div><strong>Need a hand?</strong><span>How ClentVix works</span></div><ArrowUpRight size={14} /></button>
        {showHelp && <div className="ok-box" style={{ background: '#f8f6ff', borderColor: '#e2d8ff', color: '#5b4a8c' }}>1) Add your service in Settings. 2) Run a discovery: real businesses come from Google Places, their websites are read, and Gemini explains and ranks them. 3) Only quotes found on the page count as verified evidence.</div>}
        <div className="profile"><div className="profile-avatar">{initials(display)}</div><div><strong>{display}</strong><span>{user.email}</span></div></div>
      </div>
    </aside>
  )

  return (
    <main className="app-shell">
      {sidebar}
      {mobileNav && <div className="mobile-nav" onClick={() => setMobileNav(false)}><div onClick={(e) => e.stopPropagation()} style={{ display: 'flex' }}>{sidebar}</div></div>}
      <section className="main-content">
        <header className="topbar">
          <button className="mobile-brand" onClick={() => setMobileNav(true)} aria-label="Open menu"><Menu size={20} /><span>clentvix</span></button>
          <div className="breadcrumb"><span>Workspace</span><span>/</span><strong>{nav}</strong></div>
          <div className="top-actions">
            <div className="popover-wrap">
              <button className="icon-button" aria-label="Notifications" onClick={toggleNotifs}><Bell size={18} />{unread > 0 && <i />}</button>
              {showNotifs && (
                <div className="popover" style={{ right: 0, top: '100%', marginTop: 8, width: 300 }}>
                  <strong>Notifications</strong>
                  {notifsQ.error && <p className="error-box" style={{ marginTop: 10 }}>Could not load notifications.</p>}
                  {!notifsQ.error && (notifsQ.data?.notifications.length ?? 0) === 0 && <p style={{ color: '#8c8692', margin: '10px 0 0' }}>No notifications yet. Completed discoveries appear here.</p>}
                  {notifsQ.data?.notifications.map((n) => (
                    <div key={n.id} className={`notif-item ${n.unread ? 'unread' : ''}`}>
                      <b>{n.status === 'failed' ? 'Discovery failed' : n.status === 'running' ? 'Discovery running' : `Discovery finished: ${n.newCount} new`}</b>
                      <span>{n.businessType} in {n.location} · {ago(n.createdAt)}{n.error ? ` · ${n.error}` : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="top-divider" />
            <div className="popover-wrap">
              <button className="top-profile" onClick={() => { setShowProfile((v) => !v); setShowNotifs(false) }} aria-label="Account menu"><span className="profile-avatar small">{initials(display)}</span><ChevronDown size={14} /></button>
              {showProfile && <div className="menu"><button onClick={() => { go('Settings'); setShowProfile(false) }}>Settings</button><form action={signOutAction}><button type="submit">Sign out</button></form></div>}
            </div>
          </div>
        </header>

        <div className="content-wrap">
          {actionError && <div className="error-box" role="alert">{actionError} <button style={{ border: 0, background: 'none', textDecoration: 'underline' }} onClick={() => setActionError(null)}>Dismiss</button></div>}
          {nav === 'Overview' && <Overview prospects={prospects} loading={prospectsQ.isLoading} error={prospectsQ.error} onNew={() => setShowDiscovery(true)} onOpen={setSelectedId} onStage={(id, stage) => patch(id, { stage })} goDiscover={() => go('Discover')} />}
          {nav === 'Discover' && <Discover prospects={filtered} total={prospects.length} loading={prospectsQ.isLoading} error={prospectsQ.error} retry={() => prospectsQ.mutate()} filters={filters} setFilters={setFilters} filtersActive={filtersActive} onOpen={setSelectedId} onStage={(id, stage) => patch(id, { stage })} onNew={() => setShowDiscovery(true)} />}
          {nav === 'Pipeline' && <Pipeline prospects={prospects} loading={prospectsQ.isLoading} error={prospectsQ.error} onOpen={setSelectedId} onStage={(id, stage) => patch(id, { stage })} />}
          {nav === 'Saved prospects' && (<><div className="page-heading"><div><h1>Saved prospects</h1><p>Prospects you chose to keep.</p></div></div><ProspectTable prospects={prospects.filter((p) => p.saved)} loading={prospectsQ.isLoading} error={prospectsQ.error} empty="Nothing saved yet. Open a prospect and choose “Save prospect”." onOpen={setSelectedId} onStage={(id, stage) => patch(id, { stage })} /></>)}
          {nav === 'Settings' && <SettingsView settings={settingsQ.data?.settings} loading={settingsQ.isLoading} error={settingsQ.error} status={statusQ.data?.status} onSaved={() => settingsQ.mutate()} onImported={() => prospectsQ.mutate()} />}
        </div>
      </section>
      {showDiscovery && <DiscoveryModal defaults={settingsQ.data?.settings} status={statusQ.data?.status} hasProfile={Boolean(settingsQ.data?.settings.serviceName)} onClose={() => setShowDiscovery(false)} onDone={async () => { await Promise.all([prospectsQ.mutate(), notifsQ.mutate()]); setNav('Discover') }} />}
      {selected && <DetailPanel prospect={selected} geminiReady={statusQ.data?.status.gemini ?? false} onClose={() => setSelectedId(null)} onStage={(stage) => patch(selected.id, { stage })} onSave={() => patch(selected.id, { saved: !selected.saved })} onAnalyze={() => analyze(selected.id)} onDelete={() => remove(selected.id)} />}
    </main>
  )
}

function Metric({ label, value, note, icon: Icon }: { label: string; value: string; note: string; icon: typeof Target }) {
  return <div className="metric"><div className="metric-top"><span>{label}</span><Icon size={17} /></div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>
}

function Overview({ prospects, loading, error, onNew, onOpen, onStage, goDiscover }: { prospects: Prospect[]; loading: boolean; error: unknown; onNew: () => void; onOpen: (id: string) => void; onStage: (id: string, s: Stage) => void; goDiscover: () => void }) {
  const high = prospects.filter((p) => (p.score ?? 0) >= 75).length
  const pipeline = prospects.filter((p) => p.stage !== 'New').length
  const verified = prospects.filter((p) => p.verificationStatus === 'verified').length
  const top = prospects.filter((p) => p.score !== null).slice(0, 3)
  return (<>
    <div className="page-heading"><div><h1>Overview</h1><p>Your prospects, computed from your own data.</p></div><Button className="primary-button" onClick={onNew}><Plus data-icon="inline-start" /> New discovery</Button></div>
    <section className="metric-grid">
      <Metric label="Prospects" value={String(prospects.length)} note="in your workspace" icon={Target} />
      <Metric label="High-fit (75+)" value={String(high)} note="AI-assessed" icon={Zap} />
      <Metric label="In your pipeline" value={String(pipeline)} note="past “New”" icon={BarChart3} />
      <Metric label="Website-verified" value={prospects.length ? `${verified} of ${prospects.length}` : '—'} note="evidence quoted from the site" icon={Check} />
    </section>
    <section className="hero-panel"><div className="hero-copy"><span className="label-chip"><Sparkles size={13} /> Opportunity brief</span>
      <h2>{top.length ? <>Your best match so far<br /><em>{top[0].name}.</em></> : <>Find your next client<br /><em>with real evidence.</em></>}</h2>
      <p>{top.length ? `${prospects.length} prospects found. Highest AI-assessed fit: ${top[0].score}/100${top[0].verificationStatus === 'verified' ? ', backed by quoted website text' : ' (not verified against the website)'}.` : 'Run a discovery to search for real businesses and have their websites analysed.'}</p>
      <Button className="dark-button" onClick={top.length ? goDiscover : onNew}>{top.length ? 'Review prospects' : 'Start a discovery'} <ArrowUpRight data-icon="inline-end" /></Button></div>
      {top.length > 0 && <div className="hero-visual"><div className="radar-ring ring-one" /><div className="radar-ring ring-two" /><div className="radar-ring ring-three" /><div className="radar-core"><Target size={20} /></div>
        {top.map((p, i) => <span key={p.id} className={`signal signal-${['one', 'two', 'three'][i]}`}><span />{p.name} <b>{p.score}</b></span>)}</div>}
    </section>
    <div className="section-heading"><div><h2>Top prospects</h2><p>Ranked by AI-assessed fit; unscored prospects are listed last.</p></div><button className="text-button" onClick={goDiscover}>View all <ArrowUpRight size={14} /></button></div>
    <ProspectTable prospects={prospects.slice(0, 3)} loading={loading} error={error} empty="No prospects yet. Start a discovery or import a CSV in Settings." onOpen={onOpen} onStage={onStage} />
  </>)
}

function Discover({ prospects, total, loading, error, retry, filters, setFilters, filtersActive, onOpen, onStage, onNew }: { prospects: Prospect[]; total: number; loading: boolean; error: unknown; retry: () => void; filters: Filters; setFilters: (f: Filters) => void; filtersActive: boolean; onOpen: (id: string) => void; onStage: (id: string, s: Stage) => void; onNew: () => void }) {
  const [more, setMore] = useState(false)
  return (<>
    <div className="page-heading"><div><h1>Discover</h1><p>Businesses found through Google Places and assessed from their websites.</p></div><Button className="primary-button" onClick={onNew}><Plus data-icon="inline-start" /> New discovery</Button></div>
    {total > 0 && <div className="discovery-banner"><div className="banner-icon"><Lightbulb size={19} /></div><div><strong>{prospects.length} of {total} prospects shown</strong><p>Scores are AI assessments. “Verified” means a quote was found verbatim on the business’s website.</p></div>{filtersActive && <button onClick={() => setFilters(noFilters)}>Clear filters <X size={14} /></button>}</div>}
    <div className="toolbar">
      <div className="search-box"><Search size={17} /><input value={filters.query} onChange={(e) => setFilters({ ...filters, query: e.target.value })} placeholder="Search prospects..." aria-label="Search prospects" /></div>
      <div className="filter-select"><Filter size={15} /><select value={filters.stage} onChange={(e) => setFilters({ ...filters, stage: e.target.value as Stage | 'All' })} aria-label="Filter by stage"><option>All</option>{STAGES.map((s) => <option key={s}>{s}</option>)}</select></div>
      <div className="popover-wrap"><button className="filter-button" style={{ height: '100%' }} onClick={() => setMore((v) => !v)}><ListFilter size={15} /> More filters</button>
        {more && <div className="popover" style={{ top: '100%', marginTop: 6 }}>
          <label>Priority<select value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value as Filters['priority'] })}><option>All</option><option>High</option><option>Medium</option><option>Low</option></select></label>
          <label>Minimum fit score<input type="number" min={0} max={100} value={filters.minScore} onChange={(e) => setFilters({ ...filters, minScore: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} /></label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={filters.verifiedOnly} onChange={(e) => setFilters({ ...filters, verifiedOnly: e.target.checked })} style={{ width: 'auto', margin: 0 }} /> Website-verified only</label>
          <button className="text-button" style={{ marginTop: 12 }} onClick={() => { setFilters(noFilters); setMore(false) }}>Reset</button></div>}
      </div>
    </div>
    <ProspectTable prospects={prospects} loading={loading} error={error} retry={retry} empty={total > 0 ? 'No prospects match these filters.' : 'No prospects yet. Start a new discovery to search for real businesses.'} onOpen={onOpen} onStage={onStage} />
  </>)
}

function ProspectTable({ prospects, loading, error, retry, empty, onOpen, onStage }: { prospects: Prospect[]; loading: boolean; error: unknown; retry?: () => void; empty: string; onOpen: (id: string) => void; onStage: (id: string, s: Stage) => void }) {
  if (loading) return <div aria-busy="true"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
  if (error) return <div className="error-box" role="alert">{error instanceof Error ? error.message : 'Could not load prospects.'} {retry && <button onClick={retry} style={{ border: 0, background: 'none', textDecoration: 'underline' }}>Retry</button>}</div>
  if (prospects.length === 0) return <div className="state-box"><h3>Nothing to show</h3><p>{empty}</p></div>
  return (
    <div className="prospect-table">
      <div className="table-head"><span>Prospect</span><span>Fit score</span><span>Priority</span><span>Stage</span><span>Next action</span><span /></div>
      {prospects.map((p) => (
        <div className="table-row" key={p.id} onClick={() => onOpen(p.id)}>
          <div className="prospect-cell"><div className={`prospect-avatar ${colorFor(p.id)}`}>{initials(p.name)}</div><div><strong>{p.name}</strong><span>{p.domain || 'No website listed'}</span></div></div>
          <div className="score">{p.score === null ? <span className="badge">Not scored</span> : <><span className="score-bar"><i style={{ width: `${p.score}%` }} /></span><b>{p.score}</b></>}</div>
          <div>{p.priority ? <span className={`priority ${p.priority.toLowerCase()}`}><i />{p.priority}</span> : <span className="badge">—</span>}</div>
          <div onClick={(e) => e.stopPropagation()}><select className="stage-select" value={p.stage} onChange={(e) => onStage(p.id, e.target.value as Stage)} aria-label={`Stage for ${p.name}`}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select></div>
          <div className="next-action">{p.nextAction || '—'}</div>
          <button className="row-arrow" aria-label={`Open ${p.name}`} onClick={(e) => { e.stopPropagation(); onOpen(p.id) }}><ArrowUpRight size={16} /></button>
        </div>
      ))}
    </div>
  )
}

function Pipeline({ prospects, loading, error, onOpen, onStage }: { prospects: Prospect[]; loading: boolean; error: unknown; onOpen: (id: string) => void; onStage: (id: string, s: Stage) => void }) {
  return (<>
    <div className="page-heading"><div><h1>Pipeline</h1><p>Move the right opportunities forward.</p></div></div>
    {loading ? <div className="skeleton" /> : error ? <div className="error-box" role="alert">Could not load the pipeline.</div> : prospects.length === 0 ? <div className="state-box"><h3>Your pipeline is empty</h3><p>Run a discovery or import a CSV to add prospects.</p></div> : (
      <div className="pipeline">{STAGES.map((stage) => (
        <div className="pipeline-column" key={stage}>
          <div className="pipeline-title"><span>{stage}</span><b>{prospects.filter((p) => p.stage === stage).length}</b></div>
          {prospects.filter((p) => p.stage === stage).map((p) => (
            <div className="pipeline-card" key={p.id} role="button" tabIndex={0} onClick={() => onOpen(p.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(p.id)}>
              <div className={`prospect-avatar ${colorFor(p.id)}`}>{initials(p.name)}</div><strong>{p.name}</strong><span>{p.category}</span>
              <div className="pipeline-card-foot"><b>{p.score === null ? 'Not scored' : `${p.score} fit`}</b>
                <select value={p.stage} onClick={(e) => e.stopPropagation()} onChange={(e) => onStage(p.id, e.target.value as Stage)} aria-label={`Move ${p.name}`}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select></div>
            </div>))}
        </div>))}
      </div>)}
  </>)
}

function SettingsView({ settings, loading, error, status, onSaved, onImported }: { settings?: UserSettings; loading: boolean; error: unknown; status?: ProviderStatus; onSaved: () => void; onImported: () => void }) {
  const [form, setForm] = useState<UserSettings | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => { if (settings && !form) setForm(settings) }, [settings, form])
  async function save() {
    if (!form) return
    setSaving(true); setMsg(null)
    try { await api('/api/settings', { method: 'PUT', body: JSON.stringify(form) }); setMsg({ ok: true, text: 'Settings saved.' }); onSaved() }
    catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not save.' }) }
    setSaving(false)
  }
  if (loading || (!form && !error)) return <div className="skeleton" />
  if (error || !form) return <div className="error-box" role="alert">Could not load settings.</div>
  const set = (k: keyof UserSettings, v: string) => setForm({ ...form, [k]: v })
  const badge = (ok: boolean | undefined, yes: string, no: string) => <span className={`badge ${ok ? 'ok' : 'warn'}`}>{ok ? yes : no}</span>
  return (<>
    <div className="page-heading"><div><h1>Settings</h1><p>Your service profile guides how Gemini scores prospects.</p></div><Button className="primary-button" onClick={save} disabled={saving}>{saving ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Check data-icon="inline-start" />} Save changes</Button></div>
    {msg && <div className={msg.ok ? 'ok-box' : 'error-box'} role="status">{msg.text}</div>}
    <div className="settings-grid">
      <div className="settings-card"><div className="settings-card-head"><div className="settings-icon"><Target size={18} /></div><div><h3>Service profile</h3><p>What you help clients achieve.</p></div></div>
        <label>Service you sell<input maxLength={160} value={form.serviceName} onChange={(e) => set('serviceName', e.target.value)} placeholder="e.g. Website & booking optimisation" /></label>
        <label>Value proposition<textarea maxLength={800} value={form.valueProposition} onChange={(e) => set('valueProposition', e.target.value)} placeholder="How you help clients" /></label>
        <label>Default business type<input maxLength={120} value={form.defaultBusinessType} onChange={(e) => set('defaultBusinessType', e.target.value)} placeholder="e.g. dental clinics" /></label>
        <label>Default location<input maxLength={120} value={form.defaultLocation} onChange={(e) => set('defaultLocation', e.target.value)} placeholder="e.g. Brighton, UK" /></label></div>
      <div className="settings-card"><div className="settings-card-head"><div className="settings-icon"><Zap size={18} /></div><div><h3>Data providers</h3><p>Status reported by the server.</p></div></div>
        <div className="provider-row"><div><strong>FreeSerp web search (discovery)</strong><span>Finds candidate business websites; details need verification</span></div>{badge(status?.places, 'Configured', 'Not configured')}</div>
        <div className="provider-row"><div><strong>Gemini (analysis){status ? ` · ${status.geminiModel}` : ''}</strong><span>Explains, ranks, suggests actions</span></div>{badge(status?.gemini, 'Configured', 'Not configured')}</div>
        <div className="provider-row"><div><strong>Database</strong><span>Neon / PostgreSQL</span></div>{badge(status?.database, 'Connected', 'Missing')}</div>
        <p style={{ fontSize: 10, color: '#98929f' }}>Keys are set as server environment variables and are never shown here.</p></div>
      <ImportCard onImported={onImported} />
    </div>
  </>)
}

function ImportCard({ onImported }: { onImported: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<{ ok: boolean; text: string; errors?: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  async function run() {
    setBusy(true); setRes(null)
    try {
      const r = await api<{ imported: number; skipped: number; errors: string[]; totalRows: number }>('/api/import', { method: 'POST', headers: { 'content-type': 'text/csv' }, body: text })
      setRes({ ok: true, text: `Imported ${r.imported} of ${r.totalRows} rows${r.skipped ? `, ${r.skipped} already in your list` : ''}${r.errors.length ? `, ${r.errors.length} rejected` : ''}.`, errors: r.errors })
      setText(''); onImported()
    } catch (e) { setRes({ ok: false, text: e instanceof Error ? e.message : 'Import failed.' }) }
    setBusy(false)
  }
  return (
    <div className="settings-card" style={{ gridColumn: '1 / -1' }}><div className="settings-card-head"><div className="settings-icon"><Users size={18} /></div><div><h3>Import prospects from CSV</h3><p>Columns: name and domain (or website). Optional: category, location. Max 1 MB / 1000 rows.</p></div></div>
      <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); e.target.value = '' }} />
      <div className="import-box"><textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={'name,domain,category,location\nAcme Dental,acme-dental.com,Dentist,Leeds'} aria-label="CSV text" /></div>
      <div style={{ marginTop: 12 }}><Button className="primary-button" onClick={run} disabled={busy || !text.trim()}>{busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <Plus data-icon="inline-start" />} Import</Button></div>
      {res && <div className={res.ok ? 'ok-box' : 'error-box'} style={{ marginTop: 12 }} role="status">{res.text}{res.errors?.length ? <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>{res.errors.slice(0, 8).map((er) => <li key={er}>{er}</li>)}</ul> : null}</div>}
      <p style={{ fontSize: 10, color: '#98929f' }}>Imported prospects are unscored and unverified until you run “Analyse”.</p>
    </div>
  )
}

function DiscoveryModal({ defaults, status, hasProfile, onClose, onDone }: { defaults?: UserSettings; status?: ProviderStatus; hasProfile: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [businessType, setBusinessType] = useState(defaults?.defaultBusinessType ?? '')
  const [location, setLocation] = useState(defaults?.defaultLocation ?? '')
  const [focus, setFocus] = useState<string>(FOCUS_OPTIONS[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<DiscoveryResult | null>(null)
  async function start() {
    setBusy(true); setError(null); setResult(null)
    try {
      const r = await api<{ result: DiscoveryResult }>('/api/discovery', { method: 'POST', body: JSON.stringify({ businessType, location, focus }) })
      setResult(r.result); await onDone()
    } catch (e) { setError(e instanceof Error ? e.message : 'Discovery failed.') }
    setBusy(false)
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="New discovery"><div className="modal">
      <button className="modal-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <div className="modal-icon"><Sparkles size={20} /></div><p className="eyebrow">New discovery</p><h2>Find businesses worth approaching.</h2>
      <p className="modal-subtitle">We search the web for candidate business websites, read their pages, then Gemini explains and ranks them.</p>
      {status && !status.places && <div className="error-box">Web search is currently unavailable.</div>}
      {status && !status.gemini && <div className="error-box">GEMINI_API_KEY is not configured: prospects will be saved without analysis.</div>}
      {!hasProfile && <div className="ok-box" style={{ background: '#f8f6ff', borderColor: '#e2d8ff', color: '#5b4a8c' }}>Tip: add your service in Settings for sharper ranking.</div>}
      <label>Business type<input value={businessType} onChange={(e) => setBusinessType(e.target.value)} placeholder="e.g. dental clinics" maxLength={120} /></label>
      <label>Location (one city or area)<input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Brighton, UK" maxLength={120} /></label>
      <label>What matters most?<select value={focus} onChange={(e) => setFocus(e.target.value)}>{FOCUS_OPTIONS.map((o) => <option key={o}>{o}</option>)}</select></label>
      {error && <div className="error-box modal-error" role="alert">{error}</div>}
      {result && <div className="ok-box modal-error" role="status">Found {result.found}: {result.added} new, {result.alreadyInList} already in your list, {result.analyzed} analysed.{result.warnings.map((w) => <div key={w}>⚠ {w}</div>)}</div>}
      <div className="modal-footer"><span>{busy ? 'Searching, reading websites and analysing — this can take up to a minute…' : 'Up to 10 businesses per run'}</span>
        {result ? <Button className="primary-button" onClick={onClose}>View results</Button> : <Button className="primary-button" onClick={start} disabled={busy || businessType.trim().length < 2 || location.trim().length < 2 || status?.places === false}>{busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : null}Start discovery</Button>}</div>
    </div></div>
  )
}

function DetailPanel({ prospect: p, geminiReady, onClose, onStage, onSave, onAnalyze, onDelete }: { prospect: Prospect; geminiReady: boolean; onClose: () => void; onStage: (s: Stage) => void; onSave: () => void; onAnalyze: () => Promise<void>; onDelete: () => void }) {
  const [menu, setMenu] = useState(false)
  const [busy, setBusy] = useState(false)
  const site = safeHref(p.websiteUrl)
  const verified = p.verificationStatus === 'verified'
  return (
    <div className="detail-backdrop" onClick={onClose}><aside className="detail-panel" role="dialog" aria-label={p.name} onClick={(e) => e.stopPropagation()}>
      <div className="detail-top"><button className="icon-button" onClick={onClose} aria-label="Close details"><X size={18} /></button>
        <div className="popover-wrap"><button className="icon-button" aria-label="More actions" onClick={() => setMenu((v) => !v)}><MoreHorizontal size={18} /></button>
          {menu && <div className="menu"><button className="danger" onClick={onDelete}><Trash2 size={12} style={{ display: 'inline', marginRight: 6 }} />Delete prospect</button></div>}</div></div>
      <div className={`detail-avatar ${colorFor(p.id)}`}>{initials(p.name)}</div>
      <div className="title-row"><h2>{p.name}</h2>{p.priority && <span className={`priority ${p.priority.toLowerCase()}`}><i />{p.priority}</span>}</div>
      <p className="detail-domain"><ExternalLink size={13} /> {site ? <a href={site} target="_blank" rel="noreferrer noopener">{p.domain || p.websiteUrl}</a> : 'No website listed'}</p>
      {p.address && <p className="detail-domain" style={{ marginTop: -14 }}>{p.address}</p>}
      <div className="detail-score"><div><span>Fit score (AI assessment)</span><strong>{p.score ?? '—'}{p.score !== null && <small>/100</small>}</strong></div>{p.score !== null && <div className="large-score-bar"><i style={{ width: `${p.score}%` }} /></div>}</div>
      <div className="detail-section"><p className="eyebrow">Why this prospect</p>{p.reason ? <h3>{p.reason}</h3> : <h3>Not analysed yet.</h3>}{p.analysisStatus === 'failed' && <p style={{ color: '#a63a53' }}>Analysis failed: {p.analysisError}</p>}{p.analysisStatus === 'skipped' && <p>Analysis was skipped: {p.analysisError}</p>}</div>
      <div className="evidence-card"><div className="evidence-head"><Check size={15} /><strong>Evidence</strong><span className={`badge ${verified ? 'ok' : 'warn'}`} style={{ marginLeft: 'auto' }}>{verified ? 'Website-verified' : 'Not verified'}</span></div>
        {p.evidenceItems.length === 0 ? <p>{p.evidence || 'No evidence collected yet.'}</p> : <ul className="evidence-list">{p.evidenceItems.map((e, i) => (
          <li key={i}>{e.kind === 'website' ? <>“{e.text}”</> : e.text}<br /><span className="badge">{e.kind === 'website' ? 'From website' : 'Google Maps listing'}</span> {safeHref(e.sourceUrl) && <a href={safeHref(e.sourceUrl)} target="_blank" rel="noreferrer noopener">Source <ExternalLink size={11} /></a>} <span style={{ color: '#a09aa8', fontSize: 9 }}>· fetched {ago(e.fetchedAt)}</span></li>))}</ul>}
        {!verified && p.evidenceItems.length > 0 && p.evidence && <p>{p.evidence}</p>}
      </div>
      <div className="detail-section"><p className="eyebrow">Recommended next action</p><div className="next-callout"><Zap size={16} /><span>{p.nextAction || 'Run “Analyse” to get a suggestion.'}</span></div></div>
      <label className="detail-stage">Pipeline stage<select value={p.stage} onChange={(e) => onStage(e.target.value as Stage)}>{STAGES.map((s) => <option key={s}>{s}</option>)}</select></label>
      <Button className="primary-button full-button" onClick={onSave}><Check data-icon="inline-start" /> {p.saved ? 'Saved — click to remove' : 'Save prospect'}</Button>
      <Button variant="outline" className="full-button" style={{ marginTop: 10 }} disabled={busy || !geminiReady} onClick={async () => { setBusy(true); await onAnalyze(); setBusy(false) }}>{busy ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />} {p.analysisStatus === 'analyzed' ? 'Re-analyse website' : 'Analyse website'}</Button>
      {!geminiReady && <p style={{ fontSize: 10, color: '#98929f' }}>Gemini is not configured on the server.</p>}
    </aside></div>
  )
}
