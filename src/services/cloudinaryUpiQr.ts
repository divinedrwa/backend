import { v2 as cloudinary } from "cloudinary";
import { isCloudinaryConfigured } from "./cloudinaryProfile";

/** Upload a UPI QR code image to Cloudinary; returns `secure_url`. */
export async function uploadUpiQrImageBuffer(
  buffer: Buffer,
  societyId: string,
): Promise<string> {
  if (!isCloudinaryConfigured()) {
    throw new Error("CLOUDINARY_NOT_CONFIGURED");
  }

  const safeId = societyId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: `divine-app/upi-qr/${safeId}`,
        public_id: "qr",
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
      },
    );
    stream.end(buffer);
  });
}
