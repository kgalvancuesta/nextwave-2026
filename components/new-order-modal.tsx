"use client";

import { AlertTriangle, Plus, Trash2, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { errorMessage, requestJson } from "@/lib/client-http";
import type { OrderWorkspace } from "@/lib/market-types";
import { deadlineWhenEnabled, synchronizeDeadline, validateNewOrder, type NewOrderDraft, type NewOrderField } from "@/lib/order-form";
import type { Contact } from "@/lib/types";

interface Props {
  contacts: Contact[];
  onClose: () => void;
  onCreated: (order: OrderWorkspace) => void;
  onAddCarrier: () => void;
}

export function NewOrderModal({ contacts, onClose, onCreated, onAddCarrier }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);
  const [deadlineEnabled, setDeadlineEnabled] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [conditions, setConditions] = useState<string[]>([""]);
  const [priority, setPriority] = useState(65);
  const [alternateExchangeRate, setAlternateExchangeRate] = useState("17.0427");
  const [draft, setDraft] = useState<NewOrderDraft>({
    name: "", client: "", origin: "", destination: "", reference: "", currency: "MXN",
    targetPrice: "", maximumPrice: "", preferredPickup: "", mustPickupBy: "", preferredArrival: "", mustArriveBy: "",
    minimumValidOffers: "2", desiredCarriers: "3", freeTimeEndsAt: "", currentEta: "", dailyDemurrageRate: "",
  });
  const formRef = useRef<HTMLFormElement>(null);
  const selectedContacts = useMemo(() => contacts.filter((contact) => selected.has(contact.id)), [contacts, selected]);
  const validationErrors = useMemo(() => validateNewOrder(draft, deadlineEnabled, selected.size), [deadlineEnabled, draft, selected.size]);
  const visibleErrors = showValidation ? validationErrors : {};
  const alternateCurrency = draft.currency === "MXN" ? "USD" : "MXN";

  function update(name: keyof NewOrderDraft, value: string) {
    setError(null);
    setDraft((current) => name === "preferredArrival"
      ? { ...current, preferredArrival: value, mustArriveBy: synchronizeDeadline(value, current.mustArriveBy, deadlineEnabled) }
      : { ...current, [name]: value });
  }
  function toggleDeadline(enabled: boolean) {
    setDeadlineEnabled(enabled);
    setError(null);
    if (enabled) setDraft((current) => ({ ...current, mustArriveBy: deadlineWhenEnabled(current.preferredArrival, current.mustArriveBy, localDateTimeNow()) }));
  }
  function toggleCarrier(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else if (next.size < 3) next.add(id);
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setShowValidation(true);
    const firstInvalid = Object.keys(validationErrors)[0] as NewOrderField | undefined;
    if (firstInvalid) {
      window.requestAnimationFrame(() => {
        const field = formRef.current?.querySelector<HTMLElement>(`[data-field="${firstInvalid}"]`);
        field?.scrollIntoView({ behavior: "smooth", block: "center" });
        field?.focus({ preventScroll: true });
      });
      return;
    }
    const exchangeRate = Number(alternateExchangeRate);
    if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
      setError(`Enter a positive conversion rate from ${alternateCurrency} to ${draft.currency}.`);
      window.requestAnimationFrame(() => formRef.current?.querySelector<HTMLElement>('[data-field="exchangeRate"]')?.focus());
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await requestJson<{ order: OrderWorkspace }>("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...draft,
          exchangeRates: {
            [draft.currency]: 1,
            [alternateCurrency]: exchangeRate,
          },
          exchangeRateSource: "Operator-configured order rate",
          targetPrice: Number(draft.targetPrice),
          maximumPrice: Number(draft.maximumPrice),
          preferredPickup: draft.preferredPickup ? new Date(draft.preferredPickup).toISOString() : null,
          mustPickupBy: draft.mustPickupBy ? new Date(draft.mustPickupBy).toISOString() : null,
          preferredArrival: draft.preferredArrival ? new Date(draft.preferredArrival).toISOString() : null,
          mustArriveBy: deadlineEnabled && draft.mustArriveBy ? new Date(draft.mustArriveBy).toISOString() : null,
          priceWeight: priority / 100,
          speedWeight: (100 - priority) / 100,
          minimumValidOffers: Number(draft.minimumValidOffers),
          desiredCarriers: Number(draft.desiredCarriers),
          freeTimeEndsAt: draft.freeTimeEndsAt ? new Date(draft.freeTimeEndsAt).toISOString() : null,
          currentEta: draft.currentEta ? new Date(draft.currentEta).toISOString() : null,
          dailyDemurrageRate: draft.dailyDemurrageRate ? Number(draft.dailyDemurrageRate) : undefined,
          conditions: conditions.map((condition) => condition.trim()).filter(Boolean),
          carrierIds: selectedContacts.map((contact) => contact.id),
        }),
      });
      onCreated(result.order);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[rgba(19,35,31,.62)] p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form ref={formRef} noValidate onSubmit={submit} className="mx-auto my-4 w-full max-w-4xl rounded-2xl bg-white shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between rounded-t-2xl border-b border-[var(--line)] bg-white px-6 py-5">
          <div><p className="eyebrow">New procurement workspace</p><h2 className="mt-1 text-2xl font-semibold tracking-tight">Create order</h2><p className="mt-1 text-sm text-[var(--muted)]">Define the mandate once. Every market keeps its own snapshot.</p></div>
          <button type="button" aria-label="Close" onClick={onClose} className="icon-button"><X size={18} /></button>
        </div>
        <div className="space-y-8 p-6">
          {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>}

          <section>
            <SectionTitle number="01" title="Order details" description="The shipment identity operators will scan first." />
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Order name" error={visibleErrors.name} wide><input data-field="name" aria-invalid={Boolean(visibleErrors.name)} autoFocus className="field-input" value={draft.name} onChange={(e) => update("name", e.target.value)} placeholder="Textiles Pacífico — Manzanillo → Guadalajara" /></Field>
              <Field label="Client" error={visibleErrors.client}><input data-field="client" aria-invalid={Boolean(visibleErrors.client)} className="field-input" value={draft.client} onChange={(e) => update("client", e.target.value)} placeholder="Textiles Pacífico" /></Field>
              <Field label="Order / reference number"><input className="field-input" value={draft.reference} onChange={(e) => update("reference", e.target.value)} placeholder="TCLU1234567 (generated if blank)" /></Field>
              <Field label="Origin" error={visibleErrors.origin}><input data-field="origin" aria-invalid={Boolean(visibleErrors.origin)} className="field-input" value={draft.origin} onChange={(e) => update("origin", e.target.value)} placeholder="Port of Manzanillo" /></Field>
              <Field label="Destination" error={visibleErrors.destination}><input data-field="destination" aria-invalid={Boolean(visibleErrors.destination)} className="field-input" value={draft.destination} onChange={(e) => update("destination", e.target.value)} placeholder="Guadalajara warehouse" /></Field>
            </div>
          </section>

          <section className="border-t border-[var(--line)] pt-7">
            <SectionTitle number="02" title="Mandate" description="Target the agent should pursue and the hard authorization boundary." />
            <div className="mt-4 grid gap-4 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4 sm:grid-cols-2">
              <Field label="Standard comparison currency"><select className="field-input" value={draft.currency} onChange={(e) => { const currency = e.target.value; update("currency", currency); setAlternateExchangeRate(currency === "MXN" ? "17.0427" : "0.058676"); }}><option value="MXN">MXN — Mexican peso</option><option value="USD">USD — US dollar</option></select></Field>
              <Field label={`Exchange rate: 1 ${alternateCurrency} equals`}><div className="relative"><input data-field="exchangeRate" required type="number" min="0.000001" step="0.000001" className="field-input pr-16" value={alternateExchangeRate} onChange={(e) => { setAlternateExchangeRate(e.target.value); setError(null); }} /><span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-xs text-[var(--muted)]">{draft.currency}</span></div><span className="mt-1 block text-xs text-[var(--muted)]">Snapshotted on the order and used for every backend comparison.</span></Field>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Target price" error={visibleErrors.targetPrice}><div className="relative"><span className="currency-prefix">$</span><input data-field="targetPrice" aria-invalid={Boolean(visibleErrors.targetPrice)} type="number" min="0" step="1" className="field-input currency-input" value={draft.targetPrice} onChange={(e) => update("targetPrice", e.target.value)} placeholder="8000" /></div></Field>
              <Field label="Maximum price" error={visibleErrors.maximumPrice}><div className="relative"><span className="currency-prefix">$</span><input data-field="maximumPrice" aria-invalid={Boolean(visibleErrors.maximumPrice)} type="number" min="0" step="1" className="field-input currency-input" value={draft.maximumPrice} onChange={(e) => update("maximumPrice", e.target.value)} placeholder="9000" /></div></Field>
              <Field label="Preferred arrival"><input data-field="preferredArrival" type="datetime-local" className="field-input" value={draft.preferredArrival} onChange={(e) => update("preferredArrival", e.target.value)} /></Field>
              <div><span className="mb-1.5 block text-sm font-semibold">Latest arrival</span><label className="mb-2 flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={deadlineEnabled} onChange={(e) => toggleDeadline(e.target.checked)} className="h-4 w-4 accent-[var(--ink)]" /> Required deadline</label><input aria-label="Latest arrival deadline" data-field="mustArriveBy" aria-invalid={Boolean(visibleErrors.mustArriveBy)} disabled={!deadlineEnabled} type="datetime-local" min={draft.preferredArrival || undefined} className="field-input disabled:cursor-not-allowed disabled:opacity-50" value={draft.mustArriveBy} onChange={(e) => update("mustArriveBy", e.target.value)} />{visibleErrors.mustArriveBy && <span className="mt-1.5 block text-sm font-medium text-red-700">{visibleErrors.mustArriveBy}</span>}</div>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Preferred pickup"><input data-field="preferredPickup" type="datetime-local" className="field-input" value={draft.preferredPickup} onChange={(e) => update("preferredPickup", e.target.value)} /></Field>
              <Field label="Latest pickup (hard limit)" error={visibleErrors.mustPickupBy}><input data-field="mustPickupBy" aria-invalid={Boolean(visibleErrors.mustPickupBy)} type="datetime-local" min={draft.preferredPickup || undefined} className="field-input" value={draft.mustPickupBy} onChange={(e) => update("mustPickupBy", e.target.value)} /></Field>
            </div>
            <div className="mt-5 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4">
              <div className="flex items-center justify-between gap-4"><span className={priority > 50 ? "text-lg font-bold" : "text-sm font-medium text-[var(--muted)]"}>Save money</span><span className="font-mono text-xs text-[var(--muted)]">{priority}% price / {100 - priority}% speed</span><span className={priority < 50 ? "text-lg font-bold" : "text-sm font-medium text-[var(--muted)]"}>Arrive sooner</span></div>
              <input aria-label="Price versus speed priority" type="range" min="0" max="100" value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="mt-3 w-full accent-[var(--ink)]" />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Minimum valid offers" error={visibleErrors.minimumValidOffers}><input data-field="minimumValidOffers" aria-invalid={Boolean(visibleErrors.minimumValidOffers)} type="number" min="1" max="10" className="field-input" value={draft.minimumValidOffers} onChange={(e) => update("minimumValidOffers", e.target.value)} /></Field>
              <Field label="Desired carriers" error={visibleErrors.desiredCarriers}><input data-field="desiredCarriers" aria-invalid={Boolean(visibleErrors.desiredCarriers)} type="number" min="1" max="3" className="field-input" value={draft.desiredCarriers} onChange={(e) => update("desiredCarriers", e.target.value)} /></Field>
            </div>
          </section>

          <section className="border-t border-[var(--line)] pt-7">
            <SectionTitle number="03" title="Demurrage watch" description="Optional, but required for Nauta to quantify and resolve a free-time risk." />
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Field label="Free time ends" error={visibleErrors.freeTimeEndsAt}><input data-field="freeTimeEndsAt" aria-invalid={Boolean(visibleErrors.freeTimeEndsAt)} type="datetime-local" className="field-input" value={draft.freeTimeEndsAt} onChange={(e) => update("freeTimeEndsAt", e.target.value)} /></Field>
              <Field label="Current ETA"><input type="datetime-local" className="field-input" value={draft.currentEta} onChange={(e) => update("currentEta", e.target.value)} /></Field>
              <Field label="Daily demurrage rate" error={visibleErrors.dailyDemurrageRate}><div className="relative"><span className="currency-prefix">$</span><input data-field="dailyDemurrageRate" aria-invalid={Boolean(visibleErrors.dailyDemurrageRate)} type="number" min="0" step="1" className="field-input currency-input" value={draft.dailyDemurrageRate} onChange={(e) => update("dailyDemurrageRate", e.target.value)} placeholder="18000" /></div></Field>
            </div>
          </section>

          <section className="border-t border-[var(--line)] pt-7">
            <SectionTitle number="04" title="Conditions" description="Plain-language boundaries preserved in every market snapshot." />
            <div className="mt-4 space-y-2">
              {conditions.map((condition, index) => <div key={index} className="flex gap-2"><input className="field-input" value={condition} onChange={(e) => setConditions((current) => current.map((item, itemIndex) => itemIndex === index ? e.target.value : item))} placeholder="Price must include tolls" /><button type="button" aria-label="Remove condition" className="icon-button" onClick={() => setConditions((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={16} /></button></div>)}
              <button type="button" onClick={() => setConditions((current) => [...current, ""])} className="secondary-button"><Plus size={15} /> Add condition</button>
            </div>
          </section>

          <section className="border-t border-[var(--line)] pt-7">
            <div className="flex items-start justify-between gap-4"><SectionTitle number="05" title="Carrier selection" description="Leave empty for Luna to rank and select carriers automatically, or choose up to three overrides." /><button type="button" onClick={onAddCarrier} className="secondary-button"><Plus size={15} /> New carrier</button></div>
            <div data-field="carrierIds" tabIndex={-1} className="mt-4 grid gap-2 sm:grid-cols-2">
              {contacts.map((contact) => { const checked = selected.has(contact.id); return <label key={contact.id} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 ${checked ? "border-[var(--ink)] bg-[var(--paper)]" : "border-[var(--line)]"}`}><input type="checkbox" checked={checked} disabled={!checked && selected.size >= 3} onChange={() => toggleCarrier(contact.id)} className="h-5 w-5 accent-[var(--ink)]" /><span className="min-w-0"><span className="block truncate font-semibold">{contact.label}</span><span className="font-mono text-xs text-[var(--muted)]">{contact.e164PhoneNumber}</span></span></label>; })}
              {contacts.length === 0 && <button type="button" onClick={onAddCarrier} className="col-span-full rounded-xl border border-dashed border-[var(--line)] p-8 text-sm text-[var(--muted)]">Add a carrier before creating this order.</button>}
            </div>
            <p className="mt-3 font-mono text-xs uppercase tracking-wider text-[var(--muted)]">{selected.size === 0 ? `Automatic · Luna selects ${draft.desiredCarriers}` : `${selected.size} manual override${selected.size === 1 ? "" : "s"}`}</p>
          </section>
        </div>
        <div className="sticky bottom-0 rounded-b-2xl border-t border-[var(--line)] bg-white px-6 py-4">
          {(Object.keys(visibleErrors).length > 0 || error) && <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"><div className="flex items-start gap-2"><AlertTriangle size={17} className="mt-0.5 shrink-0" /><div><p className="font-semibold">{error || `Please fix ${Object.keys(visibleErrors).length} field${Object.keys(visibleErrors).length === 1 ? "" : "s"} before creating the order.`}</p>{!error && <ul className="mt-1 list-disc pl-5">{Object.entries(visibleErrors).map(([field, message]) => <li key={field}>{message}</li>)}</ul>}</div></div></div>}
          <div className="flex items-center justify-between gap-4"><p className="hidden text-sm text-[var(--muted)] sm:block">Creates Order + Market #1. Calls begin only when you start the market.</p><div className="ml-auto flex gap-3"><button type="button" onClick={onClose} className="secondary-button">Cancel</button><button disabled={busy} className="primary-button">{busy ? "Creating…" : "Create order"}</button></div></div>
        </div>
      </form>
    </div>
  );
}

function SectionTitle({ number, title, description }: { number: string; title: string; description: string }) { return <div><p className="eyebrow">{number}</p><h3 className="mt-1 text-lg font-semibold">{title}</h3><p className="mt-1 text-sm text-[var(--muted)]">{description}</p></div>; }
function Field({ label, error, wide, children }: { label: string; error?: string; wide?: boolean; children: React.ReactNode }) { return <label className={wide ? "block sm:col-span-2" : "block"}><span className="mb-1.5 block text-sm font-semibold">{label}</span>{children}{error && <span className="mt-1.5 block text-sm font-medium text-red-700">{error}</span>}</label>; }
function localDateTimeNow(): string { const now = new Date(); now.setSeconds(0, 0); return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); }
