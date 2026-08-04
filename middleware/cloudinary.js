import { v2 as cloudinary } from "cloudinary";
import multer from "multer";
import { CloudinaryStorage } from "multer-storage-cloudinary";

// Configure Cloudinary with environment variables
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp", "pdf"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB — matches the "max 10MB" copy in the UI

// Cloudinary storage engine for Multer.
// `params` is a function so we can branch on file type. PDFs are uploaded as
// `image` resource_type (NOT `raw`) — Cloudinary blocks delivery of `raw`
// files (PDF/ZIP) by default for security reasons unless you explicitly flip
// a setting in the dashboard (Settings > Security > "Allow delivery of PDF
// and ZIP files"). Uploading as `image` avoids that entirely, and gives you
// page-preview / thumbnail generation as a bonus. The only downside is
// password-protected PDFs aren't supported as `image` — if you need those,
// see the raw-upload note at the bottom of this file.
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isPdf = file.mimetype === "application/pdf";
    return {
      folder: "travel_agency_uploads",
      allowed_formats: ALLOWED_FORMATS,
      resource_type: "image",
      // Only apply the resize/crop transform to actual images —
      // it doesn't make sense (and can behave oddly) on a PDF page render.
      transformation: isPdf
        ? undefined
        : [{ width: 800, height: 800, crop: "limit" }],
    };
  },
});

// Extra guard on top of allowed_formats — rejects bad extensions before
// Cloudinary is even touched, with a clean error message.
const fileFilter = (req, file, cb) => {
  const ext = file.originalname.split(".").pop()?.toLowerCase();
  if (!ext || !ALLOWED_FORMATS.includes(ext)) {
    return cb(
      new Error(
        `Unsupported file type${ext ? ` ".${ext}"` : ""}. Allowed: ${ALLOWED_FORMATS.join(", ")}`,
      ),
    );
  }
  cb(null, true);
};

export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE },
});

export { cloudinary };