import { describe, expect, it } from "vitest";
import { normalizePhoneNumber, PhoneNumberError } from "@/lib/phone";

describe("phone number normalization", () => {
  it("normalizes a Mexican national number using MX as the default", () => {
    expect(normalizePhoneNumber("5500000004")).toBe("+525500000004");
  });

  it("preserves a valid international E.164 number", () => {
    expect(normalizePhoneNumber("+12025550100")).toBe("+12025550100");
  });

  it("rejects an invalid number", () => {
    expect(() => normalizePhoneNumber("123")).toThrow(PhoneNumberError);
  });
});
