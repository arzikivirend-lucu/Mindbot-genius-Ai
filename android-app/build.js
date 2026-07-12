const fs = require('fs');
const path = require('path');

// Ensure www directory exists with required files
const wwwDir = path.join(__dirname, 'www');
if (!fs.existsSync(wwwDir)) fs.mkdirSync(wwwDir, { recursive: true });

console.log('✅ Build complete - using Vercel URL as server');
