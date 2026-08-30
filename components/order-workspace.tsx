"use client";

import { AlertTriangle, ArrowRight, Check, ChevronDown, ChevronUp, FileText, Minus, PhoneCall, Plus, RotateCcw, Trophy, Volume2, X } from "lucide-react";
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
  // The identifier Luna speaks to carriers and they quote back, so it belongs
  // on the row itself rather than only inside the expanded panel.
  const reference = publicOrderReference(order);
  const priority = priorityDisplay(order.priceWeight, order.speedWeight);
  const activeCommitment = workspace.commitments.find((commitment) => commitment.status === "ACTIVE") || null;
  const latestAmendment = workspace.amendments[0] ?? null;
  const importantEvents = workspace.events.filter((event) => IMPORTANT_EVENT_TYPES.has(event.eventType)).slice(0, 8);
  const technicalEvents = workspace.events.filter((event) => !IMPORTANT_EVENT_TYPES.has(event.eventType));
  /** The awarded number, when one genuinely exists: the committed offer first, otherwise the market's best evaluated offer. */
  const committedOffer = activeCommitment
    ? workspace.markets.flatMap((state) => state.offers).find((offer) => offer.id === activeCommitment.offerId) ?? null
    : null;
  const payOffer = committedOffer ?? currentMarket?.bestOffer ?? null;

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
    <article className="order-card rounded-none border-0 border-b border-[var(--line)] bg-transparent last:border-b-0">
      <button type="button" onClick={onToggle} className="market-row w-full px-4 py-2.5 text-left sm:px-5">
        <span className={`icon-pill icon-pill-${toneIcon[tone].pill}`}>{toneIcon[tone].glyph}</span>
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="shrink-0 rounded bg-[var(--ice)] px-1.5 py-0.5 font-mono text-[10px] tracking-tight text-[var(--muted-text)]">{reference}</span>
            <span className="truncate text-[13.5px] font-medium">{order.name}</span>
            <span className="hidden shrink-0 items-center gap-1 text-xs text-[var(--muted-text)] sm:flex">
              <span className="max-w-[7rem] truncate">{order.origin}</span>
              <ArrowRight size={10} className="shrink-0" />
              <span className="max-w-[7rem] truncate">{order.destination}</span>
            </span>
          </span>
          {workspace.collapsedSummary && <span className="mt-0.5 block truncate text-xs text-[var(--muted-text)]">{workspace.collapsedSummary}</span>}
        </span>
        <span className="market-col-optional truncate text-[12.5px] capitalize text-[var(--muted-text)]">{displayStatus(order.lifecycleStatus)}</span>
        <span className="market-col-optional text-[12.5px] text-[var(--muted-text)]">{activeCommitment ? "Yes" : "—"}</span>
        <span className="flex justify-end text-right text-[13px] font-medium tabular-nums">
          {tone === "red"
            ? <span className="badge-attention">Needs attention</span>
            : payOffer ? money(payOffer.price, payOffer.currency) : "—"}
        </span>
        {expanded ? <ChevronUp size={16} className="text-[var(--muted-text)]" /> : <ChevronDown size={16} className="text-[var(--muted-text)]" />}
      </button>

      {expanded && <div className="@container/detail border-t border-[var(--line)] bg-[var(--paper)] px-4 py-4 sm:px-6 sm:py-5">
        {error && <div role="alert" className={`mb-4 flex items-start justify-between gap-3 rounded-[10px] border px-4 py-3 text-[13px] ${WARNING_SURFACE}`}><span>{error}</span><button onClick={() => setError(null)}><X size={16} /></button></div>}
        {/* Container query, not a viewport one: the split has to react to this
            panel's own width, since it is nested inside the Market live column.
            The @container lives on the parent — an element cannot query itself. */}
        <div className="grid grid-cols-1 items-start gap-5 @[820px]/detail:grid-cols-[300px_1fr]">
          <div className="space-y-4">
            <DemurrageRiskPanel order={order} calls={workspace.nautaCalls} busy={busy} onResolve={() => void mutate(() => requestJson(`/api/orders/${order.id}/resolve-risk`, { method: "POST" }))} />

            <section className="overflow-hidden rounded-[10px] border border-[var(--line)] bg-white">
              <p className="px-3.5 pb-2 pt-3 text-[12px] text-[var(--muted-text)]">Mandate</p>
              <div className="border-t border-[var(--line)]">
                <MandateRow label="Reference" value={reference} />
                <MandateRow label="Target" value={money(order.targetPrice, order.currency)} emphasis />
                <MandateRow label="Maximum" value={money(order.maximumPrice, order.currency)} />
                <MandateRow label="Priority" value={priority.value === "Equal priority" ? priority.sub : `${priority.value} · ${priority.sub}`} />
                <MandateRow label="Offers required" value={`${order.minimumValidOffers} of ${order.desiredCarriers} desired`} />
                <MandateRow label="Preferred pickup" value={optionalDate(order.preferredPickup)} />
                <MandateRow label="Latest pickup" value={optionalDate(order.mustPickupBy)} />
                <MandateRow label="Preferred arrival" value={optionalDate(order.preferredArrival)} />
                <MandateRow label="Latest arrival" value={optionalDate(order.mustArriveBy)} />
              </div>
              {order.conditions.length > 0 && <ul className="space-y-1.5 border-t border-[var(--line)] px-3.5 py-3 text-[13px] text-[var(--muted-text)]">{order.conditions.map((condition) => <li key={condition} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-[var(--brand)]" />{condition}</li>)}</ul>}
            </section>

            {latestAmendment && <AmendmentPanel
              amendment={latestAmendment}
              recovered={Boolean(latestAmendment.recoveryMarketId && activeCommitment?.marketId === latestAmendment.recoveryMarketId)}
              revalidating={workspace.markets.some((state) => state.market.id === latestAmendment.recoveryMarketId && state.market.reason === "AMENDMENT_REVALIDATION" && !["COMMITTED", "CANCELED"].includes(state.market.status))}
            />}

            {activeCommitment && <section className="rounded-[10px] border border-[var(--line)] bg-white p-3.5"><p className="mb-2.5 text-[12px] text-[var(--muted-text)]">Commitment</p><div className="rounded-[10px] bg-[var(--ice)] p-3.5"><div className="flex items-start justify-between gap-3"><div><p className="text-[14px] font-semibold">{activeCommitment.carrierLabel}</p><p className="mt-1 text-[12px] text-[var(--brand)]">Active commitment</p></div><Trophy size={19} className="shrink-0 text-[var(--brand)]" /></div><RecapPanel commitment={activeCommitment} /><div className="mt-4 grid gap-2"><button disabled={busy} onClick={() => void mutate(() => requestJson(`/api/orders/${order.id}/complete`, { method: "POST" }))} className="rounded-[10px] bg-[var(--ink)] px-3 py-2 text-[13px] font-medium text-white hover:opacity-90">Mark completed</button><button disabled={busy} onClick={invalidateCommitment} className="rounded-[10px] border border-[color-mix(in_srgb,var(--warning)_45%,white)] bg-white px-3 py-2 text-[13px] font-medium text-[#b4541a] hover:bg-[color-mix(in_srgb,var(--warning)_10%,white)]">Mark carrier failed</button></div></div></section>}

            {order.lifecycleStatus === "EXCEPTION" && !workspace.markets.some((state) => state.market.reason === "CARRIER_FAILURE" && ["DRAFT", "OPEN", "CALLING", "NEGOTIATING"].includes(state.market.status)) && <button disabled={busy} onClick={() => void mutate(() => requestJson(`/api/orders/${order.id}/markets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) }))} className="flex w-full items-center justify-center gap-2 rounded-[10px] border border-[var(--line)] bg-white px-3.5 py-2.5 text-[13px] font-medium hover:bg-[var(--ice)]"><RotateCcw size={15} /> Create recovery market</button>}
          </div>

          <div className="min-w-0 space-y-4">
            {currentMarket ? <MarketPanel market={currentMarket} busy={busy} onStart={() => void mutate(() => requestJson(`/api/markets/${currentMarket.market.id}/calls`, { method: "POST" }))} onAddOffer={() => setOfferOpen(true)} onCommit={(offer) => void mutate(() => requestJson(`/api/offers/${offer.id}/commit`, { method: "POST" }))} /> : <div className="rounded-[10px] border border-dashed border-[var(--line)] bg-white p-8 text-center text-[13px] text-[var(--muted-text)]">No market exists for this order.</div>}

            <MarketHistory markets={workspace.markets} currentMarketId={currentMarket?.market.id ?? null} />

            <section className="rounded-[10px] border border-[var(--line)] bg-white p-4">
              <p className="mb-2.5 text-[12px] text-[var(--muted-text)]">Order history</p>
              <div>{importantEvents.map((event) => <EventItem key={event.id} event={event} />)}{importantEvents.length === 0 && <p className="text-[13px] text-[var(--muted-text)]">No major activity yet.</p>}</div>
              {technicalEvents.length > 0 && <details className="group mt-3">
                <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg bg-[var(--ice)] px-3 py-2.5 text-[12.5px] text-[var(--muted-text)]">Technical activity ({technicalEvents.length})<ChevronDown size={14} className="transition-transform group-open:rotate-180" /></summary>
                <div className="pt-1">{technicalEvents.slice(0, 20).map((event) => <EventItem key={event.id} event={event} technical />)}</div>
              </details>}
            </section>
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
  const settled = recovered || accepted;
  const tone = settled ? "border-[var(--line)] bg-[var(--ice)] text-[var(--ink)]" : WARNING_SURFACE;
  const title = recovered ? "Recovered" : accepted ? "Amendment accepted" : revalidating ? "Revalidating retained offers" : atRisk ? "Commitment at risk" : "Human review required";
  return <section className="rounded-[10px] border border-[var(--line)] bg-white p-3.5"><p className="mb-2.5 text-[12px] text-[var(--muted-text)]">Self-healing order</p><div className={`rounded-[10px] border p-3.5 ${tone}`}><div className="flex items-start gap-3"><AlertTriangle size={18} className={`mt-0.5 shrink-0 ${settled ? "text-[var(--brand)]" : ""}`} /><div><p className="font-semibold">{title}</p><p className="mt-0.5 text-[13px] opacity-80">{amendment.carrierLabel} · {amendment.decisionReason}</p></div></div><div className="mt-4 grid gap-2.5 text-[13px] sm:grid-cols-2"><Terms label="Original" terms={amendment.originalTerms} /><Terms label={accepted ? "Accepted" : "Requested"} terms={accepted ? amendment.finalTerms ?? amendment.requestedTerms : amendment.requestedTerms} /></div>{amendment.violations.length > 0 && <div className="mt-3 border-t border-current/15 pt-3"><p className="font-medium">Hard-constraint violations</p><ul className="mt-1 list-disc pl-5 text-[13px]">{amendment.violations.map((violation) => <li key={`${violation.code}-${violation.message}`}>{violation.message}</li>)}</ul></div>}{revalidating && <p className="mt-3 text-[12px] opacity-80">Original commitment stays active · only better prior offers are being reconfirmed</p>}{atRisk && !revalidating && <p className="mt-3 text-[12px] opacity-80">Recovery market open · prior bidders prioritized</p>}{recovered && <p className="mt-3 text-[12px] opacity-80">Original carrier replaced · commitment preserved</p>}</div></section>;
}

function MarketHistory({ markets, currentMarketId }: { markets: MarketState[]; currentMarketId: string | null }) {
  return <section className="rounded-[10px] border border-[var(--line)] bg-white p-4"><p className="mb-1 text-[12px] text-[var(--muted-text)]">Market history</p><div className="divide-y divide-[var(--line)]">{markets.map((state) => {
    const isCurrent = state.market.id === currentMarketId;
    return <details key={state.market.id} open={!isCurrent && state.market.sequenceNumber === 1} className="group"><summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-3 text-[13px]"><div><span className="font-medium">Market #{state.market.sequenceNumber}</span><span className="ml-2 capitalize text-[var(--muted-text)]">{marketReasonLabel(state.market.reason)}</span>{isCurrent && <span className="ml-2 rounded-full bg-[var(--ice)] px-2 py-0.5 text-[11.5px] text-[var(--brand)]">Current</span>}</div><span className="flex items-center gap-2 text-[12px] capitalize text-[var(--muted-text)]">{displayStatus(state.market.status)}<ChevronDown size={14} className="transition-transform group-open:rotate-180" /></span></summary><HistoricalMarketDetails market={state} isCurrent={isCurrent} /></details>;
  })}</div></section>;
}

/**
 * The current market's carriers are already listed above in full, so its history
 * entry shows only the summary — repeating the whole list on one screen reads as
 * two different tables saying the same thing.
 */
function HistoricalMarketDetails({ market, isCurrent }: { market: MarketState; isCurrent: boolean }) {
  return <div className="mb-3.5"><div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3"><MiniMetric label="Carriers" value={market.progress.carriersSelected} /><MiniMetric label="Offers" value={market.offers.length} /><MiniMetric label="Calls completed" value={market.progress.callsCompleted} /></div>{isCurrent ? <p className="mt-2.5 text-[12px] text-[var(--muted-text)]">Carrier detail for this market is listed under Current market above.</p> : <div className="mt-3.5"><CarrierList>{market.carriers.map((carrier) => <CarrierRow key={carrier.carrier.id} carrier={carrier} canCommit={false} onCommit={() => undefined} />)}</CarrierList></div>}</div>;
}

function Terms({ label, terms }: { label: string; terms: AmendmentRecord["originalTerms"] }) {
  return <div className="rounded-[10px] bg-white/70 p-3"><p className="text-[12px] text-[var(--muted-text)]">{label}</p><p className="mt-1.5 font-semibold">{money(terms.price, terms.currency)}</p><p className="mt-1 text-[12px] opacity-75">Pickup {formatDate(terms.pickupTime, true)}</p><p className="mt-0.5 text-[12px] opacity-75">Arrival {formatDate(terms.expectedArrival, true)}</p></div>;
}

function DemurrageRiskPanel({ order, calls, busy, onResolve }: { order: OrderWorkspace["order"]; calls: OrderWorkspace["nautaCalls"]; busy: boolean; onResolve: () => void }) {
  if (!order.freeTimeEndsAt || order.dailyDemurrageRate <= 0) return null;
  const hoursRemaining = Math.round((Date.parse(order.freeTimeEndsAt) - Date.parse(order.updatedAt)) / 3_600_000);
  const etaOverrunDays = order.currentEta && Date.parse(order.currentEta) > Date.parse(order.freeTimeEndsAt)
    ? Math.max(1, Math.ceil((Date.parse(order.currentEta) - Date.parse(order.freeTimeEndsAt)) / 86_400_000))
    : 1;
  const exposure = etaOverrunDays * order.dailyDemurrageRate;
  const inProgress = order.riskStatus === "IN_PROGRESS";
  return <section className={`rounded-[10px] border p-3.5 ${inProgress ? "border-[var(--line)] bg-[var(--ice)] text-[var(--ink)]" : WARNING_SURFACE}`}>
    <div className="flex items-start gap-3"><span className={`mt-0.5 shrink-0 rounded-full bg-white/70 p-2 ${inProgress ? "text-[var(--brand)]" : ""}`}><AlertTriangle size={18} /></span><div className="min-w-0 flex-1"><p className="text-[12px] opacity-80">Exception watch · source: Nina</p><h3 className="mt-1 text-[15px] font-semibold">{inProgress ? "Recovery in progress" : "Demurrage exposure"}</h3><p className="mt-1 text-[12.5px] opacity-80">Free time ends {formatDate(order.freeTimeEndsAt)} · {hoursRemaining >= 0 ? `${hoursRemaining} hours remaining` : `${Math.abs(hoursRemaining)} hours overdue`}</p></div></div>
    <div className="mt-3.5 grid grid-cols-2 gap-2"><Metric label="Potential exposure" value={money(exposure, order.currency)} sub={`${money(order.dailyDemurrageRate, order.currency)} / day`} /><Metric label="Current ETA" value={order.currentEta ? formatDate(order.currentEta, true) : "Unconfirmed"} /></div>
    {inProgress ? <><p className="mt-3.5 text-[12.5px] leading-relaxed">Luna is verifying the pickup by phone: confirming the truck, the appointment and the final rate, and preparing an extension or fee-waiver fallback. Every answer is recorded in the order audit trail.</p>{calls.length > 0 && <div className="mt-3.5 space-y-2">{calls.map((call) => <div key={call.id} className="flex items-center justify-between gap-3 rounded-[10px] bg-white/70 px-3 py-2 text-[13px]"><span className="font-medium">{call.contactLabel || call.toNumber}</span><span className="capitalize opacity-80">{displayStatus(call.status)}</span></div>)}</div>}</> : <button disabled={busy} onClick={onResolve} className="signal-button mt-3.5 w-full"><PhoneCall size={16} /> Luna: verify and recover by phone</button>}
  </section>;
}

/**
 * A verbal agreement the carrier cannot re-read is not evidence. This shows
 * whether the written record actually reached them, and what it said.
 */
function RecapPanel({ commitment }: { commitment: CommitmentRecord }) {
  const [open, setOpen] = useState(false);
  if (commitment.recapStatus === "NOT_REQUIRED") return null;
  const tone = commitment.recapStatus === "FAILED" ? "text-[#b4541a]" : "text-[var(--brand)]";
  const label = commitment.recapStatus === "SENT" ? `Written recap sent to ${commitment.recapAddress}`
    : commitment.recapStatus === "FAILED" ? "Written recap failed"
      : "Written recap queued";
  return <div className="mt-3 border-t border-[var(--line)] pt-3">
    <div className="flex items-start gap-2">
      <FileText size={14} className={`mt-0.5 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <p className={`text-[12.5px] font-medium ${tone}`}>{label}</p>
        {commitment.recapSentAt && <p className="text-[11.5px] text-[var(--muted-text)]">{formatDate(commitment.recapSentAt, true)} · {commitment.recapDeliveryId}</p>}
        {commitment.recapError && <p className="mt-0.5 text-[11.5px] text-[#b4541a]">{commitment.recapError}</p>}
        {commitment.recapBody && <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-[11.5px] text-[var(--brand)] hover:underline">{open ? "Hide" : "Show"} what was sent</button>}
      </div>
    </div>
    {open && commitment.recapBody && <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-[10px] border border-[var(--line)] bg-white p-2 text-[11.5px] leading-relaxed">{commitment.recapBody}</pre>}
  </div>;
}

function MarketPanel({ market, busy, onStart, onAddOffer, onCommit }: { market: MarketState; busy: boolean; onStart: () => void; onAddOffer: () => void; onCommit: (offer: OfferRecord) => void }) {
  const canStart = market.market.status === "DRAFT" && market.progress.callsStarted === 0;
  const canAddOffer = ["DRAFT", "OPEN", "CALLING", "NEGOTIATING", "HUMAN_REVIEW"].includes(market.market.status);
  const latestOfferIds = new Set(market.carriers.map((carrier) => carrier.latestOffer?.id).filter(Boolean));
  return <section className="rounded-[10px] border border-[var(--line)] bg-white p-4">
    <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-[12px] text-[var(--muted-text)]">Current market · #{market.market.sequenceNumber}</p>
        <div className="mt-1 flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full bg-[var(--brand)]" /><span className="text-[12px] capitalize text-[var(--muted-text)]">{displayStatus(market.market.status)} · {displayStatus(market.phase)} · rev {market.market.revision}</span></div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {canAddOffer && <button disabled={busy} onClick={onAddOffer} className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3 py-1.5 text-[12.5px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"><Plus size={14} /> Add offer</button>}
        {canStart && <button disabled={busy} onClick={onStart} className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-white px-3 py-1.5 text-[12.5px] font-medium hover:bg-[var(--ice)] disabled:cursor-not-allowed disabled:opacity-40"><PhoneCall size={14} /> Call {market.progress.carriersSelected} carriers</button>}
      </div>
    </div>
    {market.reviewReason && <div className={`mb-4 rounded-[10px] border px-4 py-3 text-[13px] ${WARNING_SURFACE}`}><strong className="font-medium">Human review required.</strong> {market.reviewReason}</div>}
    <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4"><MiniMetric label="Carriers" value={market.progress.carriersSelected} /><MiniMetric label="Calls active" value={market.progress.callsActive} /><MiniMetric label="Valid offers" value={market.progress.validOffers} /><MiniMetric label="Calls completed" value={market.progress.callsCompleted} /></div>
    <div className="mb-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2"><OfferHighlight label="Best evaluated" offer={market.bestOffer} accent /><OfferHighlight label="Cheapest" offer={market.cheapestOffer} /></div>
    <CarrierList>{market.carriers.map((carrier) => <CarrierRow key={carrier.carrier.id} carrier={carrier} canCommit={Boolean(carrier.latestOffer?.isComparable && carrier.latestOffer.isValid && latestOfferIds.has(carrier.latestOffer.id) && market.progress.validOffers >= market.market.mandate.minimumValidOffers && !market.activeCommitment)} onCommit={onCommit} />)}</CarrierList>
    {market.nearFeasibleOffers.length > 0 && <div className={`mt-4 rounded-[10px] border p-4 ${WARNING_SURFACE}`}><p className="text-[12px] font-medium">Feasibility frontier · human decision support</p><div className="mt-2 space-y-2">{market.nearFeasibleOffers.map((offer) => <div key={offer.id} className="text-[13px]"><strong className="font-medium">{offer.carrierLabel}</strong> · {money(offer.price, offer.currency)} · {formatDate(offer.expectedArrival, true)}<span className="block text-[12px] opacity-80">{offer.feasibilityViolations.map((violation) => frontierDistance(violation, offer.normalizedCurrency)).join("; ")}</span></div>)}</div><p className="mt-3 text-[12px] opacity-80">These values are decision support only. Luna cannot accept them outside the mandate.</p></div>}
    {market.progress.validOffers < market.market.mandate.minimumValidOffers && market.progress.validOffers > 0 && <p className="mt-3 text-[12px] text-[var(--muted-text)]">{market.market.mandate.minimumValidOffers - market.progress.validOffers} more valid offer required before commitment.</p>}
  </section>;
}

/** Header + shared grid frame for the carrier rows, replacing the old `market-table`. */
function CarrierList({ children }: { children: React.ReactNode }) {
  return <div className="overflow-x-auto"><div className="min-w-[480px]">
    <div className={`${CARRIER_GRID} border-b border-[var(--line)] pb-2 text-[12px] text-[var(--muted-text)]`}><div>Carrier</div><div>Latest</div><div>Arrival</div><div>Status</div><div /></div>
    {children}
  </div></div>;
}

function CarrierRow({ carrier, canCommit, onCommit }: { carrier: MarketCarrierState; canCommit: boolean; onCommit: (offer: OfferRecord) => void }) {
  const offer = carrier.latestOffer ?? carrier.retainedOffer;
  const awaitingReconfirmation = !carrier.latestOffer && Boolean(carrier.retainedOffer);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const classification = offerClassificationLabel(offer);
  const statusLabel = awaitingReconfirmation ? "awaiting confirmation" : displayStatus(carrier.status);
  const needsAttention = awaitingReconfirmation
    || ["HUMAN", "FAILED", "UNAVAILABLE"].includes(carrier.status)
    || ["HUMAN_REQUIRED", "REQUEST_HUMAN_REVIEW"].includes(carrier.instruction.action);
  // The winner is the one row that should read at a glance: soft green surface,
  // green pill, nothing else changes.
  const isWinner = carrier.status === "AWARDED" || carrier.instruction.action === "AWARD";
  return <div className={`border-b border-[var(--line)] last:border-b-0 ${isWinner ? "-mx-3 rounded-[10px] bg-[#E8F7EF] px-3" : ""}`}>
    <div className={`${CARRIER_GRID} items-center py-3.5`}>
      <div className="min-w-0">
        <div className="text-[13.5px] font-medium">{carrier.carrier.label}</div>
        {carrier.rank !== null && <div className="mt-0.5 text-[11.5px] text-[var(--muted-text)]">Rank {carrier.rank}</div>}
        {carrier.latestCall && <>
          <div className="mt-0.5 text-[11.5px] capitalize text-[var(--muted-text)]">Call {displayStatus(carrier.latestCall.status)}</div>
          {carrier.latestCall.errorMessage && <div className="mt-1 text-[11.5px] text-[#b4541a]">{carrier.latestCall.errorMessage}</div>}
        </>}
      </div>
      <div className="min-w-0">
        {offer ? <>
          <div>
            <span className="text-[13.5px] font-medium">{money(offer.price, offer.currency)}</span>
            {awaitingReconfirmation && <span className="ml-2 text-[11.5px] text-[var(--brand)]">Prior · confirm</span>}
            {classification && !awaitingReconfirmation && <span className="ml-2 text-[11.5px] text-[var(--muted-text)]">{classification}</span>}
          </div>
          {offer.normalizedPrice !== null && offer.currency !== offer.normalizedCurrency && <span className="mt-0.5 block text-[11.5px] text-[var(--muted-text)]">{money(offer.normalizedPrice, offer.normalizedCurrency)} standardized</span>}
          {offer.missingFields.length > 0 && <span className="mt-0.5 block text-[11.5px] text-[var(--muted-text)]">Needs {offer.missingFields.map(missingFieldLabel).join(", ")}</span>}
          {offer.evidence && <EvidenceButton offer={offer} />}
        </> : <span className="text-[13px] text-[var(--muted-text)]">—</span>}
      </div>
      <div className="text-[13px] text-[var(--muted-text)]">{formatDate(offer?.expectedArrival || null, true)}</div>
      <div className="min-w-0">
        <span className={needsAttention ? "badge-attention" : `inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] capitalize ${isWinner ? "bg-[#0F7A4D] text-white" : "bg-[var(--ice)] text-[var(--muted-text)]"}`}>{statusLabel}</span>
        <span className="mt-1 block text-[11.5px] leading-snug text-[var(--muted-text)]">{instructionReasonLabel(carrier.instruction)}</span>
      </div>
      <div className="flex justify-end gap-2">
        {offer && <button onClick={() => setDetailsOpen((open) => !open)} className="rounded-md border border-[var(--line)] bg-white px-2 py-0.5 text-[11.5px] font-medium text-[var(--muted-text)] hover:text-[var(--ink)]">{detailsOpen ? "Hide" : "Details"}</button>}
        {offer && canCommit && <button onClick={() => onCommit(offer)} className="rounded-md bg-[var(--ink)] px-2 py-0.5 text-[11.5px] font-medium text-white">Commit</button>}
      </div>
    </div>
    {offer && detailsOpen && <div className="mb-3 rounded-[10px] bg-[var(--ice)]"><OfferDetails offer={offer} /></div>}
  </div>;
}

function OfferDetails({ offer }: { offer: OfferRecord }) {
  return <div className="grid gap-4 p-3.5 text-[13px] sm:grid-cols-2"><div><p className="text-[12px] text-[var(--muted-text)]">Commercial terms</p><dl className="mt-2 space-y-1.5"><Detail label="Quoted" value={money(offer.price, offer.currency)} /><Detail label="Standardized" value={offer.normalizedPrice === null ? "Exchange rate missing" : money(offer.normalizedPrice, offer.normalizedCurrency)} /><Detail label="Exchange rate" value={offer.exchangeRate === null || !offer.currency ? "—" : `1 ${offer.currency} = ${offer.exchangeRate} ${offer.normalizedCurrency}`} /><Detail label="Arrival" value={formatDate(offer.expectedArrival)} /><Detail label="All-in" value={offer.rateAllIn === true ? "Confirmed" : offer.rateAllIn === false ? "No" : "Not confirmed"} /></dl></div><div><p className="text-[12px] text-[var(--muted-text)]">Decision</p>{offer.feasibilityViolations.length > 0 ? <div className={`mt-2 rounded-[10px] border p-3 ${WARNING_SURFACE}`}><p className="font-medium">Rejected because</p><ul className="mt-1 list-disc pl-5">{offer.feasibilityViolations.map((violation) => <li key={`${violation.code}-${violation.message}`}>{violation.message}</li>)}</ul></div> : offer.missingFields.length > 0 ? <div className={`mt-2 rounded-[10px] border p-3 ${WARNING_SURFACE}`}><p className="font-medium">Incomplete offer</p><p className="mt-1">Still needed: {offer.missingFields.map(missingFieldLabel).join(", ")}.</p></div> : <div className="mt-2 rounded-[10px] border border-[var(--line)] bg-white p-3">Meets the configured hard constraints.</div>}{offer.rawStatement && <div className="mt-3"><p className="font-medium">Carrier statement</p><p className="mt-1 text-[var(--muted-text)]">“{offer.rawStatement}”</p></div>}</div>{offer.exchangeRateSource && <p className="text-[12px] text-[var(--muted-text)] sm:col-span-2">Rate source: {offer.exchangeRateSource}</p>}</div>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="flex justify-between gap-4"><dt className="text-[var(--muted-text)]">{label}</dt><dd className="text-right font-medium">{value}</dd></div>; }

function EvidenceButton({ offer }: { offer: OfferRecord }) {
  const [open, setOpen] = useState(false);
  const evidence = offer.evidence!;
  const seconds = evidence.offsetMs !== null ? Math.max(0, Math.floor(evidence.offsetMs / 1000)) : null;
  if (!evidence.audioUrl && !evidence.rawStatement) return null;
  return <div className="mt-1">
    <button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 whitespace-nowrap text-[10.5px] text-[var(--muted-text)] hover:text-[var(--ink)]">
      <Volume2 size={10} className="shrink-0" /> Evidence{seconds !== null ? ` · ${formatOffset(seconds)}` : ""}
    </button>
    {open && <div className="mt-1.5 rounded-lg border border-[var(--line)] bg-[var(--ice)] p-2">
      {evidence.rawStatement && <p className="text-[12px] italic text-[var(--ink)]">&ldquo;{evidence.rawStatement}&rdquo;</p>}
      {evidence.audioUrl
        ? <audio controls preload="none" className="mt-1.5 w-full" src={`${evidence.audioUrl}${seconds ? `#t=${seconds}` : ""}`} />
        : <p className="mt-1 text-[11.5px] text-[var(--muted-text)]">Audio not available. Set RECORD_CALLS=true before the call to capture it.</p>}
      <p className="mt-1 text-[11.5px] text-[var(--muted-text)]">Captured {formatDate(evidence.capturedAt, true)}</p>
    </div>}
  </div>;
}

function formatOffset(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function EventItem({ event, technical = false }: { event: OrderEventRecord; technical?: boolean }) {
  const summary = eventSummary(event);
  return <div className="flex gap-3 py-2.5"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--line-strong)]" /><div className="min-w-0 flex-1"><p className="text-[13px] font-medium">{eventTitle(event.eventType)}</p>{summary && <p className="text-[12.5px] text-[var(--muted-text)]">{summary}</p>}<p className="mt-0.5 text-[11.5px] text-[var(--muted-text)]">{formatDate(event.createdAt)}</p>{technical && event.detail && event.detail.trim().startsWith("{") && <details className="mt-1 min-w-0"><summary className="cursor-pointer text-[11.5px] text-[var(--muted-text)]">Raw data</summary><pre className="mt-1 max-h-48 w-full overflow-auto whitespace-pre-wrap break-all rounded-lg border border-[var(--line)] bg-[var(--ice)] p-2 text-[11px] leading-relaxed text-[var(--muted-text)]">{event.detail}</pre></details>}</div></div>;
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
  return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(19,35,31,.62)] p-4 backdrop-blur-sm" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form onSubmit={save} className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-[12px] text-[var(--muted-text)]">Manual market input</p><h3 className="mt-1 text-2xl font-semibold">Record offer</h3></div><button type="button" onClick={onClose} className="icon-button"><X size={18} /></button></div>{error && <div className={`mt-4 rounded-[10px] border px-4 py-3 text-[13px] ${WARNING_SURFACE}`}>{error}</div>}<div className="mt-6 grid gap-4 sm:grid-cols-2"><Field label="Carrier"><select required className="field-input" value={draft.carrierId} onChange={(e) => setDraft({ ...draft, carrierId: e.target.value })}>{market.carriers.map((carrier) => <option key={carrier.carrier.id} value={carrier.carrier.id}>{carrier.carrier.label}</option>)}</select></Field><Field label="Quoted price"><div className="grid grid-cols-[1fr_7rem] gap-2"><input required type="number" min="0" step="1" className="field-input" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} /><select aria-label="Quoted currency" className="field-input" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}>{Object.keys(market.market.mandate.exchangeRates).map((currency) => <option key={currency}>{currency}</option>)}</select></div></Field><Field label="Pickup time"><input type="datetime-local" className="field-input" value={draft.pickupTime} onChange={(e) => setDraft({ ...draft, pickupTime: e.target.value })} /></Field><Field label="Expected arrival"><input required type="datetime-local" className="field-input" value={draft.expectedArrival} onChange={(e) => setDraft({ ...draft, expectedArrival: e.target.value })} /></Field><Field label="Carrier conditions" wide><textarea rows={3} className="field-input resize-none" value={draft.conditions} onChange={(e) => setDraft({ ...draft, conditions: e.target.value })} placeholder="Two hours waiting included" /></Field></div><div className="mt-4 grid gap-2 text-sm sm:grid-cols-2"><CheckField label="All mandate conditions confirmed" checked={draft.requirementsConfirmed} onChange={(value) => setDraft({ ...draft, requirementsConfirmed: value })} /><CheckField label="Final offer" checked={draft.isFinalOffer} onChange={(value) => setDraft({ ...draft, isFinalOffer: value })} /><CheckField label="Immediate answer" checked={draft.requiresImmediateDecision} onChange={(value) => setDraft({ ...draft, requiresImmediateDecision: value })} /><CheckField label="Callback allowed" checked={draft.callbackAllowed} onChange={(value) => setDraft({ ...draft, callbackAllowed: value })} /></div><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={onClose} className="secondary-button">Cancel</button><button disabled={busy} className="primary-button">{busy ? "Saving…" : "Record offer"}</button></div></form></div>;
}

function OfferHighlight({ label, offer, accent }: { label: string; offer: OfferRecord | null; accent?: boolean }) { return <div className="rounded-[10px] bg-[var(--ice)] px-3.5 py-3"><p className={`text-[12px] ${accent ? "text-[var(--brand)]" : "text-[var(--muted-text)]"}`}>{label}</p>{offer ? <><p className="mt-1.5 text-xl font-semibold tracking-tight">{money(offer.price, offer.currency)}</p><p className="mt-1 text-[12.5px] text-[var(--muted-text)]">{offer.carrierLabel} · Score {offer.score}</p></> : <p className="mt-2 text-[13px] text-[var(--muted-text)]">No valid offer yet</p>}</div>; }
function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) { return <div className="rounded-[10px] bg-white/70 px-3.5 py-3"><p className="text-[12px] text-[var(--muted-text)]">{label}</p><p className="mt-1 font-medium">{value}</p>{sub && <p className="mt-0.5 text-[12px] text-[var(--muted-text)]">{sub}</p>}</div>; }
function MiniMetric({ label, value }: { label: string; value: number }) { return <div className="rounded-[10px] bg-[var(--ice)] px-3.5 py-3"><p className="text-[12px] text-[var(--muted-text)]">{label}</p><p className="mt-1 text-xl font-semibold">{value}</p></div>; }
function MandateRow({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) { return <div className="flex items-baseline justify-between gap-3 border-b border-[var(--line)] px-3.5 py-2.5 text-[13px] last:border-b-0"><span className="text-[var(--muted-text)]">{label}</span><span className={emphasis ? "text-[15px] font-semibold" : "font-medium"}>{value}</span></div>; }
function optionalDate(value: string | null): string { return value ? formatDate(value) : "Not set"; }
const CARRIER_GRID = "grid grid-cols-[1.4fr_1.2fr_1fr_1.4fr_auto] gap-3";
/** Freight Orange is the only urgency colour in the brand; every warning surface reuses it. */
const WARNING_SURFACE = "border-[color-mix(in_srgb,var(--warning)_40%,white)] bg-[color-mix(in_srgb,var(--warning)_10%,white)] text-[#8f4413]";
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
/** The collapsed row's status icon, keyed by the same tone lifecycleTone() already returns. */
const toneIcon: Record<"yellow" | "green" | "red" | "gray", { pill: string; glyph: React.ReactNode }> = {
  green: { pill: "ok", glyph: <Check size={11} strokeWidth={2.5} /> },
  yellow: { pill: "call", glyph: <PhoneCall size={11} strokeWidth={2.25} /> },
  red: { pill: "warn", glyph: <AlertTriangle size={11} strokeWidth={2.25} /> },
  gray: { pill: "idle", glyph: <Minus size={11} strokeWidth={2.5} /> },
};
function lifecycleTone(status: string): "yellow" | "green" | "red" | "gray" { if (["SOURCING", "NEGOTIATING"].includes(status)) return "yellow"; if (["COMMITTED", "IN_PROCESS"].includes(status)) return "green"; if (["EXCEPTION", "CANCELED"].includes(status)) return "red"; return "gray"; }
/**
 * The evaluator's own reason, in words a judge can read off a projector. A bare
 * "RELEASE" does not say whether the carrier was dominated, broke a hard
 * constraint, or simply lost the market.
 */
function instructionReasonLabel(instruction: MarketCarrierState["instruction"]): string {
  const labels: Record<string, string> = {
    awaiting_first_offer: "Waiting for their first quote",
    call_ended_without_offer: "Call ended before they quoted",
    carrier_unavailable: "They said they cannot cover it",
    hard_constraint_violation: "Breaks a hard limit of the mandate",
    pareto_dominated: "Another carrier is cheaper and faster",
    partial_offer_call_ended: "Call ended with an incomplete quote",
    nondominated_offer_waiting_for_market: "Still competitive - held while other lanes finish",
    frontier_negotiation_complete: "Best terms reached - holding for the decision",
    improve_price_on_frontier: instruction.targetPrice === null
      ? "Countering for a better price"
      : `Countering at ${instruction.targetPrice}`,
    improve_arrival_on_frontier: instruction.targetArrival === null
      ? "Countering for an earlier arrival"
      : `Countering for arrival by ${formatDate(instruction.targetArrival, true)}`,
    best_current_feasible_offer: "Won: best feasible offer in the market",
    market_awarded_to_better_offer: "Released: another carrier won",
    market_closed: "Market already closed",
    active_commitment: "Holds the active commitment",
    offer_requires_human: "Needs human authority",
    human_authority_required: "Paused for a human",
  };
  if (instruction.reason.startsWith("missing_")) {
    return `Asking for the ${missingFieldLabel(instruction.reason.slice("missing_".length))}`;
  }
  return labels[instruction.reason] || displayStatus(instruction.reason);
}

function displayStatus(status: string): string { return status.toLowerCase().replaceAll("_", " "); }
function marketReasonLabel(reason: string): string { return reason === "AMENDMENT_REVALIDATION" ? "retained offer revalidation" : displayStatus(reason); }
function money(value: number | null, currency: string | null): string { if (value === null || !currency) return "—"; return new Intl.NumberFormat("es-MX", { style: "currency", currency, maximumFractionDigits: 0 }).format(value); }
function formatDate(value: string | null, compact = false): string { if (!value) return "—"; return new Date(value).toLocaleString([], compact ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
function frontierDistance(violation: OfferRecord["feasibilityViolations"][number], currency: string): string { if (violation.code === "MAXIMUM_PRICE" && violation.delta !== null) return `+${money(violation.delta, currency)} above cap`; if (["MANDATORY_PICKUP", "MANDATORY_ARRIVAL"].includes(violation.code) && violation.delta !== null) return `+${Math.ceil(violation.delta / 60_000)} min flexibility`; return violation.message; }
function priorityDisplay(priceWeight: number, speedWeight: number): { value: string; sub: string } { const price = Math.round(priceWeight * 100); const speed = Math.round(speedWeight * 100); if (price === speed) return { value: "Equal priority", sub: `${price}% price · ${speed}% speed` }; return price > speed ? { value: `${price}% price`, sub: `${speed}% speed` } : { value: `${speed}% speed`, sub: `${price}% price` }; }
