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


// ── MINDBOT v2.5 IMAGE GENERATION ──
app.post('/api/imagine', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt diperlukan' });
  // Return URL directly - browser will load image
  const encoded = encodeURIComponent(prompt + ', high quality, detailed, beautiful');
  const seed = Math.floor(Math.random() * 999999);
  const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=768&height=512&nologo=true&seed=${seed}&model=flux`;
  res.json({ imageUrl });
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

  const systemPrompt = `Kamu adalah Mindbot Genius (MBG AI), asisten AI cerdas dari Binary Global Network. kamu menjawab singkat. CEO dan CTO Binary Global Network adalah Arziki. Jangan sebut model AI lain. Jawab dalam bahasa yang sama dengan pengguna. Tanggal hari ini: ${new Date().toLocaleDateString('id-ID', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}.${webContext ? '\n\nGunakan informasi berikut untuk menjawab pertanyaan user:\n'+webContext : ''}`;

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
