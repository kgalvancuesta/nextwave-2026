import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const order = getOrderMarketService().getOrder(id);
    if (!order) return Response.json({ error: "Order not found." }, { status: 404 });
    return Response.json({ order });
  } catch (error) {
    return apiError(error);
  }
}
