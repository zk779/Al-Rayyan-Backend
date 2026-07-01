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
// `params` is a function so we can branch on file type: images get the
// resize transform, PDFs go up as `raw` (transforms don't apply to raw files
// and will error if you try).
const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => {
    const isPdf = file.mimetype === "application/pdf";
    return {
      folder: "travel_agency_uploads",
      allowed_formats: ALLOWED_FORMATS,
      resource_type: isPdf ? "raw" : "image",
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