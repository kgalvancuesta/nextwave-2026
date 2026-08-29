import { afterEach, describe, expect, it } from "vitest";
import { loadTelephonyConfig } from "@/lib/config";

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
