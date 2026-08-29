"use client";

import { Activity, ArrowDownLeft, ArrowUpRight, Check, Clock3, Pencil, Phone, PhoneCall, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CallRecord, Contact } from "@/lib/types";

interface ContactDraft { label: string; phoneNumber: string; note: string }
const emptyDraft: ContactDraft = { label: "", phoneNumber: "", note: "" };

export function Dashboard() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activeCalls, setActiveCalls] = useState<CallRecord[]>([]);
  const [recentCalls, setRecentCalls] = useState<CallRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Contact | null>(null);
  const [formOpen, setFormOpen] = useState(false);
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

  const loadCalls = useCallback(async () => {
    try {
      const data = await requestJson<{ activeCalls: CallRecord[]; recentCalls: CallRecord[] }>("/api/calls");
      setActiveCalls(data.activeCalls);
      setRecentCalls(data.recentCalls);
      setConnected(true);
    } catch (cause) {
      setConnected(false);
      throw cause;
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void Promise.all([loadContacts(), loadCalls()]).catch((cause) => setError(errorMessage(cause)));
    }, 0);
    const poll = window.setInterval(() => void loadCalls().catch(() => undefined), 1_500);
    const timer = window.setInterval(() => setTick((value) => value + 1), 1_000);
    return () => { window.clearTimeout(initialLoad); window.clearInterval(poll); window.clearInterval(timer); };
  }, [loadCalls, loadContacts]);

  const selectedContacts = useMemo(() => contacts.filter((contact) => selected.has(contact.id)), [contacts, selected]);

  function toggleSelected(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 3) next.add(id);
      return next;
    });
  }

  function openAdd() { setEditing(null); setDraft(emptyDraft); setError(null); setFormOpen(true); }
  function openEdit(contact: Contact) {
    setEditing(contact);
    setDraft({ label: contact.label, phoneNumber: contact.phoneInput, note: contact.note || "" });
    setError(null);
    setFormOpen(true);
  }

  async function saveContact(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestJson(editing ? `/api/contacts/${editing.id}` : "/api/contacts", {
        method: editing ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      await loadContacts();
      setFormOpen(false);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function deleteContact(contact: Contact) {
    if (!window.confirm(`Delete ${contact.label} from the phonebook? Call history will remain.`)) return;
    setError(null);
    try {
      await requestJson(`/api/contacts/${contact.id}`, { method: "DELETE" });
      await loadContacts();
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function callSelected() {
    setBusy(true);
    setError(null);
    try {
      await requestJson("/api/calls/outbound", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contactIds: selectedContacts.map((contact) => contact.id) }),
      });
      setSelected(new Set());
      await loadCalls();
    } catch (cause) {
      setError(errorMessage(cause));
      await loadCalls().catch(() => undefined);
    } finally { setBusy(false); }
  }

  return (
    <main className="mx-auto min-h-screen max-w-[1440px] px-5 py-6 sm:px-8 lg:px-12">
      <header className="mb-8 flex items-end justify-between border-b border-[var(--ink)] pb-5">
        <div><div className="mb-2 font-mono text-xs uppercase tracking-[0.24em] text-[var(--muted)]">Carrier market / telephony</div><h1 className="text-4xl font-semibold tracking-[-0.06em] sm:text-5xl">MARKETLINE</h1></div>
        <div className="flex items-center gap-2 rounded-full border border-[var(--line)] bg-white px-3 py-2 text-xs font-medium"><span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-500" : "bg-[var(--danger)]"}`} />{connected ? "System ready" : "API unavailable"}</div>
      </header>

      {error && <div role="alert" className="mb-5 flex items-start justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}><X size={17} /></button></div>}

      <section className="grid gap-5 lg:grid-cols-[1.15fr_.85fr]">
        <div className="rounded-2xl border border-[var(--line)] bg-white p-5 shadow-[0_10px_40px_rgba(19,35,31,.05)]">
          <div className="mb-5 flex items-center justify-between gap-4"><div><p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--muted)]">01 / Phonebook</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Saved carriers</h2></div><button onClick={openAdd} className="flex shrink-0 items-center gap-2 rounded-full bg-[var(--ink)] px-4 py-2 text-sm font-semibold text-white"><Plus size={16} /> Add number</button></div>
          {contacts.length === 0 ? (
            <button onClick={openAdd} className="flex min-h-52 w-full flex-col items-center justify-center rounded-xl border border-dashed border-[var(--line)] bg-[var(--paper)] px-5 text-center"><Phone className="mb-3 text-[var(--muted)]" size={26} /><span className="font-semibold">Your phonebook is empty</span><span className="mt-1 max-w-sm text-sm text-[var(--muted)]">Add a carrier or test number once. It will stay here across refreshes and restarts.</span></button>
          ) : (
            <div className="divide-y divide-[var(--line)] border-y border-[var(--line)]">
              {contacts.map((contact, index) => {
                const checked = selected.has(contact.id);
                const disabled = !checked && selected.size >= 3;
                return <div key={contact.id} className="flex items-center gap-3 py-3.5">
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-4"><input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggleSelected(contact.id)} className="h-5 w-5 accent-[var(--ink)] disabled:opacity-30" /><span className="min-w-0 flex-1"><span className="block truncate font-semibold">{contact.label}</span><span className="block font-mono text-sm text-[var(--muted)]">{contact.e164PhoneNumber}</span>{contact.note && <span className="mt-0.5 block truncate text-xs text-[var(--muted)]">{contact.note}</span>}</span></label>
                  <div className="flex items-center gap-1"><button aria-label={`Edit ${contact.label}`} onClick={() => openEdit(contact)} className="rounded-lg p-2 text-[var(--muted)] hover:bg-[var(--paper)] hover:text-[var(--ink)]"><Pencil size={15} /></button><button aria-label={`Delete ${contact.label}`} onClick={() => void deleteContact(contact)} className="rounded-lg p-2 text-[var(--muted)] hover:bg-red-50 hover:text-[var(--danger)]"><Trash2 size={15} /></button><span className="ml-1 hidden font-mono text-xs text-[var(--muted)] sm:block">{String(index + 1).padStart(2, "0")}</span></div>
                </div>;
              })}
            </div>
          )}
          <div className="mt-5 flex items-center justify-between gap-4"><span className="font-mono text-xs uppercase tracking-wider text-[var(--muted)]">{selected.size} of 3 selected</span><button disabled={selected.size === 0 || busy} onClick={() => void callSelected()} className="flex items-center gap-2 rounded-xl bg-[var(--signal)] px-5 py-3 font-bold text-[var(--ink)] shadow-[inset_0_0_0_1px_rgba(19,35,31,.2)] transition hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-40">{busy ? <RefreshCw className="animate-spin" size={18} /> : <PhoneCall size={18} />}Call selected ({selected.size})</button></div>
        </div>

        <div className="rounded-2xl bg-[var(--ink)] p-5 text-white shadow-[0_10px_40px_rgba(19,35,31,.14)]">
          <div className="mb-5 flex items-center justify-between"><div><p className="font-mono text-xs uppercase tracking-[0.18em] text-white/50">02 / Activity</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Active calls</h2></div><Activity className="text-[var(--signal)]" /></div>
          {activeCalls.length === 0 ? <div className="flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[.03] px-6 text-center"><Check className="mb-3 text-white/35" size={26} /><p className="font-semibold text-white/80">No active calls</p><p className="mt-1 max-w-xs text-sm text-white/45">Calls appear here only while requested, ringing, or in progress.</p></div> : <div className="space-y-3">{activeCalls.map((call) => <ActiveCallCard key={call.id} call={call} />)}</div>}
          <div className="mt-5 border-t border-white/10 pt-4 font-mono text-xs text-white/45">Live state refreshes every 1.5 seconds</div>
        </div>
      </section>

      <section className="mt-5 rounded-2xl border border-[var(--line)] bg-white p-5 shadow-[0_10px_40px_rgba(19,35,31,.04)]">
        <div className="mb-4 flex items-center justify-between"><div><p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--muted)]">03 / History</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Recent calls</h2></div><Clock3 className="text-[var(--muted)]" /></div>
        {recentCalls.length === 0 ? <div className="rounded-xl bg-[var(--paper)] px-5 py-10 text-center text-sm text-[var(--muted)]">Completed and unsuccessful calls will appear here.</div> : <div className="overflow-x-auto"><table className="w-full min-w-[720px] border-collapse text-left text-sm"><thead><tr className="border-b border-[var(--line)] font-mono text-[11px] uppercase tracking-wider text-[var(--muted)]"><th className="pb-3 font-normal">Time</th><th className="pb-3 font-normal">Contact</th><th className="pb-3 font-normal">Direction</th><th className="pb-3 font-normal">Status</th><th className="pb-3 font-normal">Duration</th><th className="pb-3 font-normal">Detail</th></tr></thead><tbody>{recentCalls.slice(0, 30).map((call) => <RecentCallRow key={call.id} call={call} />)}</tbody></table></div>}
      </section>

      {formOpen && <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(19,35,31,.58)] p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) setFormOpen(false); }}><form onSubmit={saveContact} className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl"><div className="mb-6 flex items-start justify-between"><div><p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--muted)]">Phonebook entry</p><h2 className="mt-1 text-2xl font-semibold">{editing ? "Edit number" : "Add number"}</h2></div><button type="button" aria-label="Close" onClick={() => setFormOpen(false)} className="rounded-lg p-2 hover:bg-[var(--paper)]"><X size={18} /></button></div>{error && <div role="alert" className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900">{error}</div>}<div className="space-y-4"><Field label="Name / label"><input required autoFocus value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} placeholder="Transportes Rivera" className="field-input" /></Field><Field label="Phone number"><input required value={draft.phoneNumber} onChange={(event) => setDraft({ ...draft, phoneNumber: event.target.value })} placeholder="+525500000001" className="field-input font-mono" /><p className="mt-1.5 text-xs text-[var(--muted)]">Mexico is the default country when no prefix is entered. International numbers should include + and country code.</p></Field><Field label="Note (optional)"><textarea rows={3} value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="Dispatcher, test line, operating hours…" className="field-input resize-none" /></Field></div><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setFormOpen(false)} className="rounded-xl border border-[var(--line)] px-4 py-2.5 font-semibold">Cancel</button><button disabled={busy} className="rounded-xl bg-[var(--ink)] px-5 py-2.5 font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : editing ? "Save changes" : "Add to phonebook"}</button></div></form></div>}
    </main>
  );
}

function ActiveCallCard({ call }: { call: CallRecord }) {
  const label = call.contactLabel || (call.direction === "INBOUND" ? call.fromNumber : call.toNumber);
  const phone = call.direction === "INBOUND" ? call.fromNumber : call.toNumber;
  return <div className="flex items-center gap-4 rounded-xl border border-white/10 bg-white/[.06] p-4"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${call.status === "RINGING" ? "bg-[var(--warning)]" : "bg-[var(--signal)]"}`} /><span className="min-w-0 flex-1"><span className="block truncate font-semibold">{label}</span><span className="font-mono text-xs text-white/50">{phone}</span></span><span className="text-right"><span className="block rounded-full bg-white/10 px-3 py-1 font-mono text-[11px] uppercase tracking-wider">{displayStatus(call.status)}</span><span className="mt-1 block font-mono text-[11px] text-white/45">{formatDuration(elapsedSeconds(call.answeredAt || call.startedAt))}</span></span></div>;
}

function RecentCallRow({ call }: { call: CallRecord }) {
  const label = call.contactLabel || (call.direction === "INBOUND" ? call.fromNumber : call.toNumber);
  return <tr className="border-b border-[var(--line)] last:border-0"><td className="py-3.5 font-mono text-xs text-[var(--muted)]">{new Date(call.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</td><td className="py-3.5 font-semibold">{label}</td><td className="py-3.5"><span className="inline-flex items-center gap-1.5 text-[var(--muted)]">{call.direction === "INBOUND" ? <ArrowDownLeft size={14} /> : <ArrowUpRight size={14} />}{call.direction === "INBOUND" ? "Inbound" : "Outbound"}</span></td><td className="py-3.5"><StatusBadge status={call.status} /></td><td className="py-3.5 font-mono text-xs">{call.durationSeconds === null ? "—" : formatDuration(call.durationSeconds)}</td><td className="max-w-xs truncate py-3.5 text-xs text-[var(--danger)]" title={call.errorMessage || undefined}>{call.errorMessage || "—"}</td></tr>;
}

function StatusBadge({ status }: { status: CallRecord["status"] }) { const negative = ["FAILED", "BUSY", "NO_ANSWER", "CANCELED"].includes(status); return <span className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${negative ? "bg-red-50 text-red-800" : "bg-emerald-50 text-emerald-800"}`}>{displayStatus(status)}</span>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="mb-1.5 block text-sm font-semibold">{label}</span>{children}</label>; }

async function requestJson<T = unknown>(url: string, init?: RequestInit): Promise<T> { const response = await fetch(url, { ...init, cache: "no-store" }); if (response.status === 204) return undefined as T; const data = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(data.error || `Request failed with status ${response.status}.`); return data; }
function elapsedSeconds(start: string): number { return Math.max(0, Math.floor((Date.now() - Date.parse(start)) / 1_000)); }
function formatDuration(total: number): string { const minutes = Math.floor(total / 60); const seconds = total % 60; return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`; }
function displayStatus(status: string): string { return status.toLowerCase().replaceAll("_", " "); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
