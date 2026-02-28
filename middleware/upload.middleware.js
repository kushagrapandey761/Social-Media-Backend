const multer = require("multer");
const cloudinary = require("../config/cloudinary");

// Memory storage
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ];

    if (!allowedTypes.includes(file.mimetype)) {
      return cb(new Error("Unsupported file type"), false);
    }

    cb(null, true);
  },
});

const uploadMedia = (fieldName, maxCount = 5, folderName = "posts") => [
  upload.array(fieldName, maxCount),

  async (req, res, next) => {
    try {
      if (!req.files || req.files.length === 0) {
        req.body.media = [];
        return next();
      }

      const uploadPromises = req.files.map((file) => {
        return new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            {
              folder: folderName,
              resource_type: "auto", // auto-detect image or video
            },
            (error, result) => {
              if (error) reject(error);
              else
                resolve({
                  url: result.secure_url,
                  type: result.resource_type,
                  publicId: result.public_id,
                });
            },
          );

          stream.end(file.buffer);
        });
      });

      const uploadedMedia = await Promise.all(uploadPromises);

      req.body.media = uploadedMedia;

      next();
    } catch (err) {
      res.status(500).json({ error: err });
    }
  },
];

module.exports = uploadMedia;
