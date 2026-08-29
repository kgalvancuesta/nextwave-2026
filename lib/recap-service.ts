import "server-only";

import { loadTelephonyConfig } from "./config";
import { getOrderMarketService, type OrderMarketService } from "./market-service";
import { createTwilioClient } from "./volta/gateways";

/** Sends one queued recap. Injected so the flush loop is testable without Twilio. */
export interface RecapSender {
  send(input: { to: string; body: string }): Promise<{ deliveryId: string }>;
}

export class TwilioRecapSender implements RecapSender {
  async send(input: { to: string; body: string }): Promise<{ deliveryId: string }> {
    const config = loadTelephonyConfig();
    // The stored body is sent verbatim. Anything that reformats it here would
    // make the audit record differ from what the carrier actually received.
    const message = await createTwilioClient(config).messages.create({
      to: input.to,
      from: config.phoneNumber,
      body: input.body,
    });
    return { deliveryId: message.sid };
  }
}

/**
 * Delivers every commitment recap still owed to a carrier. Queueing happens
 * inside the award transaction; delivery happens here, so a Twilio outage
 * delays the written record without ever rolling back a booking. Each call
 * settles every pending recap it finds and never throws: a failure is recorded
 * against its own commitment and retried on the next flush.
 */
export async function flushAwardRecaps(
  service: OrderMarketService = getOrderMarketService(),
  sender: RecapSender = new TwilioRecapSender(),
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (const recap of service.listPendingRecaps()) {
    try {
      const { deliveryId } = await sender.send({ to: recap.address, body: recap.body });
      service.markRecapSent(recap.commitmentId, deliveryId);
      sent += 1;
    } catch (error) {
      service.markRecapFailed(recap.commitmentId, error instanceof Error ? error.message : String(error));
      failed += 1;
    }
  }
  return { sent, failed };
}
