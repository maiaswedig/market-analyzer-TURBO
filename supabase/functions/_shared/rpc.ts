import type { AdminClient } from "./supabase.ts";

export async function requiredRpc<T = unknown>(client: AdminClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    throw new Error(`RPC ${name} indisponível ou recusou o contrato: ${error.message}`);
  }
  return data as T;
}

export function chunks<T>(items: T[], size = 200): T[][] {
  const width = Math.max(1, Math.floor(size));
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += width) output.push(items.slice(index, index + width));
  return output;
}
