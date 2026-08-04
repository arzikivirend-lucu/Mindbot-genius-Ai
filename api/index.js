// Vercel otomatis mendeteksi file di folder /api sebagai serverless function
// tanpa perlu konfigurasi "builds" di vercel.json. Ini penting karena
// "functions" (untuk maxDuration) tidak bisa dipakai bersamaan dengan "builds".
module.exports = require('../server.js');
