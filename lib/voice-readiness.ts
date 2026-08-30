import "server-only";

import OpenAI from "openai";
import twilio from "twilio";
import { loadTelephonyConfig, loadVoltaConfig } from "./config";

export interface VoiceReadinessCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface VoiceReadinessResult {
  ready: boolean;
  checkedAt: string;
  checks: VoiceReadinessCheck[];
}

const READY_CACHE_MS = 30_000;
const BLOCKED_CACHE_MS = 5_000;
let cached: { expiresAt: number; result: VoiceReadinessResult } | null = null;
let inFlight: Promise<VoiceReadinessResult> | null = null;

export async function getVoiceReadiness(options: { force?: boolean } = {}): Promise<VoiceReadinessResult> {
  const now = Date.now();
  if (!options.force && cached && cached.expiresAt > now) return cached.result;
  if (!options.force && inFlight) return inFlight;

  inFlight = assessVoiceReadiness();
  try {
    const result = await inFlight;
    cached = {
      result,
      expiresAt: Date.now() + (result.ready ? READY_CACHE_MS : BLOCKED_CACHE_MS),
    };
    return result;
  } finally {
    inFlight = null;
  }
}

export async function assertVoiceReady(): Promise<void> {
  const result = await getVoiceReadiness();
  if (result.ready) return;
  const failures = result.checks.filter((check) => !check.ok).map((check) => check.message);
  throw new Error(`Voice system is not ready. ${failures.join(" ")}`);
}

export function clearVoiceReadinessCache(): void {
  cached = null;
}

export function evaluateVoiceEndpointConfig(input: {
  publicBaseUrl: string;
  openAiWebhookUrl: string | undefined;
  sipUri: string;
  projectId: string | null;
}): VoiceReadinessCheck[] {
  const publicUrl = new URL(input.publicBaseUrl);
  const expectedWebhookUrl = `${input.publicBaseUrl}/api/webhooks/openai`;
  const webhookUrl = input.openAiWebhookUrl?.trim().replace(/\/$/, "");
  const sipProject = input.sipUri.match(/^sips?:([^@;?]+)@sip(?:-eu)?\.api\.openai\.com(?:[;?]|$)/i)?.[1] ?? null;

  return [
    {
      id: "stable_public_origin",
      ok: !publicUrl.hostname.endsWith(".trycloudflare.com"),
      message: publicUrl.hostname.endsWith(".trycloudflare.com")
        ? "PUBLIC_BASE_URL uses an ephemeral trycloudflare.com hostname. Configure a named tunnel before dialing."
        : "Public origin uses a stable hostname.",
    },
    {
      id: "openai_webhook_target",
      ok: webhookUrl === expectedWebhookUrl,
      message: webhookUrl === expectedWebhookUrl
        ? "OpenAI webhook target matches the public origin."
        : `OPENAI_WEBHOOK_URL must equal ${expectedWebhookUrl} after the project webhook is updated.`,
    },
    {
      id: "sip_project",
      ok: Boolean(sipProject) && (!input.projectId || sipProject === input.projectId),
      message: !sipProject
        ? "OPENAI_SIP_URI is not an OpenAI project SIP endpoint."
        : input.projectId && sipProject !== input.projectId
          ? "OPENAI_SIP_URI does not match OPENAI_PROJECT_ID."
          : "OpenAI SIP endpoint matches the configured project.",
    },
  ];
}

async function assessVoiceReadiness(): Promise<VoiceReadinessResult> {
  const checks: VoiceReadinessCheck[] = [];
  let telephony: ReturnType<typeof loadTelephonyConfig>;
  let volta: ReturnType<typeof loadVoltaConfig>;

  try {
    telephony = loadTelephonyConfig();
    checks.push({ id: "telephony_config", ok: true, message: "Twilio configuration is present." });
  } catch (error) {
    checks.push({ id: "telephony_config", ok: false, message: errorMessage(error) });
    return result(checks);
  }

  try {
    volta = loadVoltaConfig();
    checks.push({ id: "openai_config", ok: true, message: "OpenAI voice configuration is present." });
  } catch (error) {
    checks.push({ id: "openai_config", ok: false, message: errorMessage(error) });
    return result(checks);
  }

  const endpointChecks = evaluateVoiceEndpointConfig({
    publicBaseUrl: telephony.publicBaseUrl,
    openAiWebhookUrl: process.env.OPENAI_WEBHOOK_URL,
    sipUri: volta.sipUri,
    projectId: volta.projectId,
  });
  checks.push(...endpointChecks);
  if (endpointChecks.some((check) => !check.ok)) return result(checks);

  const [publicOrigin, twilioConfig, openAiModel] = await Promise.all([
    checkPublicOrigin(telephony.publicBaseUrl),
    checkTwilioConfiguration(telephony),
    checkOpenAiModel(volta.openAiApiKey, volta.realtimeModel),
  ]);
  checks.push(publicOrigin, twilioConfig, openAiModel);
  return result(checks);
}

async function checkPublicOrigin(publicBaseUrl: string): Promise<VoiceReadinessCheck> {
  try {
    const response = await fetch(`${publicBaseUrl}/api/health/live`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
    });
    const body = await response.json() as { service?: string; live?: boolean };
    const ok = response.ok && body.service === "marketline" && body.live === true;
    return {
      id: "public_origin",
      ok,
      message: ok ? "Public tunnel reaches this Marketline server." : "PUBLIC_BASE_URL does not reach this Marketline server.",
    };
  } catch {
    return { id: "public_origin", ok: false, message: "PUBLIC_BASE_URL is unreachable." };
  }
}

async function checkTwilioConfiguration(
  config: ReturnType<typeof loadTelephonyConfig>,
): Promise<VoiceReadinessCheck> {
  try {
    const client = config.apiKeySid && config.apiKeySecret
      ? twilio(config.apiKeySid, config.apiKeySecret, { accountSid: config.accountSid })
      : twilio(config.accountSid, config.authToken!);
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: config.phoneNumber, limit: 1 });
    const number = numbers[0];
    const expectedVoiceUrl = `${config.publicBaseUrl}/api/twilio/voice/inbound`;
    const expectedStatusUrl = `${config.publicBaseUrl}/api/twilio/status`;
    const ok = number?.voiceUrl === expectedVoiceUrl && number.statusCallback === expectedStatusUrl;
    return {
      id: "twilio_webhooks",
      ok,
      message: ok
        ? "Twilio voice and status webhooks match the public origin."
        : "Twilio voice/status webhooks do not match PUBLIC_BASE_URL. Run npm run twilio:configure.",
    };
  } catch (error) {
    return { id: "twilio_webhooks", ok: false, message: `Twilio readiness check failed: ${errorMessage(error)}` };
  }
}

async function checkOpenAiModel(apiKey: string, model: string): Promise<VoiceReadinessCheck> {
  try {
    await new OpenAI({ apiKey }).models.retrieve(model);
    return { id: "openai_model", ok: true, message: `OpenAI model ${model} is accessible.` };
  } catch (error) {
    return { id: "openai_model", ok: false, message: `OpenAI model check failed: ${errorMessage(error)}` };
  }
}

function result(checks: VoiceReadinessCheck[]): VoiceReadinessResult {
  return {
    ready: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
