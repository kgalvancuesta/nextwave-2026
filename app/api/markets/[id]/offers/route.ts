import { z } from "zod";
import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";

export const runtime = "nodejs";
const optionalDate = z.string().datetime().nullable().optional();
const offerSchema = z.object({
  carrierId: z.string().uuid(),
  callId: z.string().uuid().nullable().optional(),
  price: z.number().int().nonnegative(),
  pickupTime: optionalDate,
  expectedArrival: optionalDate,
  waitingTimeIncluded: z.string().trim().max(300).nullable().optional(),
  extraFees: z.string().trim().max(500).nullable().optional(),
  conditions: z.string().trim().max(1000).nullable().optional(),
  isFinalOffer: z.boolean().optional(),
  requiresImmediateDecision: z.boolean().optional(),
  callbackAllowed: z.boolean().optional(),
  confirmedRequirements: z.array(z.string()).optional(),
  rejectedRequirements: z.array(z.string()).optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const market = getOrderMarketService().recordOffer(id, offerSchema.parse(await request.json()));
    return Response.json({ market }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
