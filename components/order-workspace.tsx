"use client";

import { ArrowRight, Check, ChevronDown, ChevronUp, PhoneCall, Plus, RotateCcw, Trophy, X } from "lucide-react";
import { useMemo, useState } from "react";
import { errorMessage, requestJson } from "@/lib/client-http";
import type { MarketCarrierState, MarketState, OfferRecord, OrderWorkspace } from "@/lib/market-types";

interface Props {
  workspace: OrderWorkspace;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
}

export function OrderWorkspaceCard({ workspace, expanded, onToggle, onChanged }: Props) {
  const { order, currentMarket } = workspace;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [offerOpen, setOfferOpen] = useState(false);
  const tone = lifecycleTone(order.lifecycleStatus);
  const statusLabel = order.lifecycleStatus === "EXCEPTION" && order.exceptionReason ? order.exceptionReason : order.lifecycleStatus;
  const activeCommitment = workspace.commitments.find((commitment) => commitment.status === "ACTIVE") || null;

  async function mutate(task: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await task(); await onChanged(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  function invalidateCommitment() {
    if (!activeCommitment) return;
    const reason = window.prompt("What happened?", "Truck breakdown");
    if (!reason?.trim()) return;
    void mutate(() => requestJson(`/api/commitments/${activeCommitment.id}/invalidate`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason }),
    }));
  }

  return (
    <article className={`order-card order-tone-${tone}`}>
      <button type="button" onClick={onToggle} className="w-full text-left">
        <div className="flex items-start gap-4 p-5 sm:p-6">
          <span className={`mt-1.5 h-3 w-3 shrink-0 rounded-full status-dot-${tone}`} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><h2 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{order.name}</h2><p className="mt-1 flex items-center gap-2 text-sm text-[var(--muted)]"><span className="truncate">{order.origin}</span><ArrowRight size={14} className="shrink-0" /><span className="truncate">{order.destination}</span></p></div>
              <span className={`status-pill status-pill-${tone}`}>{displayStatus(statusLabel)}</span>
            </div>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3"><p className="text-sm font-medium text-[var(--ink)]">{workspace.collapsedSummary}</p><span className="inline-flex items-center gap-1 font-mono text-[11px] uppercase tracking-wider text-[var(--muted)]">{expanded ? "Minimize" : "Expand"}{expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}</span></div>
          </div>
        </div>
      </button>

      {expanded && <div className="border-t border-[var(--line)] px-5 pb-6 pt-5 sm:px-9 sm:pb-8">
        {error && <div role="alert" className="mb-5 flex items-start justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"><span>{error}</span><button onClick={() => setError(null)}><X size={16} /></button></div>}
        <div className="grid gap-7 xl:grid-cols-[.72fr_1.28fr]">
          <div className="space-y-7">
            <section><SectionHeader label="Mandate" /><div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--line)]"><Metric label="Target" value={money(order.targetPrice, order.currency)} /><Metric label="Maximum" value={money(order.maximumPrice, order.currency)} /><Metric label="Priority" value={`${Math.round(order.priceWeight * 100)}% price`} sub={`${Math.round(order.speedWeight * 100)}% speed`} /><Metric label="Offers required" value={String(order.minimumValidOffers)} sub={`${order.desiredCarriers} desired carriers`} /></div>{(order.preferredArrival || order.mustArriveBy) && <div className="mt-3 rounded-xl bg-[var(--paper)] px-4 py-3 text-sm"><div className="flex justify-between gap-4"><span className="text-[var(--muted)]">Preferred arrival</span><strong>{formatDate(order.preferredArrival)}</strong></div><div className="mt-1 flex justify-between gap-4"><span className="text-[var(--muted)]">Hard deadline</span><strong>{formatDate(order.mustArriveBy)}</strong></div></div>}{order.conditions.length > 0 && <ul className="mt-3 space-y-1.5 text-sm text-[var(--muted)]">{order.conditions.map((condition) => <li key={condition} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-[var(--signal-dark)]" />{condition}</li>)}</ul>}</section>

            {activeCommitment && <section><SectionHeader label="Commitment" /><div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-emerald-950">{activeCommitment.carrierLabel}</p><p className="mt-1 font-mono text-xs uppercase tracking-wider text-emerald-800">Active commitment</p></div><Trophy size={19} className="text-emerald-700" /></div><div className="mt-4 grid gap-2 sm:grid-cols-2"><button disabled={busy} onClick={() => void mutate(() => requestJson(`/api/orders/${order.id}/complete`, { method: "POST" }))} className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-900">Mark completed</button><button disabled={busy} onClick={invalidateCommitment} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-50">Mark carrier failed</button></div></div></section>}

            {order.lifecycleStatus === "EXCEPTION" && !workspace.markets.some((state) => state.market.reason === "CARRIER_FAILURE" && ["DRAFT", "OPEN", "CALLING", "NEGOTIATING"].includes(state.market.status)) && <button disabled={busy} onClick={() => void mutate(() => requestJson(`/api/orders/${order.id}/markets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }))} className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-700 px-4 py-3 font-semibold text-white"><RotateCcw size={17} /> Create recovery market</button>}
          </div>

          <div className="space-y-7">
            {currentMarket ? <MarketPanel market={currentMarket} busy={busy} onStart={() => void mutate(() => requestJson(`/api/markets/${currentMarket.market.id}/calls`, { method: "POST" }))} onAddOffer={() => setOfferOpen(true)} onCommit={(offer) => void mutate(() => requestJson(`/api/offers/${offer.id}/commit`, { method: "POST" }))} /> : <div className="rounded-xl border border-dashed border-[var(--line)] p-8 text-center text-sm text-[var(--muted)]">No market exists for this order.</div>}

            <section><SectionHeader label="Market history" /><div className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">{workspace.markets.map((state) => <div key={state.market.id} className="flex items-center justify-between gap-4 py-3 text-sm"><div><span className="font-semibold">Market #{state.market.sequenceNumber}</span><span className="ml-2 text-[var(--muted)]">{displayStatus(state.market.reason)}</span></div><span className="font-mono text-[11px] uppercase tracking-wider text-[var(--muted)]">{displayStatus(state.market.status)}</span></div>)}</div></section>
            <section><SectionHeader label="Order history" /><div className="mt-3 space-y-3">{workspace.events.slice(0, 8).map((event) => <div key={event.id} className="flex gap-3 text-sm"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--line-strong)]" /><div><p className="font-medium">{displayStatus(event.eventType)}</p>{event.detail && <p className="text-[var(--muted)]">{event.detail}</p>}<p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">{formatDate(event.createdAt)}</p></div></div>)}</div></section>
          </div>
        </div>
      </div>}

      {offerOpen && currentMarket && <OfferModal market={currentMarket} onClose={() => setOfferOpen(false)} onSaved={async () => { setOfferOpen(false); await onChanged(); }} />}
    </article>
  );
}

function MarketPanel({ market, busy, onStart, onAddOffer, onCommit }: { market: MarketState; busy: boolean; onStart: () => void; onAddOffer: () => void; onCommit: (offer: OfferRecord) => void }) {
  const canStart = market.market.status === "DRAFT" && market.progress.callsStarted === 0;
  const canAddOffer = ["DRAFT", "OPEN", "CALLING", "NEGOTIATING"].includes(market.market.status);
  const latestOfferIds = new Set(market.carriers.map((carrier) => carrier.latestOffer?.id).filter(Boolean));
  return <section>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><SectionHeader label={`Current market / #${market.market.sequenceNumber}`} /><div className="mt-2 flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-amber-500" /><span className="font-mono text-xs uppercase tracking-wider">{displayStatus(market.market.status)}</span></div></div><div className="flex gap-2">{canAddOffer && <button disabled={busy} onClick={onAddOffer} className="secondary-button"><Plus size={15} /> Add offer</button>}{canStart && <button disabled={busy} onClick={onStart} className="primary-button"><PhoneCall size={16} /> Call {market.progress.carriersSelected} carriers</button>}</div></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-4"><MiniMetric label="Carriers" value={market.progress.carriersSelected} /><MiniMetric label="Calls active" value={market.progress.callsActive} /><MiniMetric label="Valid offers" value={market.progress.validOffers} /><MiniMetric label="Calls completed" value={market.progress.callsCompleted} /></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2"><OfferHighlight label="Best evaluated" offer={market.bestOffer} accent /><OfferHighlight label="Cheapest" offer={market.cheapestOffer} /></div>
    <div className="mt-5 overflow-x-auto"><table className="market-table"><thead><tr><th>Carrier</th><th>Latest</th><th>Arrival</th><th>Status</th><th>Rank</th><th /></tr></thead><tbody>{market.carriers.map((carrier) => <CarrierRow key={carrier.carrier.id} carrier={carrier} canCommit={Boolean(carrier.latestOffer?.isValid && latestOfferIds.has(carrier.latestOffer.id) && market.progress.validOffers >= market.market.mandate.minimumValidOffers && !market.activeCommitment)} onCommit={onCommit} />)}</tbody></table></div>
    {market.progress.validOffers < market.market.mandate.minimumValidOffers && market.progress.validOffers > 0 && <p className="mt-3 text-xs text-[var(--muted)]">{market.market.mandate.minimumValidOffers - market.progress.validOffers} more valid offer required before commitment.</p>}
  </section>;
}

function CarrierRow({ carrier, canCommit, onCommit }: { carrier: MarketCarrierState; canCommit: boolean; onCommit: (offer: OfferRecord) => void }) {
  const offer = carrier.latestOffer;
  return <tr className={carrier.rank === 1 ? "best-row" : ""}><td><div className="font-semibold">{carrier.carrier.label}</div>{carrier.latestCall && <div className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">Call {displayStatus(carrier.latestCall.status)}</div>}</td><td>{offer ? <><span className="font-semibold">{money(offer.price, offer.currency)}</span>{!offer.isValid && <span className="ml-2 text-[10px] font-semibold uppercase text-red-700">Invalid</span>}</> : "—"}</td><td>{formatDate(offer?.expectedArrival || null, true)}</td><td><span className="font-mono text-[10px] uppercase tracking-wider">{displayStatus(carrier.status)}</span></td><td>{carrier.rank ? <span className="rank-chip">{carrier.rank}</span> : "—"}</td><td className="text-right">{offer && canCommit && <button onClick={() => onCommit(offer)} className="rounded-lg bg-[var(--ink)] px-3 py-1.5 text-xs font-semibold text-white">Commit</button>}</td></tr>;
}

function OfferModal({ market, onClose, onSaved }: { market: MarketState; onClose: () => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ carrierId: market.carriers[0]?.carrier.id || "", price: "", pickupTime: "", expectedArrival: "", conditions: "", isFinalOffer: false, requiresImmediateDecision: false, callbackAllowed: true });
  const selectedCarrier = useMemo(() => market.carriers.find((carrier) => carrier.carrier.id === draft.carrierId), [draft.carrierId, market.carriers]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await requestJson(`/api/markets/${market.market.id}/offers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, price: Number(draft.price), pickupTime: draft.pickupTime ? new Date(draft.pickupTime).toISOString() : null, expectedArrival: draft.expectedArrival ? new Date(draft.expectedArrival).toISOString() : null, callId: selectedCarrier?.latestCall?.id || null }) });
      await onSaved();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(19,35,31,.62)] p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form onSubmit={save} className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><p className="eyebrow">Manual market input</p><h3 className="mt-1 text-2xl font-semibold">Record offer</h3></div><button type="button" onClick={onClose} className="icon-button"><X size={18} /></button></div>{error && <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>}<div className="mt-6 grid gap-4 sm:grid-cols-2"><Field label="Carrier"><select required className="field-input" value={draft.carrierId} onChange={(e) => setDraft({ ...draft, carrierId: e.target.value })}>{market.carriers.map((carrier) => <option key={carrier.carrier.id} value={carrier.carrier.id}>{carrier.carrier.label}</option>)}</select></Field><Field label={`Price (${market.market.mandate.currency})`}><input required type="number" min="0" step="1" className="field-input" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} /></Field><Field label="Pickup time"><input type="datetime-local" className="field-input" value={draft.pickupTime} onChange={(e) => setDraft({ ...draft, pickupTime: e.target.value })} /></Field><Field label="Expected arrival"><input type="datetime-local" className="field-input" value={draft.expectedArrival} onChange={(e) => setDraft({ ...draft, expectedArrival: e.target.value })} /></Field><Field label="Conditions" wide><textarea rows={3} className="field-input resize-none" value={draft.conditions} onChange={(e) => setDraft({ ...draft, conditions: e.target.value })} placeholder="Tolls included; two hours waiting included" /></Field></div><div className="mt-4 grid gap-2 text-sm sm:grid-cols-3"><CheckField label="Final offer" checked={draft.isFinalOffer} onChange={(value) => setDraft({ ...draft, isFinalOffer: value })} /><CheckField label="Immediate answer" checked={draft.requiresImmediateDecision} onChange={(value) => setDraft({ ...draft, requiresImmediateDecision: value })} /><CheckField label="Callback allowed" checked={draft.callbackAllowed} onChange={(value) => setDraft({ ...draft, callbackAllowed: value })} /></div><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="secondary-button">Cancel</button><button disabled={busy} className="primary-button">{busy ? "Saving…" : "Record offer"}</button></div></form></div>;
}

function OfferHighlight({ label, offer, accent }: { label: string; offer: OfferRecord | null; accent?: boolean }) { return <div className={`rounded-xl border p-4 ${accent ? "border-amber-300 bg-amber-50/70" : "border-[var(--line)] bg-[var(--paper)]"}`}><p className="eyebrow">{label}</p>{offer ? <><p className="mt-2 text-2xl font-semibold tracking-tight">{money(offer.price, offer.currency)}</p><p className="mt-1 text-sm text-[var(--muted)]">{offer.carrierLabel} · Score {offer.score}</p></> : <p className="mt-3 text-sm text-[var(--muted)]">No valid offer yet</p>}</div>; }
function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) { return <div className="bg-white p-4"><p className="eyebrow">{label}</p><p className="mt-1 font-semibold">{value}</p>{sub && <p className="mt-0.5 text-xs text-[var(--muted)]">{sub}</p>}</div>; }
function MiniMetric({ label, value }: { label: string; value: number }) { return <div className="rounded-xl bg-[var(--paper)] p-3"><p className="font-mono text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>; }
function SectionHeader({ label }: { label: string }) { return <p className="eyebrow">{label}</p>; }
function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) { return <label className={wide ? "block sm:col-span-2" : "block"}><span className="mb-1.5 block text-sm font-semibold">{label}</span>{children}</label>; }
function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--ink)]" />{label}</label>; }
function lifecycleTone(status: string): "yellow" | "green" | "red" | "gray" { if (["SOURCING", "NEGOTIATING"].includes(status)) return "yellow"; if (["COMMITTED", "IN_PROCESS"].includes(status)) return "green"; if (["EXCEPTION", "CANCELED"].includes(status)) return "red"; return "gray"; }
function displayStatus(status: string): string { return status.toLowerCase().replaceAll("_", " "); }
function money(value: number, currency: string): string { return new Intl.NumberFormat("es-MX", { style: "currency", currency, maximumFractionDigits: 0 }).format(value); }
function formatDate(value: string | null, compact = false): string { if (!value) return "—"; return new Date(value).toLocaleString([], compact ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
