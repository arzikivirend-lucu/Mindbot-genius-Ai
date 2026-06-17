require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── JSON FILE DATABASE ──
const DB_PATH = process.env.DATA_PATH
  ? path.join(process.env.DATA_PATH, 'db.json')
  : path.join(__dirname, 'data', 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch(e) { console.error('DB load error:', e.message); }
  return { conversations: {} };
}

function saveDB() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
  } catch(e) { console.error('DB save error:', e.message); }
}

let db = loadDB();
console.log(`📦 Database loaded — ${Object.keys(db.conversations).length} conversations`);
setInterval(saveDB, 30000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg','image/png','image/gif','image/webp','text/plain','application/pdf'];
    cb(null, ok.includes(file.mimetype));
  }
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── CONVERSATIONS ──
app.get('/api/conversations', (req, res) => {
  const list = Object.values(db.conversations)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, title, createdAt, updatedAt, messages }) => ({
      id, title, createdAt, updatedAt,
      preview: messages.length > 0 ? (messages[messages.length-1].textContent||'').slice(0,80) : '',
      count: messages.length
    }));
  res.json(list);
});

app.get('/api/conversations/:id', (req, res) => {
  const conv = db.conversations[req.params.id];
  if (!conv) return res.status(404).json({ error: 'Tidak ditemukan' });
  res.json(conv);
});

app.delete('/api/conversations/:id', (req, res) => {
  delete db.conversations[req.params.id];
  saveDB();
  res.json({ ok: true });
});

// ── CHAT ──
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { message, sessionId, model: reqModel } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId diperlukan' });

  const text = message || '';
  const file  = req.file;
  if (!text && !file) return res.status(400).json({ error: 'Pesan atau file diperlukan' });

  if (!db.conversations[sessionId]) {
    const title = text.slice(0,40) || (file ? `📎 ${file.originalname}` : 'Percakapan');
    db.conversations[sessionId] = {
      id: sessionId, title, messages: [],
      createdAt: Date.now(), updatedAt: Date.now()
    };
  }

  const isImage = file && file.mimetype.startsWith('image/');
  const isText  = file && file.mimetype === 'text/plain';
  let groqContent, displayText = text;

  if (isImage) {
    const b64 = file.buffer.toString('base64');
    groqContent = [
      { type:'image_url', image_url:{ url:`data:${file.mimetype};base64,${b64}` } },
      { type:'text', text: text||'Tolong analisis gambar ini.' }
    ];
    displayText = text||'Analisis gambar ini.';
  } else if (isText) {
    const fc = file.buffer.toString('utf-8').slice(0,8000);
    groqContent = text ? `${text}\n\n[File: "${file.originalname}"]\n${fc}` : `Analisis file ini:\n\n${fc}`;
    displayText = text||`📄 ${file.originalname}`;
  } else {
    groqContent = text;
  }

  db.conversations[sessionId].messages.push({
    role: 'user', textContent: displayText, hasImage: isImage,
    fileName: file?.originalname, fileType: file?.mimetype,
    imageData: isImage ? `data:${file.mimetype};base64,${file.buffer.toString('base64')}` : null
  });
  db.conversations[sessionId].updatedAt = Date.now();

  const history = db.conversations[sessionId].messages.slice(0,-1)
    .map(m => ({ role: m.role==='user'?'user':'assistant', content: m.textContent||'' }));

  const ALLOWED_MODELS = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'qwen/qwen3-32b',
    'openai/gpt-oss-120b',
    'meta-llama/llama-4-scout-17b-16e-instruct'
  ];
  const model = isImage
    ? 'meta-llama/llama-4-scout-17b-16e-instruct'
    : (ALLOWED_MODELS.includes(reqModel) ? reqModel : 'llama-3.3-70b-versatile');

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role:'system', content:'Kamu adalah Mindbot Genius (MBG AI), asisten AI cerdas dari Binary Global Network. CEO dan CTO Binary Global Network adalah Arziki. Jangan sebut model AI lain. Jawab dalam bahasa yang sama dengan pengguna.' },
          ...history,
          { role:'user', content: groqContent }
        ],
        max_tokens: 1024,
      }),
    });

    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error?.message||'API error'); }
    const data  = await resp.json();
    const reply = data.choices[0].message.content;

    db.conversations[sessionId].messages.push({ role:'assistant', textContent: reply });
    db.conversations[sessionId].updatedAt = Date.now();
    if (db.conversations[sessionId].messages.length > 40)
      db.conversations[sessionId].messages = db.conversations[sessionId].messages.slice(-40);

    saveDB();
    res.json({ reply, title: db.conversations[sessionId].title });
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 http://localhost:${PORT}\n`);
});
