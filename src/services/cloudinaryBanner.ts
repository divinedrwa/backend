import { v2 as cloudinary } from "cloudinary";
import { isCloudinaryConfigured } from "./cloudinaryProfile";

/** Upload a society banner/campaign image; returns Cloudinary `secure_url`. */
export async function uploadBannerImageBuffer(
  buffer: Buffer,
  societyId: string,
): Promise<string> {
  if (!isCloudinaryConfigured()) {
    throw new Error("CLOUDINARY_NOT_CONFIGURED");
  }

  const safeId = societyId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  const publicId = `banner-${Date.now()}`;

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `divine-app/banners/${safeId}`,
        public_id: publicId,
        resource_type: "image",
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
      },
    );
    stream.end(buffer);
  });
}
