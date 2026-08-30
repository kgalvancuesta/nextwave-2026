"use client";

import { AlertTriangle, ArrowRight, Check, ChevronDown, ChevronUp, FileText, PhoneCall, Plus, RotateCcw, Trophy, Volume2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { errorMessage, requestJson } from "@/lib/client-http";
import { publicOrderReference, type AmendmentRecord, type CommitmentRecord, type MarketCarrierState, type MarketState, type OfferRecord, type OrderEventRecord, type OrderWorkspace } from "@/lib/market-types";

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
  const priority = priorityDisplay(order.priceWeight, order.speedWeight);
  const statusLabel = order.lifecycleStatus === "EXCEPTION" && order.exceptionReason ? order.exceptionReason : order.lifecycleStatus;
  const activeCommitment = workspace.commitments.find((commitment) => commitment.status === "ACTIVE") || null;
  const latestAmendment = workspace.amendments[0] ?? null;
  const importantEvents = workspace.events.filter((event) => IMPORTANT_EVENT_TYPES.has(event.eventType)).slice(0, 8);
  const technicalEvents = workspace.events.filter((event) => !IMPORTANT_EVENT_TYPES.has(event.eventType));

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
              <div className="min-w-0"><p className="mb-1 font-mono text-[11px] uppercase tracking-wider text-[var(--muted)]">Order / reference # {publicOrderReference(order)}</p><h2 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">{order.name}</h2><p className="mt-1 flex items-center gap-2 text-sm text-[var(--muted)]"><span className="truncate">{order.origin}</span><ArrowRight size={14} className="shrink-0" /><span className="truncate">{order.destination}</span></p></div>
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
            <DemurrageRiskPanel order={order} calls={workspace.nautaCalls} busy={busy} onResolve={() => void mutate(() => requestJson(`/api/orders/${order.id}/resolve-risk`, { method: "POST" }))} />
            <section><SectionHeader label="Mandate" /><div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--line)]"><Metric label="Target" value={money(order.targetPrice, order.currency)} /><Metric label="Maximum" value={money(order.maximumPrice, order.currency)} /><Metric label="Priority" value={priority.value} sub={priority.sub} /><Metric label="Offers required" value={String(order.minimumValidOffers)} sub={`${order.desiredCarriers} desired carriers`} /></div>{(order.preferredPickup || order.mustPickupBy || order.preferredArrival || order.mustArriveBy) && <div className="mt-3 rounded-xl bg-[var(--paper)] px-4 py-3 text-sm"><div className="flex justify-between gap-4"><span className="text-[var(--muted)]">Preferred pickup</span><strong>{formatDate(order.preferredPickup)}</strong></div><div className="mt-1 flex justify-between gap-4"><span className="text-[var(--muted)]">Latest pickup</span><strong>{formatDate(order.mustPickupBy)}</strong></div><div className="mt-1 flex justify-between gap-4"><span className="text-[var(--muted)]">Preferred arrival</span><strong>{formatDate(order.preferredArrival)}</strong></div><div className="mt-1 flex justify-between gap-4"><span className="text-[var(--muted)]">Latest arrival</span><strong>{formatDate(order.mustArriveBy)}</strong></div></div>}{order.conditions.length > 0 && <ul className="mt-3 space-y-1.5 text-sm text-[var(--muted)]">{order.conditions.map((condition) => <li key={condition} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-[var(--signal-dark)]" />{condition}</li>)}</ul>}</section>

            {latestAmendment && <AmendmentPanel
              amendment={latestAmendment}
              recovered={Boolean(latestAmendment.recoveryMarketId && activeCommitment?.marketId === latestAmendment.recoveryMarketId)}
              revalidating={workspace.markets.some((state) => state.market.id === latestAmendment.recoveryMarketId && state.market.reason === "AMENDMENT_REVALIDATION" && !["COMMITTED", "CANCELED"].includes(state.market.status))}
            />}

            {activeCommitment && <section><SectionHeader label="Commitment" /><div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-semibold text-emerald-950">{activeCommitment.carrierLabel}</p><p className="mt-1 font-mono text-xs uppercase tracking-wider text-emerald-800">Active commitment</p></div><Trophy size={19} className="text-emerald-700" /></div><RecapPanel commitment={activeCommitment} /><div className="mt-4 grid gap-2 sm:grid-cols-2"><button disabled={busy} onClick={() => void mutate(() => requestJson(`/api/orders/${order.id}/complete`, { method: "POST" }))} className="rounded-lg bg-emerald-800 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-900">Mark completed</button><button disabled={busy} onClick={invalidateCommitment} className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-800 hover:bg-red-50">Mark carrier failed</button></div></div></section>}

            {order.lifecycleStatus === "EXCEPTION" && !workspace.markets.some((state) => state.market.reason === "CARRIER_FAILURE" && ["DRAFT", "OPEN", "CALLING", "NEGOTIATING"].includes(state.market.status)) && <button disabled={busy} onClick={() => void mutate(() => requestJson(`/api/orders/${order.id}/markets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }))} className="flex w-full items-center justify-center gap-2 rounded-xl bg-red-700 px-4 py-3 font-semibold text-white"><RotateCcw size={17} /> Create recovery market</button>}
          </div>

          <div className="space-y-7">
            {currentMarket ? <MarketPanel market={currentMarket} busy={busy} onStart={() => void mutate(() => requestJson(`/api/markets/${currentMarket.market.id}/calls`, { method: "POST" }))} onAddOffer={() => setOfferOpen(true)} onCommit={(offer) => void mutate(() => requestJson(`/api/offers/${offer.id}/commit`, { method: "POST" }))} /> : <div className="rounded-xl border border-dashed border-[var(--line)] p-8 text-center text-sm text-[var(--muted)]">No market exists for this order.</div>}

            <MarketHistory markets={workspace.markets} currentMarketId={currentMarket?.market.id ?? null} />
            <section><SectionHeader label="Order history" /><div className="mt-3 space-y-3">{importantEvents.map((event) => <EventItem key={event.id} event={event} />)}{importantEvents.length === 0 && <p className="text-sm text-[var(--muted)]">No major activity yet.</p>}</div>{technicalEvents.length > 0 && <details className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--paper)]"><summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Technical activity ({technicalEvents.length})</summary><div className="space-y-3 border-t border-[var(--line)] px-4 py-3">{technicalEvents.slice(0, 20).map((event) => <EventItem key={event.id} event={event} technical />)}</div></details>}</section>
          </div>
        </div>
      </div>}

      {offerOpen && currentMarket && <OfferModal market={currentMarket} onClose={() => setOfferOpen(false)} onSaved={async () => { setOfferOpen(false); await onChanged(); }} />}
    </article>
  );
}

function AmendmentPanel({ amendment, recovered, revalidating }: { amendment: AmendmentRecord; recovered: boolean; revalidating: boolean }) {
  const atRisk = amendment.status === "RECOVERY_REQUIRED" && !recovered;
  const accepted = amendment.status === "ACCEPTED";
  const tone = recovered || accepted ? "border-emerald-200 bg-emerald-50/70 text-emerald-950"
    : "border-red-200 bg-red-50/70 text-red-950";
  const title = recovered ? "Recovered" : accepted ? "Amendment accepted" : revalidating ? "Revalidating retained offers" : atRisk ? "Commitment at risk" : "Human review required";
  return <section><SectionHeader label="Self-healing order" /><div className={`mt-3 rounded-xl border p-4 ${tone}`}><div className="flex items-start gap-3"><AlertTriangle size={18} className="mt-0.5 shrink-0" /><div><p className="font-semibold">{title}</p><p className="mt-0.5 text-sm opacity-80">{amendment.carrierLabel} · {amendment.decisionReason}</p></div></div><div className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><Terms label="Original" terms={amendment.originalTerms} /><Terms label={accepted ? "Accepted" : "Requested"} terms={accepted ? amendment.finalTerms ?? amendment.requestedTerms : amendment.requestedTerms} /></div>{amendment.violations.length > 0 && <div className="mt-3 border-t border-current/15 pt-3"><p className="font-semibold">Hard-constraint violations</p><ul className="mt-1 list-disc pl-5 text-sm">{amendment.violations.map((violation) => <li key={`${violation.code}-${violation.message}`}>{violation.message}</li>)}</ul></div>}{revalidating && <p className="mt-3 font-mono text-[10px] uppercase tracking-wider">Original commitment stays active · only better prior offers are being reconfirmed</p>}{atRisk && !revalidating && <p className="mt-3 font-mono text-[10px] uppercase tracking-wider">Recovery market open · prior bidders prioritized</p>}{recovered && <p className="mt-3 font-mono text-[10px] uppercase tracking-wider">Original carrier replaced · commitment preserved</p>}</div></section>;
}

function MarketHistory({ markets, currentMarketId }: { markets: MarketState[]; currentMarketId: string | null }) {
  return <section><SectionHeader label="Market history" /><div className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">{markets.map((state) => {
    const isCurrent = state.market.id === currentMarketId;
    return <details key={state.market.id} open={!isCurrent && state.market.sequenceNumber === 1} className="group py-1"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-3 text-sm"><div><span className="font-semibold">Market #{state.market.sequenceNumber}</span><span className="ml-2 text-[var(--muted)]">{marketReasonLabel(state.market.reason)}</span>{isCurrent && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[9px] uppercase text-amber-900">Current</span>}</div><span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-[var(--muted)]">{displayStatus(state.market.status)}<ChevronDown size={14} className="transition-transform group-open:rotate-180" /></span></summary><HistoricalMarketDetails market={state} /></details>;
  })}</div></section>;
}

function HistoricalMarketDetails({ market }: { market: MarketState }) {
  return <div className="mb-4 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-4"><div className="grid gap-3 sm:grid-cols-3"><MiniMetric label="Carriers" value={market.progress.carriersSelected} /><MiniMetric label="Offers" value={market.offers.length} /><MiniMetric label="Calls completed" value={market.progress.callsCompleted} /></div><div className="mt-4 overflow-x-auto"><table className="market-table"><thead><tr><th>Carrier</th><th>Latest</th><th>Arrival</th><th>Status</th><th>Rank</th><th /></tr></thead><tbody>{market.carriers.map((carrier) => <CarrierRow key={carrier.carrier.id} carrier={carrier} canCommit={false} onCommit={() => undefined} />)}</tbody></table></div></div>;
}

function Terms({ label, terms }: { label: string; terms: AmendmentRecord["originalTerms"] }) {
  return <div className="rounded-lg bg-white/65 p-3"><p className="eyebrow">{label}</p><p className="mt-2 font-semibold">{money(terms.price, terms.currency)}</p><p className="mt-1 text-xs opacity-75">Pickup {formatDate(terms.pickupTime, true)}</p><p className="mt-0.5 text-xs opacity-75">Arrival {formatDate(terms.expectedArrival, true)}</p></div>;
}

function DemurrageRiskPanel({ order, calls, busy, onResolve }: { order: OrderWorkspace["order"]; calls: OrderWorkspace["nautaCalls"]; busy: boolean; onResolve: () => void }) {
  if (!order.freeTimeEndsAt || order.dailyDemurrageRate <= 0) return null;
  const hoursRemaining = Math.round((Date.parse(order.freeTimeEndsAt) - Date.parse(order.updatedAt)) / 3_600_000);
  const etaOverrunDays = order.currentEta && Date.parse(order.currentEta) > Date.parse(order.freeTimeEndsAt)
    ? Math.max(1, Math.ceil((Date.parse(order.currentEta) - Date.parse(order.freeTimeEndsAt)) / 86_400_000))
    : 1;
  const exposure = etaOverrunDays * order.dailyDemurrageRate;
  const inProgress = order.riskStatus === "IN_PROGRESS";
  return <section className={`rounded-2xl border p-5 ${inProgress ? "border-amber-300 bg-amber-50" : "border-red-300 bg-red-50"}`}>
    <div className="flex items-start gap-3"><span className={`mt-0.5 rounded-full p-2 ${inProgress ? "bg-amber-200 text-amber-900" : "bg-red-200 text-red-900"}`}><AlertTriangle size={18} /></span><div className="min-w-0 flex-1"><p className="eyebrow">Nauta risk watch</p><h3 className="mt-1 text-lg font-semibold">{inProgress ? "Recovery in progress" : "Demurrage exposure"}</h3><p className="mt-1 text-sm text-[var(--muted)]">Free time ends {formatDate(order.freeTimeEndsAt)} · {hoursRemaining >= 0 ? `${hoursRemaining} hours remaining` : `${Math.abs(hoursRemaining)} hours overdue`}</p></div></div>
    <div className="mt-4 grid grid-cols-2 gap-2"><Metric label="Potential exposure" value={money(exposure, order.currency)} sub={`${money(order.dailyDemurrageRate, order.currency)} / day`} /><Metric label="Current ETA" value={order.currentEta ? formatDate(order.currentEta, true) : "Unconfirmed"} /></div>
    {inProgress ? <><p className="mt-4 text-sm font-medium text-amber-950">Nauta is verifying ETA, securing an appointment, and preparing an extension or fee-waiver fallback. The action is recorded in the order audit trail.</p>{calls.length > 0 && <div className="mt-4 space-y-2">{calls.map((call) => <div key={call.id} className="flex items-center justify-between rounded-lg border border-amber-200 bg-white/70 px-3 py-2 text-sm"><span className="font-semibold">{call.contactLabel || call.toNumber}</span><span className="font-mono text-[10px] uppercase tracking-wider">{displayStatus(call.status)}</span></div>)}</div>}</> : <button disabled={busy} onClick={onResolve} className="signal-button mt-4 w-full"><PhoneCall size={17} /> Nauta: call 3 carriers now</button>}
  </section>;
}

/**
 * A verbal agreement the carrier cannot re-read is not evidence. This shows
 * whether the written record actually reached them, and what it said.
 */
function RecapPanel({ commitment }: { commitment: CommitmentRecord }) {
  const [open, setOpen] = useState(false);
  if (commitment.recapStatus === "NOT_REQUIRED") return null;
  const tone = commitment.recapStatus === "SENT" ? "text-emerald-800"
    : commitment.recapStatus === "FAILED" ? "text-red-800" : "text-amber-800";
  const label = commitment.recapStatus === "SENT" ? `Written recap sent to ${commitment.recapAddress}`
    : commitment.recapStatus === "FAILED" ? "Written recap failed"
      : "Written recap queued";
  return <div className="mt-3 border-t border-emerald-200 pt-3">
    <div className="flex items-start gap-2">
      <FileText size={14} className={`mt-0.5 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-xs font-semibold ${tone}`}>{label}</p>
        {commitment.recapSentAt && <p className="font-mono text-[10px] text-emerald-800">{formatDate(commitment.recapSentAt, true)} · {commitment.recapDeliveryId}</p>}
        {commitment.recapError && <p className="mt-0.5 text-[11px] text-red-800">{commitment.recapError}</p>}
        {commitment.recapBody && <button type="button" onClick={() => setOpen(!open)} className="mt-1 font-mono text-[10px] uppercase tracking-wider text-emerald-800 hover:underline">{open ? "Hide" : "Show"} what was sent</button>}
      </div>
    </div>
    {open && commitment.recapBody && <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-white/80 p-2 text-[11px] leading-relaxed text-emerald-950">{commitment.recapBody}</pre>}
  </div>;
}

function MarketPanel({ market, busy, onStart, onAddOffer, onCommit }: { market: MarketState; busy: boolean; onStart: () => void; onAddOffer: () => void; onCommit: (offer: OfferRecord) => void }) {
  const canStart = market.market.status === "DRAFT" && market.progress.callsStarted === 0;
  const canAddOffer = ["DRAFT", "OPEN", "CALLING", "NEGOTIATING", "HUMAN_REVIEW"].includes(market.market.status);
  const latestOfferIds = new Set(market.carriers.map((carrier) => carrier.latestOffer?.id).filter(Boolean));
  return <section>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><SectionHeader label={`Current market / #${market.market.sequenceNumber}`} /><div className="mt-2 flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-amber-500" /><span className="font-mono text-xs uppercase tracking-wider">{displayStatus(market.market.status)} · {displayStatus(market.phase)} · rev {market.market.revision}</span></div></div><div className="flex gap-2">{canAddOffer && <button disabled={busy} onClick={onAddOffer} className="secondary-button"><Plus size={15} /> Add offer</button>}{canStart && <button disabled={busy} onClick={onStart} className="primary-button"><PhoneCall size={16} /> Call {market.progress.carriersSelected} carriers</button>}</div></div>
    {market.reviewReason && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900"><strong>Human review required.</strong> {market.reviewReason}</div>}
    <div className="mt-4 grid gap-3 sm:grid-cols-4"><MiniMetric label="Carriers" value={market.progress.carriersSelected} /><MiniMetric label="Calls active" value={market.progress.callsActive} /><MiniMetric label="Valid offers" value={market.progress.validOffers} /><MiniMetric label="Calls completed" value={market.progress.callsCompleted} /></div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2"><OfferHighlight label="Best evaluated" offer={market.bestOffer} accent /><OfferHighlight label="Cheapest" offer={market.cheapestOffer} /></div>
    <div className="mt-5 overflow-x-auto"><table className="market-table"><thead><tr><th>Carrier</th><th>Latest</th><th>Arrival</th><th>Status</th><th>Rank</th><th /></tr></thead><tbody>{market.carriers.map((carrier) => <CarrierRow key={carrier.carrier.id} carrier={carrier} canCommit={Boolean(carrier.latestOffer?.isComparable && carrier.latestOffer.isValid && latestOfferIds.has(carrier.latestOffer.id) && market.progress.validOffers >= market.market.mandate.minimumValidOffers && !market.activeCommitment)} onCommit={onCommit} />)}</tbody></table></div>
    {market.nearFeasibleOffers.length > 0 && <div className="mt-4 rounded-xl border border-red-200 bg-red-50/60 p-4"><p className="eyebrow text-red-800">Feasibility frontier / human decision support</p><div className="mt-2 space-y-2">{market.nearFeasibleOffers.map((offer) => <div key={offer.id} className="text-sm"><strong>{offer.carrierLabel}</strong> · {money(offer.price, offer.currency)} · {formatDate(offer.expectedArrival, true)}<span className="block text-xs text-red-800">{offer.feasibilityViolations.map((violation) => frontierDistance(violation, offer.normalizedCurrency)).join("; ")}</span></div>)}</div><p className="mt-3 text-xs text-red-800">These values are decision support only. Luna cannot accept them outside the mandate.</p></div>}
    {market.progress.validOffers < market.market.mandate.minimumValidOffers && market.progress.validOffers > 0 && <p className="mt-3 text-xs text-[var(--muted)]">{market.market.mandate.minimumValidOffers - market.progress.validOffers} more valid offer required before commitment.</p>}
  </section>;
}

function CarrierRow({ carrier, canCommit, onCommit }: { carrier: MarketCarrierState; canCommit: boolean; onCommit: (offer: OfferRecord) => void }) {
  const offer = carrier.latestOffer ?? carrier.retainedOffer;
  const awaitingReconfirmation = !carrier.latestOffer && Boolean(carrier.retainedOffer);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const classification = offerClassificationLabel(offer);
  return <><tr className={carrier.rank === 1 ? "best-row" : ""}><td><div className="font-semibold">{carrier.carrier.label}</div>{carrier.latestCall && <><div className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">Call {displayStatus(carrier.latestCall.status)}</div>{carrier.latestCall.errorMessage && <div className="mt-1 max-w-xs text-xs text-red-700">{carrier.latestCall.errorMessage}</div>}</>}</td><td>{offer ? <><span className="font-semibold">{money(offer.price, offer.currency)}</span>{awaitingReconfirmation && <span className="ml-2 text-[10px] font-semibold uppercase text-blue-700">Prior · confirm</span>}{classification && !awaitingReconfirmation && <span className={`ml-2 text-[10px] font-semibold uppercase ${offer.classification === "INFEASIBLE" ? "text-red-700" : "text-amber-700"}`}>{classification}</span>}{offer.normalizedPrice !== null && offer.currency !== offer.normalizedCurrency && <span className="mt-0.5 block text-[10px] text-[var(--muted)]">{money(offer.normalizedPrice, offer.normalizedCurrency)} standardized</span>}{offer.missingFields.length > 0 && <span className="mt-0.5 block text-[10px] text-[var(--muted)]">Needs {offer.missingFields.map(missingFieldLabel).join(", ")}</span>}{offer.evidence && <EvidenceButton offer={offer} />}</> : "—"}</td><td>{formatDate(offer?.expectedArrival || null, true)}</td><td><span className="font-mono text-[10px] uppercase tracking-wider">{awaitingReconfirmation ? "awaiting confirmation" : displayStatus(carrier.status)}</span><span className="mt-0.5 block text-[10px] text-[var(--muted)]">{displayStatus(carrier.instruction.action)}</span></td><td>{carrier.rank ? <span className="rank-chip">{carrier.rank}</span> : "—"}</td><td className="text-right"><div className="flex justify-end gap-2">{offer && <button onClick={() => setDetailsOpen((open) => !open)} className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs font-semibold">{detailsOpen ? "Hide" : "Details"}</button>}{offer && canCommit && <button onClick={() => onCommit(offer)} className="rounded-lg bg-[var(--ink)] px-3 py-1.5 text-xs font-semibold text-white">Commit</button>}</div></td></tr>{offer && detailsOpen && <tr><td colSpan={6} className="bg-[var(--paper)]"><OfferDetails offer={offer} /></td></tr>}</>;
}

function OfferDetails({ offer }: { offer: OfferRecord }) {
  return <div className="grid gap-4 p-4 text-sm sm:grid-cols-2"><div><p className="eyebrow">Commercial terms</p><dl className="mt-2 space-y-1.5"><Detail label="Quoted" value={money(offer.price, offer.currency)} /><Detail label="Standardized" value={offer.normalizedPrice === null ? "Exchange rate missing" : money(offer.normalizedPrice, offer.normalizedCurrency)} /><Detail label="Exchange rate" value={offer.exchangeRate === null || !offer.currency ? "—" : `1 ${offer.currency} = ${offer.exchangeRate} ${offer.normalizedCurrency}`} /><Detail label="Arrival" value={formatDate(offer.expectedArrival)} /><Detail label="All-in" value={offer.rateAllIn === true ? "Confirmed" : offer.rateAllIn === false ? "No" : "Not confirmed"} /></dl></div><div><p className="eyebrow">Decision</p>{offer.feasibilityViolations.length > 0 ? <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-900"><p className="font-semibold">Rejected because</p><ul className="mt-1 list-disc pl-5">{offer.feasibilityViolations.map((violation) => <li key={`${violation.code}-${violation.message}`}>{violation.message}</li>)}</ul></div> : offer.missingFields.length > 0 ? <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950"><p className="font-semibold">Incomplete offer</p><p className="mt-1">Still needed: {offer.missingFields.map(missingFieldLabel).join(", ")}.</p></div> : <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-emerald-950">Meets the configured hard constraints.</div>}{offer.rawStatement && <div className="mt-3"><p className="font-semibold">Carrier statement</p><p className="mt-1 text-[var(--muted)]">“{offer.rawStatement}”</p></div>}</div>{offer.exchangeRateSource && <p className="text-xs text-[var(--muted)] sm:col-span-2">Rate source: {offer.exchangeRateSource}</p>}</div>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-4"><dt className="text-[var(--muted)]">{label}</dt><dd className="text-right font-medium">{value}</dd></div>; }

function EvidenceButton({ offer }: { offer: OfferRecord }) {
  const [open, setOpen] = useState(false);
  const evidence = offer.evidence!;
  const seconds = evidence.offsetMs !== null ? Math.max(0, Math.floor(evidence.offsetMs / 1000)) : null;
  if (!evidence.audioUrl && !evidence.rawStatement) return null;
  return <div className="mt-1">
    <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-[var(--ink)]">
      <Volume2 size={12} /> Evidence{seconds !== null ? ` · ${formatOffset(seconds)}` : ""}
    </button>
    {open && <div className="mt-1.5 max-w-xs rounded-lg border border-[var(--line)] bg-[var(--paper)] p-2">
      {evidence.rawStatement && <p className="text-xs italic text-[var(--ink)]">&ldquo;{evidence.rawStatement}&rdquo;</p>}
      {evidence.audioUrl
        ? <audio controls preload="none" className="mt-1.5 w-full" src={`${evidence.audioUrl}${seconds ? `#t=${seconds}` : ""}`} />
        : <p className="mt-1 text-[10px] text-[var(--muted)]">Audio not available. Set RECORD_CALLS=true before the call to capture it.</p>}
      <p className="mt-1 font-mono text-[10px] text-[var(--muted)]">Captured {formatDate(evidence.capturedAt, true)}</p>
    </div>}
  </div>;
}

function formatOffset(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function EventItem({ event, technical = false }: { event: OrderEventRecord; technical?: boolean }) {
  const summary = eventSummary(event);
  return <div className="flex gap-3 text-sm"><span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--line-strong)]" /><div className="min-w-0"><p className="font-medium">{eventTitle(event.eventType)}</p>{summary && <p className="text-[var(--muted)]">{summary}</p>}<p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">{formatDate(event.createdAt)}</p>{technical && event.detail && event.detail.trim().startsWith("{") && <details className="mt-1"><summary className="cursor-pointer text-xs text-[var(--muted)]">Raw data</summary><pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap text-[10px] text-[var(--muted)]">{event.detail}</pre></details>}</div></div>;
}

function OfferModal({ market, onClose, onSaved }: { market: MarketState; onClose: () => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({ carrierId: market.carriers[0]?.carrier.id || "", price: "", currency: market.market.mandate.currency, pickupTime: "", expectedArrival: "", conditions: "", requirementsConfirmed: market.market.mandate.conditions.length === 0, isFinalOffer: false, requiresImmediateDecision: false, callbackAllowed: true });
  const selectedCarrier = useMemo(() => market.carriers.find((carrier) => carrier.carrier.id === draft.carrierId), [draft.carrierId, market.carriers]);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      if (!draft.requirementsConfirmed) throw new Error("Confirm the carrier accepted every mandate condition.");
      await requestJson(`/api/markets/${market.market.id}/offers`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...draft, confirmedRequirements: market.market.mandate.conditions, price: Number(draft.price), pickupTime: draft.pickupTime ? new Date(draft.pickupTime).toISOString() : null, expectedArrival: new Date(draft.expectedArrival).toISOString(), callId: selectedCarrier?.latestCall?.id || null }) });
      await onSaved();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(19,35,31,.62)] p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form onSubmit={save} className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><p className="eyebrow">Manual market input</p><h3 className="mt-1 text-2xl font-semibold">Record offer</h3></div><button type="button" onClick={onClose} className="icon-button"><X size={18} /></button></div>{error && <div className="mt-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>}<div className="mt-6 grid gap-4 sm:grid-cols-2"><Field label="Carrier"><select required className="field-input" value={draft.carrierId} onChange={(e) => setDraft({ ...draft, carrierId: e.target.value })}>{market.carriers.map((carrier) => <option key={carrier.carrier.id} value={carrier.carrier.id}>{carrier.carrier.label}</option>)}</select></Field><Field label="Quoted price"><div className="grid grid-cols-[1fr_7rem] gap-2"><input required type="number" min="0" step="1" className="field-input" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} /><select aria-label="Quoted currency" className="field-input" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}>{Object.keys(market.market.mandate.exchangeRates).map((currency) => <option key={currency}>{currency}</option>)}</select></div></Field><Field label="Pickup time"><input type="datetime-local" className="field-input" value={draft.pickupTime} onChange={(e) => setDraft({ ...draft, pickupTime: e.target.value })} /></Field><Field label="Expected arrival"><input required type="datetime-local" className="field-input" value={draft.expectedArrival} onChange={(e) => setDraft({ ...draft, expectedArrival: e.target.value })} /></Field><Field label="Carrier conditions" wide><textarea rows={3} className="field-input resize-none" value={draft.conditions} onChange={(e) => setDraft({ ...draft, conditions: e.target.value })} placeholder="Two hours waiting included" /></Field></div><div className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><CheckField label="All mandate conditions confirmed" checked={draft.requirementsConfirmed} onChange={(value) => setDraft({ ...draft, requirementsConfirmed: value })} /><CheckField label="Final offer" checked={draft.isFinalOffer} onChange={(value) => setDraft({ ...draft, isFinalOffer: value })} /><CheckField label="Immediate answer" checked={draft.requiresImmediateDecision} onChange={(value) => setDraft({ ...draft, requiresImmediateDecision: value })} /><CheckField label="Callback allowed" checked={draft.callbackAllowed} onChange={(value) => setDraft({ ...draft, callbackAllowed: value })} /></div><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="secondary-button">Cancel</button><button disabled={busy} className="primary-button">{busy ? "Saving…" : "Record offer"}</button></div></form></div>;
}

function OfferHighlight({ label, offer, accent }: { label: string; offer: OfferRecord | null; accent?: boolean }) { return <div className={`rounded-xl border p-4 ${accent ? "border-amber-300 bg-amber-50/70" : "border-[var(--line)] bg-[var(--paper)]"}`}><p className="eyebrow">{label}</p>{offer ? <><p className="mt-2 text-2xl font-semibold tracking-tight">{money(offer.price, offer.currency)}</p><p className="mt-1 text-sm text-[var(--muted)]">{offer.carrierLabel} · Score {offer.score}</p></> : <p className="mt-3 text-sm text-[var(--muted)]">No valid offer yet</p>}</div>; }
function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) { return <div className="bg-white p-4"><p className="eyebrow">{label}</p><p className="mt-1 font-semibold">{value}</p>{sub && <p className="mt-0.5 text-xs text-[var(--muted)]">{sub}</p>}</div>; }
function MiniMetric({ label, value }: { label: string; value: number }) { return <div className="rounded-xl bg-[var(--paper)] p-3"><p className="font-mono text-[10px] uppercase tracking-wider text-[var(--muted)]">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>; }
function SectionHeader({ label }: { label: string }) { return <p className="eyebrow">{label}</p>; }
function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) { return <label className={wide ? "block sm:col-span-2" : "block"}><span className="mb-1.5 block text-sm font-semibold">{label}</span>{children}</label>; }
function CheckField({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) { return <label className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-2"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--ink)]" />{label}</label>; }
const IMPORTANT_EVENT_TYPES = new Set([
  "ORDER_CREATED", "CALL_STARTED", "CALL_ANSWERED", "OFFER_RECEIVED", "LATE_OFFER_RECEIVED",
  "OFFER_AUTO_AWARDED", "OFFER_COMMITTED", "HUMAN_REQUIRED", "COMMITMENT_INVALIDATED",
  "CARRIER_FAILED", "RECOVERY_MARKET_CREATED", "ORDER_COMPLETED", "LATE_INBOUND_CALL", "INBOUND_CALL_ATTACHED",
  "AMENDMENT_ACCEPTED", "AMENDMENT_NEGOTIATION_STARTED", "AMENDMENT_HUMAN_REQUIRED", "COMMITMENT_AT_RISK", "ORDER_RECOVERED",
]);
function offerClassificationLabel(offer: OfferRecord | null): string | null { if (!offer) return null; if (offer.classification === "INFEASIBLE") return "Rejected"; if (offer.classification === "PARTIAL") return "Incomplete"; if (offer.classification === "DOMINATED") return "Not competitive"; return null; }
function missingFieldLabel(field: string): string { const labels: Record<string, string> = { availability: "availability", price: "price", exchange_rate: "exchange rate", pickup: "committed pickup", arrival: "committed arrival", all_in: "all-in confirmation", requirements: "condition confirmation" }; return labels[field] || displayStatus(field); }
function eventTitle(eventType: string): string { const labels: Record<string, string> = { ORDER_CREATED: "Order created", CARRIERS_AUTO_SELECTED: "Carriers selected automatically", CALL_STARTED: "Carrier calls started", CALL_ANSWERED: "Carrier answered", OFFER_RECEIVED: "Offer received", LATE_OFFER_RECEIVED: "Late offer received", OFFER_AUTO_AWARDED: "Offer awarded", OFFER_COMMITTED: "Offer committed", HUMAN_REQUIRED: "Human review requested", COMMITMENT_INVALIDATED: "Commitment invalidated", CARRIER_FAILED: "Carrier failed", RECOVERY_MARKET_CREATED: "Recovery market created", ORDER_COMPLETED: "Order completed", LATE_INBOUND_CALL: "Carrier called back after close", INBOUND_CALL_ATTACHED: "Carrier callback attached", OFFER_UPDATED: "Offer progress updated", AMENDMENT_ACCEPTED: "Amendment accepted", AMENDMENT_NEGOTIATION_STARTED: "Amendment negotiation started", AMENDMENT_HUMAN_REQUIRED: "Amendment handed to human", COMMITMENT_AT_RISK: "Commitment at risk", COMMITMENT_REPLACED: "Original commitment replaced", ORDER_RECOVERED: "Order recovered" }; return labels[eventType] || displayStatus(eventType); }
function eventSummary(event: OrderEventRecord): string | null {
  if (!event.detail) return null;
  if (!event.detail.trim().startsWith("{")) return event.detail;
  try {
    const detail = JSON.parse(event.detail) as Record<string, unknown>;
    if (event.eventType.startsWith("OFFER_") && "price" in detail) {
      const price = typeof detail.price === "number" && typeof detail.currency === "string" ? money(detail.price, detail.currency) : "Price pending";
      const arrival = typeof detail.arrival === "string" ? formatDate(detail.arrival, true) : "arrival pending";
      const violations = Array.isArray(detail.violations) ? detail.violations.filter((item): item is string => typeof item === "string") : [];
      return violations.length > 0 ? `${price} · ${violations.join("; ")}` : `${price} · ${arrival}`;
    }
    if (event.eventType === "OFFER_AUTO_AWARDED") return "Best compliant offer awarded automatically.";
    return null;
  } catch {
    return null;
  }
}
function lifecycleTone(status: string): "yellow" | "green" | "red" | "gray" { if (["SOURCING", "NEGOTIATING"].includes(status)) return "yellow"; if (["COMMITTED", "IN_PROCESS"].includes(status)) return "green"; if (["EXCEPTION", "CANCELED"].includes(status)) return "red"; return "gray"; }
function displayStatus(status: string): string { return status.toLowerCase().replaceAll("_", " "); }
function marketReasonLabel(reason: string): string { return reason === "AMENDMENT_REVALIDATION" ? "retained offer revalidation" : displayStatus(reason); }
function money(value: number | null, currency: string | null): string { if (value === null || !currency) return "—"; return new Intl.NumberFormat("es-MX", { style: "currency", currency, maximumFractionDigits: 0 }).format(value); }
function formatDate(value: string | null, compact = false): string { if (!value) return "—"; return new Date(value).toLocaleString([], compact ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
function frontierDistance(violation: OfferRecord["feasibilityViolations"][number], currency: string): string { if (violation.code === "MAXIMUM_PRICE" && violation.delta !== null) return `+${money(violation.delta, currency)} above cap`; if (["MANDATORY_PICKUP", "MANDATORY_ARRIVAL"].includes(violation.code) && violation.delta !== null) return `+${Math.ceil(violation.delta / 60_000)} min flexibility`; return violation.message; }
function priorityDisplay(priceWeight: number, speedWeight: number): { value: string; sub: string } { const price = Math.round(priceWeight * 100); const speed = Math.round(speedWeight * 100); if (price === speed) return { value: "Equal priority", sub: `${price}% price · ${speed}% speed` }; return price > speed ? { value: `${price}% price`, sub: `${speed}% speed` } : { value: `${speed}% speed`, sub: `${price}% price` }; }
