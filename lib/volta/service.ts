import "server-only";

import { loadTelephonyConfig, loadVoltaConfig } from "@/lib/config";
import { TwilioTelephonyProvider } from "@/lib/telephony";
import { TelephonyDialGateway, TwilioSmsRecapGateway } from "./gateways";
import { OpenAiAgentsRuntime } from "./openai-agents-runtime";
import { getVoltaStore } from "./store";
import { VoiceControlService } from "./voice-control-service";

let service: VoiceControlService | undefined;

/**
 * Wires the negotiation policy to the telephony ledger already in this app.
 * Building it throws when the OpenAI voice configuration is absent, which is
 * the intended behaviour: no agent should answer a carrier half-configured.
 */
export function getVoiceControlService(): VoiceControlService {
  if (service) return service;

  const telephony = loadTelephonyConfig();
  const volta = loadVoltaConfig();
  service = new VoiceControlService(
    getVoltaStore(),
    new OpenAiAgentsRuntime({
      apiKey: volta.openAiApiKey,
      webhookSecret: volta.openAiWebhookSecret,
      model: volta.realtimeModel,
      voice: volta.voice,
    }),
    new TelephonyDialGateway(new TwilioTelephonyProvider(telephony)),
    new TwilioSmsRecapGateway(telephony),
    {
      fromNumber: telephony.phoneNumber,
      sipUri: volta.sipUri,
      humanEscalationUri: volta.humanEscalationUri ?? undefined,
    },
  );
  return service;
}
