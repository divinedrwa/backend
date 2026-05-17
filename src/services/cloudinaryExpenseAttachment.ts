import { v2 as cloudinary } from "cloudinary";

let configured = false;

function ensureConfigured(): void {
  if (configured) return;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (cloudName && apiKey && apiSecret) {
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
    });
    configured = true;
  }
}

export function isCloudinaryConfigured(): boolean {
  ensureConfigured();
  return !!(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
  );
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
 */
export async function uploadExpenseAttachmentBuffer(
  buffer: Buffer,
  societyId: string,
  publicIdSuffix: string,
  mimetype?: string
): Promise<{ secureUrl: string; bytes: number; format: string }> {
  ensureConfigured();
  if (!isCloudinaryConfigured()) {
    throw new Error("CLOUDINARY_NOT_CONFIGURED");
  }

  const safeSociety = societyId.replace(/[^a-zA-Z0-9_-]/g, "_");

  // Pick the correct resource_type based on the file's mimetype.
  const isImage = mimetype?.startsWith("image/") ?? false;
  const resourceType: "image" | "raw" = isImage ? "image" : "raw";

  // For raw uploads Cloudinary needs the file extension in public_id so it
  // can serve the file with the correct Content-Type (e.g. application/pdf).
  // Preserve the extension (e.g. ".pdf") while sanitising the rest.
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
      }
    );
    stream.end(buffer);
  });
}
