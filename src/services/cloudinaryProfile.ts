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

/** Upload raw image bytes to Cloudinary; returns `secure_url` stored as `User.photoUrl`. */
export async function uploadProfileImageBuffer(
  buffer: Buffer,
  publicIdSuffix: string
): Promise<string> {
  ensureConfigured();
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
