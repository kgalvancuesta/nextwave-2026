import { z } from "zod";

const optionalUrl = z.string().url().optional().or(z.literal("").transform(() => undefined));
const optionalString = z.string().min(1).optional().or(z.literal("").transform(() => undefined));

const configSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_PATH: z.string().default("./nextwave.sqlite"),
  CONTROL_API_TOKEN: optionalString,
  OPENAI_API_KEY: optionalString,
  OPENAI_WEBHOOK_SECRET: optionalString,
  OPENAI_REALTIME_MODEL: z.string().default("gpt-realtime"),
  OPENAI_VOICE: z.string().default("marin"),
  OPENAI_SIP_URI: optionalString,
  TELEPHONY_OUTBOUND_URL: optionalUrl,
  TELEPHONY_OUTBOUND_TOKEN: optionalString,
  RECAP_DELIVERY_URL: optionalUrl,
  RECAP_DELIVERY_TOKEN: optionalString,
  HUMAN_ESCALATION_URI: optionalString,
}).superRefine((value, context) => {
  if (!["127.0.0.1", "localhost", "::1"].includes(value.HOST) && !value.CONTROL_API_TOKEN) {
    context.addIssue({
      code: "custom",
      path: ["CONTROL_API_TOKEN"],
      message: "CONTROL_API_TOKEN is required when binding beyond loopback",
    });
  }
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return configSchema.parse(environment);
}
