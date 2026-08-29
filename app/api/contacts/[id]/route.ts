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

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const input = contactSchema.parse(await request.json());
    const contact = getRepository().updateContact(id, {
      label: input.label,
      phoneInput: input.phoneNumber,
      e164PhoneNumber: normalizePhoneNumber(input.phoneNumber),
      note: input.note,
    });
    if (!contact) return Response.json({ error: "Contact not found." }, { status: 404 });
    return Response.json({ contact });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    if (!getRepository().deleteContact(id)) return Response.json({ error: "Contact not found." }, { status: 404 });
    return new Response(null, { status: 204 });
  } catch (error) {
    return apiError(error);
  }
}
