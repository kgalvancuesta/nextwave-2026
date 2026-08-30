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
  exchangeRates: z.record(z.string().trim().length(3), z.number().positive()).optional(),
  exchangeRateSource: z.string().trim().max(200).nullable().optional(),
  targetPrice: z.number().int().nonnegative(),
  maximumPrice: z.number().int().nonnegative(),
  preferredPickup: optionalDate,
  mustPickupBy: optionalDate,
  preferredArrival: optionalDate,
  mustArriveBy: optionalDate,
  priceWeight: z.number().min(0).max(1),
  speedWeight: z.number().min(0).max(1),
  minimumValidOffers: z.number().int().min(1).max(10).default(2),
  desiredCarriers: z.number().int().min(1).max(3).default(3),
  conditions: z.array(z.string().trim().min(1).max(500)).max(20).default([]),
  carrierIds: z.array(z.string().uuid()).max(3).default([]),
  freeTimeEndsAt: optionalDate,
  currentEta: optionalDate,
  dailyDemurrageRate: z.number().int().nonnegative().optional(),
}).superRefine((order, context) => {
  if (order.mustPickupBy && order.preferredPickup && Date.parse(order.mustPickupBy) < Date.parse(order.preferredPickup)) {
    context.addIssue({ code: "custom", path: ["mustPickupBy"], message: "Must pick up by cannot be before preferred pickup." });
  }
  if (order.mustArriveBy && order.preferredArrival && Date.parse(order.mustArriveBy) < Date.parse(order.preferredArrival)) {
    context.addIssue({ code: "custom", path: ["mustArriveBy"], message: "Must arrive by cannot be before preferred arrival." });
  }
  if (order.dailyDemurrageRate && !order.freeTimeEndsAt) {
    context.addIssue({ code: "custom", path: ["freeTimeEndsAt"], message: "Free-time end is required when a demurrage rate is set." });
  }
});

export async function GET() {
  try {
    const service = getOrderMarketService();
    service.reevaluateExpiredMarkets();
    return Response.json({ orders: service.listOrders() });
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
