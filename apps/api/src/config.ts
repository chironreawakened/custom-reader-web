import { z } from "zod";
import { validateMasterKey } from "@reader/shared";

const schema = z.object({
  APP_MASTER_KEY: z.string().min(32),
  HIPPUS_ENDPOINT: z.string().url(),
  HIPPUS_REGION: z.string().default("decentralized"),
  HIPPUS_BUCKET: z.string().min(1),
  HIPPUS_ACCESS_KEY: z.string().min(1),
  HIPPUS_SECRET_KEY: z.string().min(1),
  POSTGRES_URL: z.string().startsWith("postgres://"),
  ALLOWED_EMAIL: z.string().min(1),
  RDR_HOSTNAME: z.string().min(3),
  RDR_ENV: z.enum(["prod", "ci"]).optional(),
  // Mailer (SPECS §4): "smtp" in prod, "console" in CI/e2e.
  MAILER: z.enum(["smtp", "console"]).default("smtp"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
});

export interface AppConfig {
  masterKey: Uint8Array;
  hippus: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
  };
  dbUrl: string;
  allowedEmail: string;
  publicOrigin: string;
  env: "prod" | "ci";
  mailer: "smtp" | "console";
  smtp?: {
    host: string;
    port: number;
    user: string;
    pass: string;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = schema.parse(env);
  const masterKey = validateMasterKey(e.APP_MASTER_KEY);

  // SMTP creds are only required when the smtp mailer is selected.
  if (e.MAILER === "smtp") {
    if (!e.SMTP_HOST || e.SMTP_PORT === undefined || !e.SMTP_USER || !e.SMTP_PASS) {
      throw new Error("MAILER=smtp requires SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS");
    }
  }

  return {
    masterKey,
    hippus: {
      endpoint: e.HIPPUS_ENDPOINT,
      region: e.HIPPUS_REGION,
      bucket: e.HIPPUS_BUCKET,
      accessKey: e.HIPPUS_ACCESS_KEY,
      secretKey: e.HIPPUS_SECRET_KEY,
    },
    dbUrl: e.POSTGRES_URL,
    allowedEmail: e.ALLOWED_EMAIL.toLowerCase(),
    publicOrigin: e.RDR_HOSTNAME,
    env: e.RDR_ENV ?? "prod",
    mailer: e.MAILER,
    ...(e.MAILER === "smtp" && {
      smtp: {
        host: e.SMTP_HOST!,
        port: e.SMTP_PORT!,
        user: e.SMTP_USER!,
        pass: e.SMTP_PASS!,
      },
    }),
  };
}
