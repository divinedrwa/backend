/**
 * A push notification must always carry text the resident can read.
 *
 * When a push reaches the phone with no title and no body, the mobile app shows its own placeholder: a notification
 * headed "Notification" with the body "Notification". That is what a "blank" or "dummy" notification is. The text can be
 * empty without anyone intending it: an empty string, only spaces, a non-breaking space, a zero-width character (invisible
 * but not removed by trim()), or a value that was undefined and became "".
 *
 * Every push is therefore normalised here, in one place, before it is sent or stored in the in-app inbox.
 */
import { APP_NAME } from "./branding";

/** Zero-width and no-break characters, the byte-order mark, and control characters: invisible, and trim() keeps them. */
// Code point ranges (numbers, so the source holds no invisible characters): control characters, no-break space, soft hyphen,
// zero-width and direction marks, line and paragraph separators, invisible operators, and the byte-order mark.
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f], [0x007f, 0x007f], [0x00a0, 0x00a0], [0x00ad, 0x00ad],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff],
];
const hex = (n: number) => `\\u${n.toString(16).padStart(4, "0")}`;
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join("")}]`, "g");

/** The visible text of a value ("" when there is none). */
export function cleanPushText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
}

export interface PushText {
  title: string;
  body: string;
}

/**
 * The text to send, or null when there is nothing to say (the push is then not sent at all; a message with no words is
 * worse than none).
 *   - title and body both present: used as given (cleaned);
 *   - title only: the body repeats the title (the app does the same for a missing body);
 *   - body only: the title is the app name;
 *   - neither: null.
 */
export function preparePushText(input: { title?: unknown; body?: unknown }): PushText | null {
  const title = cleanPushText(input.title);
  const body = cleanPushText(input.body);
  if (!title && !body) return null;
  return { title: title || APP_NAME, body: body || title };
}

/** Where a dropped push came from, for the log: the first caller frames outside this file and the notification service. */
export function callerHint(): string {
  const lines = (new Error().stack || "").split("\n").slice(2);
  return lines
    .filter((l) => !/pushText|notification\.service/.test(l))
    .slice(0, 3)
    .map((l) => l.trim().replace(/^at\s+/, ""))
    .join(" <- ");
}
