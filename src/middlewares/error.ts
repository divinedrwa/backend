import { Prisma } from "@prisma/client";
import { NextFunction, Request, Response } from "express";
import multer from "multer";
import { ZodError } from "zod";

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
      res.status(400).json({ message: "Image must be 5 MB or smaller" });
      return;
    }
    res.status(400).json({ message: err.message });
    return;
  }

  if (err instanceof Error && err.message === "INVALID_IMAGE_TYPE") {
    res.status(400).json({ message: "Please upload a JPEG, PNG, GIF, or WebP image" });
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
  }

  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ message: "Internal server error" });
}
