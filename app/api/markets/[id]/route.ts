import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const market = getOrderMarketService().getMarketState(id);
    if (!market) return Response.json({ error: "Market not found." }, { status: 404 });
    return Response.json({ market });
  } catch (error) {
    return apiError(error);
  }
}
