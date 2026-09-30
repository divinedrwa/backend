import type { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { startOfLocalDayDaysAgo } from "../../../lib/societyTime";

export type Db = typeof prisma | Prisma.TransactionClient;

export type Tone = "good" | "watch" | "critical" | "neutral";

export type Change = { label: string; direction: "up" | "down" | "flat"; good: boolean } | null;

/** "Last N days including today" and the N days before it. */
export type Period = { days: number; from: Date; prevFrom: Date; now: Date };

export const DAY_MS = 24 * 60 * 60 * 1000;

export function periodFor(days: number, now = new Date()): Period {
  const from = startOfLocalDayDaysAgo(days - 1);
  return { days, from, prevFrom: new Date(from.getTime() - days * DAY_MS), now };
}

export const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function toneFor(value: number, good: number, watch: number): Tone {
  if (value >= good) return "good";
  if (value >= watch) return "watch";
  return "critical";
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** "1 h 9 min", "45 min", "2 days". */
export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  if (m >= 48 * 60) return plural(Math.round(m / (24 * 60)), "day");
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  return `${m} min`;
}

/** Indian grouping, no paise: ₹1,25,000. */
export function formatRupees(amount: number): string {
  const sign = amount < 0 ? "−" : "";
  return `${sign}₹${Math.round(Math.abs(amount)).toLocaleString("en-IN")}`;
}

/** Count change vs the previous period, as a short label. */
export function countChange(current: number, previous: number, higherIsGood = true): Change {
  if (current === previous) {
    return current === 0 ? null : { label: "Same as before", direction: "flat", good: true };
  }
  const direction = current > previous ? "up" : "down";
  const good = higherIsGood ? direction === "up" : direction === "down";
  if (previous === 0) return { label: "New this period", direction, good };
  const change = Math.round((Math.abs(current - previous) / previous) * 100);
  return { label: `${direction === "up" ? "+" : "−"}${change}% vs before`, direction, good };
}

/** "9 AM", "12 PM". */
export function hourLabel(hour: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${suffix}`;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Flat label as residents know it: "A-25" or "25". */
export function flatLabel(v: { villaNumber: string; block?: string | null } | null | undefined): string {
  if (!v) return "—";
  const b = v.block?.trim();
  return b ? `${b}-${v.villaNumber}` : v.villaNumber;
}

/** "2026-09-30" → "30/9". */
export function shortDay(key: string): string {
  const [, m, d] = key.split("-");
  return `${Number(d)}/${Number(m)}`;
}

/** Contact row for an outreach list. */
export type Contact = { name: string; flat: string; phone: string | null; detail?: string };
