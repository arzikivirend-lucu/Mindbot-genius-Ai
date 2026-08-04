require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');

const app = express();

const sessions = {};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/gif','image/webp','text/plain','application/pdf'];
    cb(null, ok.includes(file.mimetype));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ... (semua route /api/conversations, /api/imagine, /api/chat tetap sama persis) ...

// JANGAN pakai app.listen() di Vercel — export app-nya saja
module.exports = app;