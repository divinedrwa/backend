import { v2 as cloudinary } from "cloudinary";
import { ensureCloudinaryConfigured, isCloudinaryConfigured } from "./cloudinaryConfig";

// Re-export for backward compatibility (cloudinaryUpiQr.ts imports from here)
export { isCloudinaryConfigured };

/** Upload raw image bytes to Cloudinary; returns `secure_url` stored as `User.photoUrl`. */
export async function uploadProfileImageBuffer(
  buffer: Buffer,
  publicIdSuffix: string
): Promise<string> {
  ensureCloudinaryConfigured();
  if (!isCloudinaryConfigured()) {
    throw new Error("CLOUDINARY_NOT_CONFIGURED");
  }

  const safeId = publicIdSuffix.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: "divine-app/profiles",
        public_id: safeId,
        resource_type: "image",
        overwrite: true,
      },
      (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        if (result?.secure_url) {
          resolve(result.secure_url);
          return;
        }
        reject(new Error("Cloudinary returned no URL"));
      }
    );
    stream.end(buffer);
  });
}
