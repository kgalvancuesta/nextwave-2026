import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTelephonyConfig, loadVoltaConfig } from "@/lib/config";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

function setBaseEnvironment() {
  process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`;
  process.env.TWILIO_PHONE_NUMBER = "+12025550131";
  process.env.PUBLIC_BASE_URL = "https://marketline.example.test";
  delete process.env.TWILIO_CREDENTIALS_FILE;
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_API_KEY_SID;
  delete process.env.TWILIO_API_KEY_SECRET;
}

describe("loadTelephonyConfig", () => {
  it("accepts an API key pair for REST calls when signature validation is disabled", () => {
    setBaseEnvironment();
    process.env.TWILIO_API_KEY_SID = `SK${"b".repeat(32)}`;
    process.env.TWILIO_API_KEY_SECRET = "api-secret";
    process.env.TWILIO_VALIDATE_SIGNATURES = "false";

    const config = loadTelephonyConfig();

    expect(config.apiKeySid).toBe(process.env.TWILIO_API_KEY_SID);
    expect(config.apiKeySecret).toBe("api-secret");
    expect(config.authToken).toBeNull();
  });

  it("requires an auth token when webhook signature validation is enabled", () => {
    setBaseEnvironment();
    process.env.TWILIO_API_KEY_SID = `SK${"b".repeat(32)}`;
    process.env.TWILIO_API_KEY_SECRET = "api-secret";
    process.env.TWILIO_VALIDATE_SIGNATURES = "true";

    expect(() => loadTelephonyConfig()).toThrow(/signature validation requires TWILIO_AUTH_TOKEN/);
  });

  it("supports auth-token authentication with signature validation", () => {
    setBaseEnvironment();
    process.env.TWILIO_AUTH_TOKEN = "auth-token";
    process.env.TWILIO_VALIDATE_SIGNATURES = "true";

    const config = loadTelephonyConfig();

    expect(config.authToken).toBe("auth-token");
    expect(config.validateSignatures).toBe(true);
  });
});

describe("loadVoltaConfig", () => {
  it("defaults new deployments to the noise-resilient Realtime model", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_WEBHOOK_SECRET = "whsec_test";
    process.env.OPENAI_SIP_URI = "sip:test@sip.api.openai.com";
    delete process.env.OPENAI_CREDENTIALS_FILE;
    delete process.env.OPENAI_REALTIME_MODEL;
    delete process.env.OPENAI_TRANSCRIPTION_MODEL;
    expect(loadVoltaConfig().realtimeModel).toBe("gpt-realtime-2.1");
    expect(loadVoltaConfig().transcriptionModel).toBe("gpt-transcribe");
  });

  it("loads an API key and derives the SIP URI from an ignored credential file", () => {
    const directory = mkdtempSync(join(tmpdir(), "marketline-openai-"));
    const path = join(directory, "openai-api.md");
    writeFileSync(path, "sk-test-secret\n\nproj_test\n\nwhsec_+test/value=\n");
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_PROJECT_ID;
    delete process.env.OPENAI_SIP_URI;
    process.env.OPENAI_CREDENTIALS_FILE = path;
    delete process.env.OPENAI_WEBHOOK_SECRET;

    try {
      expect(loadVoltaConfig()).toMatchObject({
        openAiApiKey: "sk-test-secret",
        openAiWebhookSecret: "whsec_+test/value=",
        sipUri: "sip:proj_test@sip.api.openai.com;transport=tls",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
