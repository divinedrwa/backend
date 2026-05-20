import multer from "multer";

/** Memory upload for UPI QR code image — single field `qrImage`, 5 MB, PNG/JPEG/WEBP only. */
export const upiQrImageMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.mimetype)) {
      cb(new Error("INVALID_IMAGE_TYPE"));
      return;
    }
    cb(null, true);
  },
});
