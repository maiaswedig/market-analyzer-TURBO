import type { WatchAsset } from "./types.ts";

export interface CalendarEvent {
  at: number;
  currency: "USD" | "EUR" | "GBP";
  title: string;
  source: string;
  eventKey: string;
  impact: "high";
  category: EconomicEventCategory;
  categoryVersion: 1;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
}

export type EconomicEventCategory =
  | "rate_decision"
  | "inflation"
  | "employment"
  | "growth"
  | "central_bank"
  | "other_high_impact";

export interface CalendarSnapshot {
  fetchedAt: number;
  events: CalendarEvent[] | null;
  error: string | null;
}

function currency(value: unknown): CalendarEvent["currency"] | null {
  const normalized = String(value || "").trim().toUpperCase();
  if (["USD", "EUR", "GBP"].includes(normalized)) return normalized as CalendarEvent["currency"];
  return null;
}

function timestamp(value: unknown): number | null {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized.slice(0, 160) : null;
}

function normalizedTitle(value: unknown): string {
  return String(value || "Evento econômico").trim().replace(/\s+/g, " ").slice(0, 240);
}

export function classifyEconomicEvent(title: string): EconomicEventCategory {
  const normalized = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/interest rate|funds rate|rate decision|cash rate|bank rate|refinancing rate|taxa de juros|decisao de juros/.test(normalized)) {
    return "rate_decision";
  }
  if (/\bcpi\b|\bppi\b|inflation|inflacao|consumer price|producer price|pce price/.test(normalized)) {
    return "inflation";
  }
  if (/non[- ]?farm|\bnfp\b|unemployment|employment|payroll|jobless|emprego|desemprego/.test(normalized)) {
    return "employment";
  }
  if (/\bgdp\b|gross domestic|\bpmi\b|retail sales|industrial production|pib|vendas no varejo|producao industrial/.test(normalized)) {
    return "growth";
  }
  if (/fomc|central bank|fed chair|ecb|boe|powell|lagarde|governor speaks|banco central/.test(normalized)) {
    return "central_bank";
  }
  return "other_high_impact";
}

function eventKey(source: string, currencyCode: CalendarEvent["currency"], at: number, title: string): string {
  return `${source}|${currencyCode}|${new Date(at).toISOString()}|${title.toLowerCase()}`;
}

export async function fetchCalendarSnapshot(now = Date.now()): Promise<CalendarSnapshot> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "SignalAtlasResearch/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    const events: CalendarEvent[] = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      const impact = String(row.impact || row.Impact || "").toLowerCase();
      if (!/high|red|alto/.test(impact)) continue;
      const code = currency(row.country || row.currency);
      const at = timestamp(row.date || row.Date);
      if (code && at !== null) {
        const source = "Forex Factory";
        const title = normalizedTitle(row.title || row.event);
        events.push({
          at,
          currency: code,
          title,
          source,
          eventKey: eventKey(source, code, at, title),
          impact: "high",
          category: classifyEconomicEvent(title),
          categoryVersion: 1,
          forecast: optionalText(row.forecast || row.Forecast),
          previous: optionalText(row.previous || row.Previous),
          actual: optionalText(row.actual || row.Actual),
        });
      }
    }
    return { fetchedAt: now, events, error: null };
  } catch (error) {
    return { fetchedAt: now, events: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function exposedCurrencies(asset: WatchAsset): CalendarEvent["currency"][] {
  const symbol = asset.providerSymbol.toUpperCase();
  return (["USD", "EUR", "GBP"] as const).filter((code) => symbol.includes(code));
}

function minutesInZone(timeMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timeMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value || 0);
  return hour * 60 + minute;
}

function circularDistance(a: number, b: number): number {
  const distance = Math.abs(a - b);
  return Math.min(distance, 24 * 60 - distance);
}

export function externalMarketBlockers(asset: WatchAsset, entryAt: number, resolveAfter: number, calendar: CalendarSnapshot | null): string[] {
  if (asset.source !== "yahoo") return [];
  const blockers: string[] = [];
  if (!calendar?.events) blockers.push(`calendário econômico indisponível: ${calendar?.error || "sem snapshot"}`);
  else {
    const currencies = exposedCurrencies(asset);
    const before = 5 * 60_000;
    const after = 5 * 60_000;
    const matching = calendar.events.filter((event) => currencies.includes(event.currency) && event.at + after >= entryAt && event.at - before <= resolveAfter);
    if (matching.length) blockers.push(`notícia de alto impacto: ${matching.map((event) => `${event.currency} ${event.title}`).join(" · ")}`);
  }
  const checkpoints = [entryAt, resolveAfter];
  for (const point of checkpoints) {
    if (circularDistance(minutesInZone(point, "America/New_York"), 17 * 60) <= 10) blockers.push("transição de liquidez no fechamento de Nova York");
    if (circularDistance(minutesInZone(point, "Asia/Tokyo"), 9 * 60) <= 10) blockers.push("transição de liquidez na abertura de Tóquio");
  }
  return [...new Set(blockers)];
}
