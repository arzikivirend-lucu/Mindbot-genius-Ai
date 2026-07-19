require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

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
app.use(express.static(path.join(__dirname, 'public')));

// Dummy endpoints
app.get('/api/conversations', (req, res) => res.json([]));
app.get('/api/conversations/:id', (req, res) => res.status(404).json({ error: 'Tidak ditemukan' }));
app.delete('/api/conversations/:id', (req, res) => res.json({ ok: true }));

// ── WEB SEARCH KEYWORDS ──
const NEWS_KEYWORDS = [
  'berita','terkini','terbaru','hari ini','sekarang','minggu ini','bulan ini',
  'update','breaking','news','today','latest','current','recently','happened',
  'siapa presiden','siapa pemimpin','harga','nilai tukar','kurs','cuaca',
  'gempa','banjir','kebakaran','kecelakaan','meninggal','wafat','terpilih',
  'pertandingan','skor','hasil','juara','menang','kalah'
];

function needsWebSearch(text) {
  const lower = text.toLowerCase();
  return NEWS_KEYWORDS.some(kw => lower.includes(kw));
}

async function searchWeb(query) {
  try {
    const TAVILY_KEY = process.env.TAVILY_API_KEY;
    if (!TAVILY_KEY) return null;

    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_KEY,
        query: query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: true
      })
    });

    if (!resp.ok) return null;
    const data = await resp.json();

    // Format results
    let context = `[Hasil pencarian web untuk: "${query}"]\n\n`;
    if (data.answer) context += `Ringkasan: ${data.answer}\n\n`;
    if (data.results?.length) {
      context += 'Sumber:\n';
      data.results.slice(0,3).forEach((r, i) => {
        context += `${i+1}. ${r.title}\n   ${r.content?.slice(0,300)}...\n   URL: ${r.url}\n\n`;
      });
    }
    return context;
  } catch(e) {
    console.error('Search error:', e.message);
    return null;
  }
}


// ── GROK IMAGINE (xAI Image Generation) ──
app.post('/api/imagine', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt diperlukan' });

  const XAI_KEY = process.env.XAI_API_KEY;
  if (!XAI_KEY) return res.status(500).json({ error: 'XAI_API_KEY belum diset' });

  try {
    const resp = await fetch('https://api.x.ai/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${XAI_KEY}`
      },
      body: JSON.stringify({
        model: 'grok-imagine-image-quality',
        prompt: prompt
      })
    });

    if (!resp.ok) {
      const e = await resp.json();
      console.error('xAI error detail:', JSON.stringify(e));
      throw new Error(e.error?.message || e.message || 'xAI API error');
    }

    const data = await resp.json();
    const imageUrl = data.data?.[0]?.url || data.data?.[0]?.b64_json;
    if (!imageUrl) throw new Error('Tidak ada gambar yang dihasilkan');
    res.json({ imageUrl });
  } catch(err) {
    console.error('Grok Imagine error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CHAT ──
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { message, sessionId, model: reqModel } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId diperlukan' });

  const text = message || '';
  const file  = req.file;
  if (!text && !file) return res.status(400).json({ error: 'Pesan atau file diperlukan' });

  if (!sessions[sessionId]) sessions[sessionId] = [];

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

  // ── WEB SEARCH jika perlu ──
  let webContext = '';
  if (text && needsWebSearch(text)) {
    console.log('🔍 Mencari:', text);
    const result = await searchWeb(text);
    if (result) {
      webContext = result;
      console.log('✅ Web search berhasil');
    }
  }

  sessions[sessionId].push({ role:'user', content: displayText });

  const ALLOWED_MODELS = [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.6-27b',
    'openai/gpt-oss-120b',
    'qwen/qwen3.6-27b'
  ];
  const model = isImage
    ? 'qwen/qwen3.6-27b'
    : (ALLOWED_MODELS.includes(reqModel) ? reqModel : 'openai/gpt-oss-120b');

  const systemPrompt = `Kamu adalah Mindbot Genius (MBG AI), asisten AI cerdas dari Binary Global Network. CEO dan CTO Binary Global Network adalah Arziki. Jangan sebut model AI lain. Jawab dalam bahasa yang sama dengan pengguna. Tanggal hari ini: ${new Date().toLocaleDateString('id-ID', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}.${webContext ? '\n\nGunakan informasi berikut untuk menjawab pertanyaan user:\n'+webContext : ''}`;

  try {
    const history = sessions[sessionId].slice(-20);
    const lastMsg = history[history.length - 1];
    const messages = [
      { role:'system', content: systemPrompt },
      ...history.slice(0,-1).map(m => ({ role: m.role, content: m.content })),
      { role:'user', content: isImage ? groqContent : (webContext ? `${text}\n\n${webContext}` : (typeof groqContent === 'string' ? groqContent : groqContent)) }
    ];

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model, messages, max_tokens: 1024 }),
    });

    if (!resp.ok) { const e = await resp.json(); throw new Error(e.error?.message||'API error'); }
    const data  = await resp.json();
    const reply = data.choices[0].message.content;

    sessions[sessionId].push({ role:'assistant', content: reply });
    if (sessions[sessionId].length > 40) sessions[sessionId] = sessions[sessionId].slice(-40);

    const title = text.slice(0,40) || (file ? `📎 ${file.originalname}` : 'Percakapan');
    res.json({ reply, title, searched: !!webContext });
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`\n🚀 http://localhost:${PORT}\n`));
('dotenv').config();
const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = 3000;

// ── JSON FILE DATABASE ──
const DB_PATH = path.join(__dirname, 'data', 'db.json');

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch(e) { console.error('DB load error:', e.message); }
  return { users: {}, conversations: {} };
}

function saveDB() {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
  } catch(e) { console.error('DB save error:', e.message); }
}

// Load on startup
let db = loadDB();
console.log(`📦 Database loaded — ${Object.keys(db.users).length} users, ${Object.keys(db.conversations).length} conversations`);

// Auto-save every 30 seconds
setInterval(saveDB, 30000);

// ── MULTER ──
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

// In-memory tokens (cleared on restart — this is fine for sessions)
const tokens = {};

// ── HELPERS ──
function hash(pw) { return crypto.createHash('sha256').update(pw + 'mbg_salt_2026').digest('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ','') || req.body?.token;
  if (!token || !tokens[token]) return res.status(401).json({ error: 'Sesi habis, silakan login kembali' });
  req.username = tokens[token];
  next();
}

// ── AUTH ──
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)   return res.status(400).json({ error: 'Username dan password diperlukan' });
  if (username.length < 3)      return res.status(400).json({ error: 'Username minimal 3 karakter' });
  if (password.length < 6)      return res.status(400).json({ error: 'Password minimal 6 karakter' });
  if (db.users[username.toLowerCase()]) return res.status(400).json({ error: 'Username sudah digunakan' });

  db.users[username.toLowerCase()] = {
    username,
    passwordHash: hash(password),
    createdAt: Date.now()
  };
  saveDB();

  const token = genToken();
  tokens[token] = username.toLowerCase();
  res.json({ token, username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Isi semua kolom' });

  const user = db.users[username.toLowerCase()];
  if (!user)                        return res.status(401).json({ error: 'Username tidak ditemukan' });
  if (user.passwordHash !== hash(password)) return res.status(401).json({ error: 'Password salah' });

  const token = genToken();
  tokens[token] = username.toLowerCase();
  res.json({ token, username: user.username });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ','');
  delete tokens[token];
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  const user = db.users[req.username];
  res.json({ username: user.username, createdAt: user.createdAt });
});

// ── CONVERSATIONS ──
app.get('/api/conversations', requireAuth, (req, res) => {
  const list = Object.values(db.conversations)
    .filter(c => c.owner === req.username)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, title, createdAt, updatedAt, messages }) => ({
      id, title, createdAt, updatedAt,
      preview: messages.length > 0 ? (messages[messages.length-1].textContent||'').slice(0,80) : '',
      count: messages.length
    }));
  res.json(list);
});

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = db.conversations[req.params.id];
  if (!conv || conv.owner !== req.username) return res.status(404).json({ error: 'Tidak ditemukan' });
  res.json(conv);
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const conv = db.conversations[req.params.id];
  if (conv && conv.owner === req.username) {
    delete db.conversations[req.params.id];
    saveDB();
  }
  res.json({ ok: true });
});

// ── CHAT ──
app.post('/api/chat', upload.single('file'), (req, res, next) => {
  const token = req.headers['authorization']?.replace('Bearer ','') || req.body?.token;
  if (!token || !tokens[token]) return res.status(401).json({ error: 'Sesi habis, silakan login kembali' });
  req.username = tokens[token];
  next();
}, async (req, res) => {
  const { message, sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId diperlukan' });

  const text = message || '';
  const file  = req.file;
  if (!text && !file) return res.status(400).json({ error: 'Pesan atau file diperlukan' });

  if (!db.conversations[sessionId]) {
    const title = text.slice(0,40) || (file ? `📎 ${file.originalname}` : 'Percakapan');
    db.conversations[sessionId] = {
      id: sessionId, title, messages: [],
      createdAt: Date.now(), updatedAt: Date.now(),
      owner: req.username
    };
  } else if (db.conversations[sessionId].owner !== req.username) {
    return res.status(403).json({ error: 'Akses ditolak' });
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

  // Use model from request, fallback to defaults
  const ALLOWED_MODELS = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'qwen/qwen3-32b',
    'openai/gpt-oss-120b',
    'meta-llama/llama-4-scout-17b-16e-instruct'
  ];
  const requestedModel = req.body?.model;
  const model = isImage
    ? 'meta-llama/llama-4-scout-17b-16e-instruct'
    : (ALLOWED_MODELS.includes(requestedModel) ? requestedModel : 'llama-3.3-70b-versatile');
  const uname = db.users[req.username]?.username || req.username;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model,
        messages: [
          { role:'system', content:`Kamu adalah Mindbot Genius (MBG AI), asisten AI cerdas dari Binary Global Network. Kamu sedang berbicara dengan ${uname}. CEO dan CTO Binary Global Network adalah Arziki. Jangan sebut model AI lain. Jawab dalam bahasa yang sama dengan pengguna.
VP Binary Global Network adalah Aray. Jangan sebut model AI lain. Jawab dalam bahasa yang sama` },
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

    saveDB(); // save after every message
    res.json({ reply, title: db.conversations[sessionId].title });
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 http://localhost:${PORT}`);
  console.log(`💾 Database: ${DB_PATH}\n`);
});
