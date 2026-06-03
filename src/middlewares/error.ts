import { Prisma } from "@prisma/client";
import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";
import { logger } from "../lib/logger";

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      message: "Validation failed",
      issues: err.issues
    });
    return;
  }

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ message: "File exceeds the size limit" });
      return;
    }
    if (err.code === "LIMIT_FILE_COUNT") {
      res.status(400).json({ message: "Too many files. Maximum 5 per upload." });
      return;
    }
    res.status(400).json({ message: err.message });
    return;
  }

  if (err instanceof Error && err.message === "INVALID_IMAGE_TYPE") {
    res.status(400).json({ message: "Please upload a JPEG, PNG, GIF, or WebP image" });
    return;
  }

  if (err instanceof Error && err.message === "INVALID_ATTACHMENT_TYPE") {
    res.status(400).json({ message: "Please upload a JPEG, PNG, GIF, WebP, or PDF file" });
    return;
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2003") {
      res.status(400).json({
        message:
          "Invalid reference (e.g. flat or gate). Refresh lists in the app and try again.",
      });
      return;
    }
    if (err.code === "P2002") {
      res.status(409).json({ message: "This record already exists" });
      return;
    }
    if (err.code === "P2021" || err.code === "P2022") {
      const column =
        err.code === "P2022" && err.meta && typeof err.meta === "object" && "column" in err.meta
          ? String((err.meta as { column?: string }).column ?? "")
          : "";
      res.status(503).json({
        message: column
          ? `Database schema is out of date (missing ${column}). Run prisma migrate deploy on the API service, then restart.`
          : "Database schema is out of date. Run prisma migrate deploy on the API service, then restart.",
      });
      return;
    }
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    // Log the full detail server-side but don't expose schema info to clients.
    const msg = err.message.length > 800 ? `${err.message.slice(0, 800)}…` : err.message;
    logger.error({ detail: msg }, "Prisma validation error");
    res.status(400).json({
      message: "Invalid database query",
    });
    return;
  }

  // DB-level CHECK / exclusion / raw SQL errors surface as
  // PrismaClientUnknownRequestError — log detail and return 400.
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    logger.error({ detail: err.message }, "Prisma unknown request error (CHECK constraint or raw DB error)");
    res.status(400).json({
      message: "The operation was rejected by the database. Please check your input and try again.",
    });
    return;
  }

  // Pino redacts known-sensitive fields from `err` (token, password, etc.)
  // via the central logger config — see [src/lib/logger.ts].
  logger.error({ err }, "unhandled error");
  res.status(500).json({ message: "Internal server error" });
}
