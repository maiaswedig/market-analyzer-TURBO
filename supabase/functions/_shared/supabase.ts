import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.0";

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

function firstSecret(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && typeof parsed[0] === "string") return parsed[0];
    if (parsed && typeof parsed === "object") {
      for (const key of ["default", "service_role", "primary", "key"]) {
        if (typeof parsed[key] === "string") return parsed[key];
      }
      const first = Object.values(parsed).find((value) => typeof value === "string");
      if (typeof first === "string") return first;
    }
  } catch {
    // Também aceitamos um segredo único ou uma lista separada por vírgula.
  }
  const value = raw.split(/[\n,]/).map((item) => item.trim()).find(Boolean);
  if (!value) throw new Error("SUPABASE_SECRET_KEYS não contém uma chave utilizável.");
  return value;
}

export function createAdminClient(): SupabaseClient {
  const url = requiredEnv("SUPABASE_URL");
  const key = firstSecret(requiredEnv("SUPABASE_SECRET_KEYS"));
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "x-client-info": "signal-atlas-edge/1.0" } },
  });
}

export type AdminClient = SupabaseClient;
