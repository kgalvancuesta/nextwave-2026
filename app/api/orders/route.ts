import { z } from "zod";
import { apiError } from "@/lib/http";
import { getOrderMarketService } from "@/lib/market-service";

export const runtime = "nodejs";

const optionalDate = z.string().datetime().nullable().optional();
const orderSchema = z.object({
  name: z.string().trim().min(1).max(140),
  client: z.string().trim().min(1).max(140),
  origin: z.string().trim().min(1).max(200),
  destination: z.string().trim().min(1).max(200),
  reference: z.string().trim().max(100).nullable().optional(),
  currency: z.string().trim().length(3).default("MXN"),
  targetPrice: z.number().int().nonnegative(),
  maximumPrice: z.number().int().nonnegative(),
  preferredArrival: optionalDate,
  mustArriveBy: optionalDate,
  priceWeight: z.number().min(0).max(1),
  speedWeight: z.number().min(0).max(1),
  minimumValidOffers: z.number().int().min(1).max(10).default(2),
  desiredCarriers: z.number().int().min(1).max(3).default(3),
  conditions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  carrierIds: z.array(z.string().uuid()).min(1).max(3),
});

export async function GET() {
  try {
    return Response.json({ orders: getOrderMarketService().listOrders() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const order = getOrderMarketService().createOrder(orderSchema.parse(await request.json()));
    return Response.json({ order }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
