import { z } from "zod";
import { apiError } from "@/lib/http";
import { normalizePhoneNumber } from "@/lib/phone";
import { getRepository } from "@/lib/repository";

export const runtime = "nodejs";

const contactSchema = z.object({
  label: z.string().trim().min(1, "Enter a name or label.").max(100),
  phoneNumber: z.string().trim().min(1, "Enter a phone number."),
  note: z.string().trim().max(500).optional().nullable(),
});

export async function GET() {
  try {
    return Response.json({ contacts: getRepository().listContacts() });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = contactSchema.parse(await request.json());
    const contact = getRepository().createContact({
      label: input.label,
      phoneInput: input.phoneNumber,
      e164PhoneNumber: normalizePhoneNumber(input.phoneNumber),
      note: input.note,
    });
    return Response.json({ contact }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
