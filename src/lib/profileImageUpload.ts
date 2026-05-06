import multer from "multer";

/** Memory upload for `PATCH /residents/me` — optional field `image`; backend uploads to Cloudinary. */
export const profileImageMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(jpeg|jpg|png|gif|webp)$/i.test(file.mimetype)) {
      cb(new Error("INVALID_IMAGE_TYPE"));
      return;
    }
    cb(null, true);
  },
});
