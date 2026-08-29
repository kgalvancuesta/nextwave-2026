import { z } from "zod";
import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";

export const runtime = "nodejs";
const recoverySchema = z.object({ carrierIds: z.array(z.string().uuid()).min(1).max(3).optional() });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = recoverySchema.parse(await request.json());
    return Response.json({ order: getOrderMarketService().createRecoveryMarket(id, body.carrierIds) }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
