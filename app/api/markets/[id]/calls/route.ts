import { initiateOutboundBatch } from "@/lib/call-service";
import { loadTelephonyConfig } from "@/lib/config";
import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";
import { getRepository } from "@/lib/repository";
import { TwilioTelephonyProvider } from "@/lib/telephony";
import { assertVoiceReady } from "@/lib/voice-readiness";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const service = getOrderMarketService();
    const market = service.getMarket(id);
    if (!market) return Response.json({ error: "Market not found." }, { status: 404 });
    const config = loadTelephonyConfig();
    await assertVoiceReady();
    const started = service.startMarket(id);
    const result = await initiateOutboundBatch({
      contactIds: started.carrierIds,
      fromNumber: config.phoneNumber,
      repository: getRepository(),
      provider: new TwilioTelephonyProvider(config),
      context: { orderId: market.orderId, marketId: market.id },
    });
    return Response.json({ batch: result, market: service.reevaluateMarket(id) }, { status: 202 });
  } catch (error) {
    return apiError(error);
  }
}
