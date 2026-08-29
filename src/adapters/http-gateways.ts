import type { OutboundTelephonyGateway, RecapGateway } from "../ports.js";

export class HttpOutboundTelephonyGateway implements OutboundTelephonyGateway {
  constructor(private readonly url?: string, private readonly token?: string) {}

  async dial(input: {
    to: string;
    internalCallId: string;
    operationId: string;
    sipUri: string;
  }): Promise<{ providerCallId: string }> {
    if (!this.url) throw new Error("TELEPHONY_OUTBOUND_URL is not configured");
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        to: input.to,
        connect_to_sip_uri: input.sipUri,
        correlation: {
          internal_call_id: input.internalCallId,
          operation_id: input.operationId,
          sip_headers: {
            "X-Internal-Call-ID": input.internalCallId,
            "X-Operation-ID": input.operationId,
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Outbound telephony returned ${response.status}`);
    const body = await response.json() as { provider_call_id?: string };
    if (!body.provider_call_id) throw new Error("Outbound telephony omitted provider_call_id");
    return { providerCallId: body.provider_call_id };
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
    };
  }
}

export class HttpRecapGateway implements RecapGateway {
  constructor(private readonly url?: string, private readonly token?: string) {}

  async deliver(input: {
    channel: "sms" | "email";
    address: string;
    commitmentId: string;
    operationReference: string;
    summary: string;
  }): Promise<{ deliveryId: string }> {
    if (!this.url) throw new Error("RECAP_DELIVERY_URL is not configured");
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        channel: input.channel,
        to: input.address,
        idempotency_key: `commitment:${input.commitmentId}`,
        operation_reference: input.operationReference,
        commitment_id: input.commitmentId,
        summary: input.summary,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Recap delivery returned ${response.status}`);
    const body = await response.json() as { delivery_id?: string };
    if (!body.delivery_id) throw new Error("Recap delivery omitted delivery_id");
    return { deliveryId: body.delivery_id };
  }
}
