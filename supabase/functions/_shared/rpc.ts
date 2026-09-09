import type { AdminClient } from "./supabase.ts";

export async function requiredRpc<T = unknown>(client: AdminClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    const detail = name === "ingest_candles" && error.message.includes("future candle/source timestamp rejected")
      ? ` · ${String(error.details || "sem detalhe temporal").slice(0, 600)}` : "";
    throw new Error(`RPC ${name} indisponível ou recusou o contrato: ${error.message}${detail}`);
  }
  return data as T;
}

export function chunks<T>(items: T[], size = 200): T[][] {
  const width = Math.max(1, Math.floor(size));
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += width) output.push(items.slice(index, index + width));
  return output;
}
