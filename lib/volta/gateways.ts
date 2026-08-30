import "server-only";

import twilio from "twilio";
import type { TelephonyConfig } from "@/lib/config";
import type { TelephonyProvider } from "@/lib/telephony";
import type { OutboundTelephonyGateway, RecapGateway } from "./ports";

/**
 * Dials a carrier through the telephony ledger's own Twilio provider, so a
 * negotiation call is created, recorded and status-tracked exactly like every
 * other call in the dashboard. The SIP bridge to OpenAI happens later, when
 * Twilio fetches the answer TwiML.
 */
export class TelephonyDialGateway implements OutboundTelephonyGateway {
  constructor(private readonly provider: TelephonyProvider) {}

  async dial(input: { to: string; internalCallId: string }): Promise<{ providerCallId: string }> {
    const result = await this.provider.createCall({ to: input.to, internalCallId: input.internalCallId });
    return { providerCallId: result.callSid };
  }

  async playMessageAndHangup(providerCallId: string, message: string): Promise<void> {
    await this.provider.playMessageAndHangup(providerCallId, message);
  }
}

/** Sends the written SMS recap that turns an approved verbal agreement effective. */
export class TwilioSmsRecapGateway implements RecapGateway {
  constructor(private readonly config: TelephonyConfig) {}

  async deliver(input: {
    channel: "sms" | "email";
    address: string;
    commitmentId: string;
    operationReference: string;
    summary: string;
  }): Promise<{ deliveryId: string }> {
    if (input.channel !== "sms") throw new Error("Only SMS recaps are supported");

    const body = formatSmsRecap(input);
    if (body.length > 1_600) throw new Error("SMS recap exceeds the 1600-character message limit");

    const message = await createTwilioClient(this.config).messages.create({
      to: input.address,
      from: this.config.phoneNumber,
      body,
    });
    return { deliveryId: message.sid };
  }
}

export function formatSmsRecap(input: {
  commitmentId: string;
  operationReference: string;
  summary: string;
}): string {
  return [
    `Operation ${input.operationReference}`,
    `Commitment ${input.commitmentId}`,
    input.summary,
  ].join("\n");
}

export function createTwilioClient(config: TelephonyConfig): ReturnType<typeof twilio> {
  return config.apiKeySid && config.apiKeySecret
    ? twilio(config.apiKeySid, config.apiKeySecret, { accountSid: config.accountSid })
    : twilio(config.accountSid, config.authToken!);
}
