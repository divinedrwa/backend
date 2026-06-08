import { v2 as cloudinary } from "cloudinary";
import { ensureCloudinaryConfigured, isCloudinaryConfigured } from "./cloudinaryConfig";

// Re-export for any callers that import from here
export { isCloudinaryConfigured };

type ParsedCloudinaryUrl = {
  publicId: string;
  resourceType: "image" | "raw";
  deliveryType: "upload" | "authenticated";
};

/**
 * Extract Cloudinary public_id from a delivery URL (public or signed authenticated).
 */
export function parseCloudinaryDeliveryUrl(url: string): ParsedCloudinaryUrl | null {
  try {
    const path = new URL(url).pathname;
    const match = path.match(
      /\/(image|raw)\/(upload|authenticated)(?:\/s--[^/]+--)?\/v\d+\/(.+)$/,
    );
    if (!match?.[1] || !match[2] || !match[3]) return null;
    return {
      resourceType: match[1] as "image" | "raw",
      deliveryType: match[2] as "upload" | "authenticated",
      publicId: decodeURIComponent(match[3]),
    };
  } catch {
    return null;
  }
}

/**
 * Return a working delivery URL for an expense attachment.
 * Legacy rows store signed `authenticated` URLs that expire; regenerate on read.
 * Public `upload` URLs are returned unchanged.
 */
export function resolveExpenseAttachmentUrl(fileUrl: string): string {
  if (!fileUrl?.trim()) return fileUrl;
  if (!isCloudinaryConfigured()) return fileUrl;

  const parsed = parseCloudinaryDeliveryUrl(fileUrl);
  if (!parsed) return fileUrl;
  if (parsed.deliveryType === "upload") return fileUrl;

  ensureCloudinaryConfigured();
  return cloudinary.url(parsed.publicId, {
    secure: true,
    resource_type: parsed.resourceType,
    sign_url: true,
    type: "authenticated",
  });
}

/**
 * Upload an expense attachment to Cloudinary.
 *
 * Images use `resource_type: "image"` (Cloudinary default, supports
 * transforms / thumbnails).
 *
 * Non-image files (PDFs, spreadsheets, docs, etc.) use `resource_type: "raw"`
 * so Cloudinary returns a direct-download URL. Using "auto" or "image" for
 * PDFs produces `/image/upload/…` URLs that Cloudinary may refuse to serve
 * as downloadable files.
 *
 * Delivered as **public** URLs (`secure_url`) — same as profile/UPI uploads.
 * Signed authenticated URLs expire and break when stored in the database.
 */
export async function uploadExpenseAttachmentBuffer(
  buffer: Buffer,
  societyId: string,
  publicIdSuffix: string,
  mimetype?: string,
): Promise<{ secureUrl: string; bytes: number; format: string }> {
  ensureCloudinaryConfigured();
  if (!isCloudinaryConfigured()) {
    throw new Error("CLOUDINARY_NOT_CONFIGURED");
  }

  const safeSociety = societyId.replace(/[^a-zA-Z0-9_-]/g, "_");

  const isImage = mimetype?.startsWith("image/") ?? false;
  const resourceType: "image" | "raw" = isImage ? "image" : "raw";

  const dotIdx = publicIdSuffix.lastIndexOf(".");
  const ext = dotIdx > 0 ? publicIdSuffix.slice(dotIdx).toLowerCase() : "";
  const baseName = (dotIdx > 0 ? publicIdSuffix.slice(0, dotIdx) : publicIdSuffix)
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
  const safeId = resourceType === "raw" && ext ? `${baseName}${ext}` : baseName;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `divine-app/expenses/${safeSociety}`,
        public_id: safeId,
        resource_type: resourceType,
        overwrite: false,
      },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        if (result?.secure_url) {
          resolve({
            secureUrl: result.secure_url,
            bytes: result.bytes,
            format: result.format,
          });
          return;
        }
        reject(new Error("Cloudinary returned no URL"));
      },
    );
    stream.end(buffer);
  });
}
