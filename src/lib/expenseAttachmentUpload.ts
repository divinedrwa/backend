import multer from "multer";

/** Memory upload for expense attachments — up to 5 files, 10 MB each, images + PDF. */
export const expenseAttachmentMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (
      !/^(image\/(jpeg|jpg|png|gif|webp)|application\/pdf)$/i.test(
        file.mimetype
      )
    ) {
      cb(new Error("INVALID_ATTACHMENT_TYPE"));
      return;
    }
    cb(null, true);
  },
});
