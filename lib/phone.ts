import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

export class PhoneNumberError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneNumberError";
  }
}

export function normalizePhoneNumber(input: string, defaultCountry: CountryCode = "MX"): string {
  const value = input.trim();
  if (!value) throw new PhoneNumberError("Enter a phone number.");

  const parsed = parsePhoneNumberFromString(value, defaultCountry);
  if (!parsed || !parsed.isValid()) {
    throw new PhoneNumberError("Enter a valid phone number, including an international prefix when outside Mexico.");
  }
  return parsed.number;
}
