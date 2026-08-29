import { z } from "zod";
import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";

export const runtime = "nodejs";
const invalidationSchema = z.object({ reason: z.string().trim().min(1).max(300) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { reason } = invalidationSchema.parse(await request.json());
    return Response.json({ order: getOrderMarketService().invalidateCommitment(id, reason) });
  } catch (error) {
    return apiError(error);
  }
}
