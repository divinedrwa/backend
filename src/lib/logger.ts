import pino from "pino";

/**
 * Process-wide structured logger.
 *
 * - `level` is configurable via `LOG_LEVEL` (default `info`); set to `debug`
 *   locally for verbose output.
 * - `redact` strips known-sensitive fields wherever they appear in the
 *   serialized object tree. Add new sources of secrets here, not at call
 *   sites — leaving redaction to the caller is how leaks happen.
 *
 * Use `logger.error({ err }, "message")` (object first, message second) so
 * pino's serializers can stringify [Error] objects with their stack.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.authorization",
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.fcmToken",
      "*.tokenPreview",
      "*.deviceIdPreview",
      "*.access_token",
      "*.refresh_token",
    ],
    censor: "[REDACTED]",
  },
});
