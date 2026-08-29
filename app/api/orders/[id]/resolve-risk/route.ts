import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";
import { getVoiceControlService } from "@/lib/volta/service";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const orders = getOrderMarketService();
    const existing = orders.getOrder(id);
    if (!existing) return Response.json({ error: "Order not found." }, { status: 404 });
    if (existing.order.voltaMarketId) {
      return Response.json({ order: existing, reused: true }, { status: 202 });
    }
    if (existing.order.carriers.length < 3) {
      throw new Error("Nauta needs three carriers on the order before it can run a parallel market.");
    }
    if (!existing.order.freeTimeEndsAt) throw new Error("Free-time end is required for Nauta recovery.");

    const now = new Date();
    const freeTimeEnd = new Date(existing.order.freeTimeEndsAt);
    if (freeTimeEnd <= now) throw new Error("Free time has already expired; escalate this recovery to a human.");
    const earliestPickup = existing.order.preferredArrival && new Date(existing.order.preferredArrival) > now
      ? existing.order.preferredArrival
      : now.toISOString();
    const workspace = orders.beginNautaRiskRecovery(id);
    const voice = getVoiceControlService();
    const operation = voice.createOperation({
      externalReference: `order:${workspace.order.id}`,
      objective: `Avoid demurrage for ${workspace.order.reference || workspace.order.name}: confirm ETA, secure pickup before free time ends, or negotiate an extension/fee waiver.`,
      mandate: {
        currency: workspace.order.currency,
        rate: { min: workspace.order.targetPrice, max: workspace.order.maximumPrice },
        pickupWindow: { earliest: earliestPickup, latest: workspace.order.freeTimeEndsAt },
        allowedAccessorials: ["appointment scheduling", "free-time extension", "fee waiver"],
        prohibitedTerms: workspace.order.conditions,
        maxDetentionMinutes: 0,
      },
      minimumCarrierCalls: 3,
    });
    const market = await voice.startCarrierMarket(operation.id, workspace.order.carriers.map((carrier) => ({
      name: carrier.label,
      phone: carrier.e164PhoneNumber,
      reliabilityScore: 50,
    })));
    return Response.json({
      order: orders.linkVoltaRecovery(id, operation.id, market.market.id),
      operation,
      market,
    }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
