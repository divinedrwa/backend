/**
 * Re-export Sentry from the instrument module.
 * Actual initialization lives in src/instrument.ts (imported first in server.ts).
 */
export { Sentry } from "../instrument";
