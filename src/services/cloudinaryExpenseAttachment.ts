import { v2 as cloudinary } from "cloudinary";
import { ensureCloudinaryConfigured, isCloudinaryConfigured } from "./cloudinaryConfig";

// Re-export for any callers that import from here
export { isCloudinaryConfigured };

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
  ensureCloudinaryConfigured();
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
        access_mode: "authenticated",
        overwrite: false,
      },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        if (result?.secure_url) {
          // For authenticated assets, generate a signed URL so clients can access the resource.
          const signedUrl = cloudinary.url(result.public_id, {
            secure: true,
            resource_type: resourceType,
            sign_url: true,
            type: "authenticated",
          });
          resolve({
            secureUrl: signedUrl,
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
