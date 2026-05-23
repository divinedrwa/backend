import { z } from "zod";

/**
 * Shared password schema for registration and password-change endpoints.
 *
 * Rules: 8+ chars, at least one uppercase, one lowercase, one digit.
 * NOT applied to login schemas — existing users with weaker passwords
 * must still be able to authenticate.
 */
export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[0-9]/, "Password must contain at least one number");
