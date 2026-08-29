"use client";

import { Activity, ArrowDownLeft, ArrowUpRight, Check, Clock3, Pencil, Phone, PhoneCall, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NewOrderModal } from "@/components/new-order-modal";
import { OrderWorkspaceCard } from "@/components/order-workspace";
import { errorMessage, requestJson } from "@/lib/client-http";
import type { OrderWorkspace } from "@/lib/market-types";
import type { CallRecord, Contact } from "@/lib/types";

type OrderFilter = "ALL" | "ACTIVE" | "SOURCING" | "COMMITTED" | "EXCEPTIONS" | "PAST";
interface ContactDraft { label: string; phoneNumber: string; note: string }
const emptyDraft: ContactDraft = { label: "", phoneNumber: "", note: "" };

export function Dashboard() {
  const [orders, setOrders] = useState<OrderWorkspace[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activeCalls, setActiveCalls] = useState<CallRecord[]>([]);
  const [recentCalls, setRecentCalls] = useState<CallRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<OrderFilter>("ALL");
  const [editing, setEditing] = useState<Contact | null>(null);
  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [draft, setDraft] = useState<ContactDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [, setTick] = useState(0);

  const loadContacts = useCallback(async () => {
    const data = await requestJson<{ contacts: Contact[] }>("/api/contacts");
    setContacts(data.contacts);
    setSelected((current) => new Set([...current].filter((id) => data.contacts.some((contact) => contact.id === id))));
  }, []);

  const loadOperationalState = useCallback(async () => {
    try {
      const [orderData, callData] = await Promise.all([
        requestJson<{ orders: OrderWorkspace[] }>("/api/orders"),
        requestJson<{ activeCalls: CallRecord[]; recentCalls: CallRecord[] }>("/api/calls"),
      ]);
      setOrders(orderData.orders);
      setActiveCalls(callData.activeCalls);
      setRecentCalls(callData.recentCalls);
      setConnected(true);
    } catch (cause) { setConnected(false); throw cause; }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void Promise.all([loadContacts(), loadOperationalState()]).catch((cause) => setError(errorMessage(cause))), 0);
    const poll = window.setInterval(() => void loadOperationalState().catch(() => undefined), 1_500);
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => { window.clearTimeout(initialLoad); window.clearInterval(poll); window.clearInterval(timer); };
  }, [loadContacts, loadOperationalState]);

  const selectedContacts = useMemo(() => contacts.filter((contact) => selected.has(contact.id)), [contacts, selected]);
  const filteredOrders = useMemo(() => orders.filter((workspace) => matchesFilter(workspace, filter)), [filter, orders]);
  const counts = useMemo(() => ({
    action: orders.filter((item) => ["EXCEPTION", "CANCELED"].includes(item.order.lifecycleStatus)).length,
    sourcing: orders.filter((item) => ["SOURCING", "NEGOTIATING"].includes(item.order.lifecycleStatus)).length,
    committed: orders.filter((item) => ["COMMITTED", "IN_PROCESS"].includes(item.order.lifecycleStatus)).length,
    past: orders.filter((item) => ["COMPLETED", "ARCHIVED"].includes(item.order.lifecycleStatus)).length,
  }), [orders]);

  function toggleSelected(id: string) { setSelected((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else if (next.size < 3) next.add(id); return next; }); }
  function toggleExpanded(id: string) { setExpanded((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function openAdd() { setEditing(null); setDraft(emptyDraft); setError(null); setContactFormOpen(true); }
  function openEdit(contact: Contact) { setEditing(contact); setDraft({ label: contact.label, phoneNumber: contact.phoneInput, note: contact.note || "" }); setError(null); setContactFormOpen(true); }

  async function saveContact(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await requestJson(editing ? `/api/contacts/${editing.id}` : "/api/contacts", { method: editing ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(draft) });
      await loadContacts(); setContactFormOpen(false);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  async function deleteContact(contact: Contact) {
    if (!window.confirm(`Delete ${contact.label} from the phonebook? Call and order history will remain.`)) return;
    try { await requestJson(`/api/contacts/${contact.id}`, { method: "DELETE" }); await loadContacts(); }
    catch (cause) { setError(errorMessage(cause)); }
  }
  async function callSelected() {
    setBusy(true); setError(null);
    try {
      await requestJson("/api/calls/outbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ contactIds: selectedContacts.map((contact) => contact.id) }) });
      setSelected(new Set()); await loadOperationalState();
    } catch (cause) { setError(errorMessage(cause)); await loadOperationalState().catch(() => undefined); }
    finally { setBusy(false); }
  }

  return (
    <main className="mx-auto min-h-screen max-w-[1480px] px-4 py-5 sm:px-7 lg:px-10">
      <header className="mb-7 flex flex-wrap items-end justify-between gap-5 border-b border-[var(--ink)] pb-5">
        <div><p className="eyebrow mb-2">Order + market state</p><h1 className="text-4xl font-semibold tracking-[-0.06em] sm:text-5xl">MARKETLINE</h1><p className="mt-2 max-w-xl text-sm text-[var(--muted)]">Ground transport procurement, calls, offers, and commitments in one authoritative operating state.</p></div>
        <div className="flex items-center gap-3"><div className="flex items-center gap-2 rounded-full border border-[var(--line)] bg-white px-3 py-2 text-xs font-medium"><span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-[var(--danger)]"}`} />{connected ? "Live state connected" : "API unavailable"}</div><button onClick={() => setOrderFormOpen(true)} className="primary-button"><Plus size={17} /> New order</button></div>
      </header>

      {error && <div role="alert" className="mb-5 flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={17} /></button></div>}
      <section className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4"><LifecycleCount label="Action required" value={counts.action} tone="red" /><LifecycleCount label="Sourcing" value={counts.sourcing} tone="yellow" /><LifecycleCount label="Committed" value={counts.committed} tone="green" /><LifecycleCount label="Past" value={counts.past} tone="gray" /></section>

      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4"><div><p className="eyebrow">Operational workspaces</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Orders</h2></div><div className="flex flex-wrap gap-1 rounded-xl border border-[var(--line)] bg-white p-1">{(["ALL", "ACTIVE", "SOURCING", "COMMITTED", "EXCEPTIONS", "PAST"] as OrderFilter[]).map((item) => <button key={item} onClick={() => setFilter(item)} className={`rounded-lg px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider ${filter === item ? "bg-[var(--ink)] text-white" : "text-[var(--muted)] hover:bg-[var(--paper)]"}`}>{item}</button>)}</div></div>
        {filteredOrders.length > 0 ? <div className="space-y-3">{filteredOrders.map((workspace) => <OrderWorkspaceCard key={workspace.order.id} workspace={workspace} expanded={expanded.has(workspace.order.id)} onToggle={() => toggleExpanded(workspace.order.id)} onChanged={loadOperationalState} />)}</div> : <button onClick={() => setOrderFormOpen(true)} className="flex min-h-56 w-full flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--line-strong)] bg-white/70 px-6 text-center"><span className="mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ink)] text-white"><Plus size={20} /></span><span className="text-lg font-semibold">{orders.length === 0 ? "Create the first order" : "No orders in this view"}</span><span className="mt-1 max-w-md text-sm text-[var(--muted)]">Define a mandate, select carriers, and open a sourcing market without losing the phonebook or call history.</span></button>}
      </section>

      <section className="mt-8 border-t border-[var(--ink)] pt-7"><div className="mb-4"><p className="eyebrow">Carrier operations</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Directory and live calls</h2></div><div className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <div className="surface-panel">
          <div className="mb-5 flex items-center justify-between gap-4"><div><p className="eyebrow">Saved carriers</p><p className="mt-1 text-sm text-[var(--muted)]">Reusable across every order. Quick calls remain available for telephony testing.</p></div><button onClick={openAdd} className="secondary-button"><Plus size={16} /> Add number</button></div>
          {contacts.length === 0 ? <button onClick={openAdd} className="flex min-h-40 w-full flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper)]"><Phone className="mb-2 text-[var(--muted)]" size={23} /><span className="font-semibold">Phonebook empty</span></button> : <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">{contacts.map((contact, index) => { const checked = selected.has(contact.id); return <div key={contact.id} className="flex items-center gap-3 py-3"><label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"><input type="checkbox" checked={checked} disabled={!checked && selected.size >= 3} onChange={() => toggleSelected(contact.id)} className="h-5 w-5 accent-[var(--ink)]" /><span className="min-w-0 flex-1"><span className="block truncate font-semibold">{contact.label}</span><span className="font-mono text-xs text-[var(--muted)]">{contact.e164PhoneNumber}</span></span></label><button aria-label={`Edit ${contact.label}`} onClick={() => openEdit(contact)} className="icon-button"><Pencil size={15} /></button><button aria-label={`Delete ${contact.label}`} onClick={() => void deleteContact(contact)} className="icon-button hover:text-red-700"><Trash2 size={15} /></button><span className="hidden font-mono text-[10px] text-[var(--muted)] sm:block">{String(index + 1).padStart(2, "0")}</span></div>; })}</div>}
          <div className="mt-4 flex items-center justify-between gap-4"><span className="eyebrow">{selected.size} of 3 selected</span><button disabled={selected.size === 0 || busy} onClick={() => void callSelected()} className="signal-button">{busy ? <RefreshCw className="animate-spin" size={17} /> : <PhoneCall size={17} />} Quick call ({selected.size})</button></div>
        </div>
        <div className="rounded-2xl bg-[var(--ink)] p-5 text-white shadow-[0_10px_40px_rgba(19,35,31,.14)]"><div className="mb-5 flex items-center justify-between"><div><p className="eyebrow text-white/50">Call activity</p><h3 className="mt-1 text-2xl font-semibold">Active calls</h3></div><Activity className="text-[var(--signal)]" /></div>{activeCalls.length === 0 ? <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[.03] px-6 text-center"><Check className="mb-3 text-white/35" size={26} /><p className="font-semibold text-white/80">No active calls</p><p className="mt-1 max-w-xs text-sm text-white/45">Only requested, ringing, and in-progress calls appear here.</p></div> : <div className="space-y-3">{activeCalls.map((call) => <ActiveCallCard key={call.id} call={call} />)}</div>}<div className="mt-5 border-t border-white/10 pt-4 font-mono text-xs text-white/45">Refreshes every 1.5 seconds</div></div>
      </div></section>

      <section className="surface-panel mt-5"><div className="mb-4 flex items-center justify-between"><div><p className="eyebrow">Audit trail</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Recent calls</h2></div><Clock3 className="text-[var(--muted)]" /></div>{recentCalls.length === 0 ? <div className="rounded-xl bg-[var(--paper)] px-5 py-10 text-center text-sm text-[var(--muted)]">Completed and unsuccessful calls will appear here.</div> : <div className="overflow-x-auto"><table className="w-full min-w-[720px] border-collapse text-left text-sm"><thead><tr className="border-b border-[var(--line)] font-mono text-[11px] uppercase tracking-wider text-[var(--muted)]"><th className="pb-3 font-normal">Time</th><th className="pb-3 font-normal">Contact</th><th className="pb-3 font-normal">Context</th><th className="pb-3 font-normal">Status</th><th className="pb-3 font-normal">Duration</th><th className="pb-3 font-normal">Detail</th></tr></thead><tbody>{recentCalls.slice(0, 30).map((call) => <RecentCallRow key={call.id} call={call} />)}</tbody></table></div>}</section>

      {orderFormOpen && <NewOrderModal contacts={contacts} onClose={() => setOrderFormOpen(false)} onCreated={(order) => { setOrderFormOpen(false); setExpanded((current) => new Set(current).add(order.order.id)); void loadOperationalState(); }} onAddCarrier={openAdd} />}
      {contactFormOpen && <ContactModal editing={editing} draft={draft} setDraft={setDraft} busy={busy} error={error} onClose={() => setContactFormOpen(false)} onSubmit={saveContact} />}
    </main>
  );
}

function ContactModal({ editing, draft, setDraft, busy, error, onClose, onSubmit }: { editing: Contact | null; draft: ContactDraft; setDraft: (draft: ContactDraft) => void; busy: boolean; error: string | null; onClose: () => void; onSubmit: (event: React.FormEvent) => Promise<void> }) { return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-[rgba(19,35,31,.58)] p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form onSubmit={(event) => void onSubmit(event)} className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"><div className="mb-6 flex items-start justify-between"><div><p className="eyebrow">Carrier directory</p><h2 className="mt-1 text-2xl font-semibold">{editing ? "Edit carrier" : "Add carrier"}</h2></div><button type="button" aria-label="Close" onClick={onClose} className="icon-button"><X size={18} /></button></div>{error && <div role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900">{error}</div>}<div className="space-y-4"><Field label="Name / label"><input required autoFocus value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Transportes Rivera" className="field-input" /></Field><Field label="Phone number"><input required value={draft.phoneNumber} onChange={(e) => setDraft({ ...draft, phoneNumber: e.target.value })} placeholder="+525500000001" className="field-input font-mono" /></Field><Field label="Note (optional)"><textarea rows={3} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} className="field-input resize-none" /></Field></div><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="secondary-button">Cancel</button><button disabled={busy} className="primary-button">{busy ? "Saving…" : editing ? "Save changes" : "Add carrier"}</button></div></form></div>; }
function ActiveCallCard({ call }: { call: CallRecord }) { const label = call.contactLabel || (call.direction === "INBOUND" ? call.fromNumber : call.toNumber); const phone = call.direction === "INBOUND" ? call.fromNumber : call.toNumber; return <div className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[.06] p-4"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${call.status === "RINGING" ? "bg-[var(--warning)]" : "bg-[var(--signal)]"}`} /><span className="min-w-0 flex-1"><span className="block truncate font-semibold">{label}</span><span className="font-mono text-xs text-white/50">{phone}</span></span><span className="text-right"><span className="block rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider">{displayStatus(call.status)}</span><span className="mt-1 block font-mono text-[11px] text-white/45">{formatDuration(elapsedSeconds(call.answeredAt || call.startedAt))}</span></span></div>; }
function RecentCallRow({ call }: { call: CallRecord }) { const label = call.contactLabel || (call.direction === "INBOUND" ? call.fromNumber : call.toNumber); return <tr className="border-b border-[var(--line)] last:border-0"><td className="py-3.5 font-mono text-xs text-[var(--muted)]">{new Date(call.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td className="py-3.5 font-semibold">{label}</td><td className="py-3.5"><span className="inline-flex items-center gap-1.5 text-[var(--muted)]">{call.direction === "INBOUND" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}{call.marketId ? "Market call" : call.direction === "INBOUND" ? "Inbound" : "Quick call"}</span></td><td className="py-3.5"><StatusBadge status={call.status} /></td><td className="py-3.5 font-mono text-xs">{call.durationSeconds === null ? "—" : formatDuration(call.durationSeconds)}</td><td className="max-w-xs truncate py-3.5 text-xs text-[var(--danger)]" title={call.errorMessage || undefined}>{call.errorMessage || "—"}</td></tr>; }
function StatusBadge({ status }: { status: CallRecord["status"] }) { const negative = ["FAILED", "BUSY", "NO_ANSWER", "CANCELED"].includes(status); return <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${negative ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>{displayStatus(status)}</span>; }
function LifecycleCount({ label, value, tone }: { label: string; value: number; tone: string }) { return <div className="rounded-xl border border-[var(--line)] bg-white px-4 py-3"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full status-dot-${tone}`} /><span className="font-mono text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</span></div><p className="mt-1 text-2xl font-semibold">{value}</p></div>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1.5 block text-sm font-semibold">{label}</span>{children}</label>; }
function matchesFilter(workspace: OrderWorkspace, filter: OrderFilter): boolean { const status = workspace.order.lifecycleStatus; if (filter === "ALL") return true; if (filter === "ACTIVE") return !["COMPLETED", "ARCHIVED", "CANCELED"].includes(status); if (filter === "SOURCING") return ["SOURCING", "NEGOTIATING"].includes(status); if (filter === "COMMITTED") return ["COMMITTED", "IN_PROCESS"].includes(status); if (filter === "EXCEPTIONS") return ["EXCEPTION", "CANCELED"].includes(status); return ["COMPLETED", "ARCHIVED"].includes(status); }
function elapsedSeconds(start: string): number { return Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 1_000)); }
function formatDuration(total: number): string { const minutes = Math.floor(total / 60); const seconds = total % 60; return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`; }
function displayStatus(status: string): string { return status.toLowerCase().replaceAll("_", " "); }
