// ============================================================================
// Cloudinary — subida de archivos a Cloudinary y devolución de URL
// ============================================================================
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/** Sube un buffer de archivo a Cloudinary y devuelve la URL segura. */
async function uploadBuffer(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        resource_type: 'auto',
        folder: options.folder || 'knowledge',
        secure: true,
        ...options,
      },
      (err, result) => {
        if (err) return reject(err);
        resolve({ url: result.secure_url, public_id: result.public_id, ...result });
      }
    );
    stream.end(buffer);
  });
}

/** Elimina un archivo de Cloudinary por su public_id. */
async function deleteFile(publicId) {
  return cloudinary.uploader.destroy(publicId);
}

module.exports = { uploadBuffer, deleteFile };
