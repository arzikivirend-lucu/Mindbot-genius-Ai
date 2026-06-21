require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MONGODB CONNECTION ──
const MONGO_URI = process.env.MONGODB_URI;
let db;
let conversationsCol;

async function connectDB() {
  if (!MONGO_URI) {
    console.error('⚠️  MONGODB_URI tidak ditemukan! Tambahkan di environment variables.');
    return;
  }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db('mindbot_genius');
    conversationsCol = db.collection('conversations');
    console.log('📦 MongoDB terhubung!');
  } catch (e) {
    console.error('❌ MongoDB connection error:', e.message);
  }
}
connectDB();

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
app.get('/api/conversations', async (req, res) => {
  try {
    const deviceId = req.query.deviceId;
    const filter = deviceId ? { $or: [{ deviceId: null }, { deviceId: deviceId }] } : {};
    const convs = await conversationsCol.find(filter).sort({ updatedAt: -1 }).toArray();
    const list = convs.map(({ id, title, createdAt, updatedAt, messages }) => ({
      id, title, createdAt, updatedAt,
      preview: messages.length > 0 ? (messages[messages.length-1].textContent||'').slice(0,80) : '',
      count: messages.length
    }));
    res.json(list);
  } catch(e) {
    console.error(e.message);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  try {
    const conv = await conversationsCol.findOne({ id: req.params.id });
    const deviceId = req.query.deviceId;
    if (!conv) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (deviceId && conv.deviceId && conv.deviceId !== deviceId) return res.status(403).json({ error: 'Akses ditolak' });
    res.json(conv);
  } catch(e) {
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  try {
    const conv = await conversationsCol.findOne({ id: req.params.id });
    const deviceId = req.query.deviceId;
    if (!conv) return res.json({ ok: true });
    if (deviceId && conv.deviceId && conv.deviceId !== deviceId) return res.status(403).json({ error: 'Akses ditolak' });
    await conversationsCol.deleteOne({ id: req.params.id });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ── CHAT ──
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { message, sessionId, model: reqModel, deviceId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId diperlukan' });

  const text = message || '';
  const file  = req.file;
  if (!text && !file) return res.status(400).json({ error: 'Pesan atau file diperlukan' });

  try {
    let conv = await conversationsCol.findOne({ id: sessionId });
    if (!conv) {
      const title = text.slice(0,40) || (file ? `📎 ${file.originalname}` : 'Percakapan');
      conv = {
        id: sessionId, title, messages: [],
        createdAt: Date.now(), updatedAt: Date.now(),
        deviceId: deviceId || null
      };
      await conversationsCol.insertOne(conv);
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

    const userMsg = {
      role: 'user', textContent: displayText, hasImage: isImage,
      fileName: file?.originalname, fileType: file?.mimetype,
      imageData: isImage ? `data:${file.mimetype};base64,${file.buffer.toString('base64')}` : null
    };

    await conversationsCol.updateOne(
      { id: sessionId },
      { $push: { messages: userMsg }, $set: { updatedAt: Date.now() } }
    );

    const history = conv.messages.map(m => ({ role: m.role==='user'?'user':'assistant', content: m.textContent||'' }));

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

    await conversationsCol.updateOne(
      { id: sessionId },
      { $push: { messages: { role:'assistant', textContent: reply } }, $set: { updatedAt: Date.now() } }
    );

    const updatedConv = await conversationsCol.findOne({ id: sessionId });
    if (updatedConv.messages.length > 40) {
      await conversationsCol.updateOne(
        { id: sessionId },
        { $set: { messages: updatedConv.messages.slice(-40) } }
      );
    }

    res.json({ reply, title: conv.title });
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 http://localhost:${PORT}\n`);
});
