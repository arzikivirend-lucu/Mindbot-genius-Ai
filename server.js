require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app = express();

const sessions = {};

// ── INGATAN LINTAS-PERCAKAPAN (per perangkat / deviceId) ──
// Ini berbeda dari `sessions` di atas: `sessions` hanya menyimpan riwayat
// pesan mentah untuk SATU percakapan (dibuang saat user klik "Percakapan
// Baru"). `memory-store.json` di bawah ini menyimpan RANGKUMAN fakta
// penting tentang pengguna (nama, preferensi, proyek, dst) yang tetap ada
// walau user membuka percakapan baru atau kembali besok — sehingga AI bisa
// "mengingat" dan ditanya lagi soal hal-hal dari sesi sebelumnya.
//
// CATATAN DEPLOYMENT: jika di-deploy ke platform serverless (mis. Vercel),
// filesystem bersifat sementara/tidak dijamin persisten antar invocation —
// untuk produksi jangka panjang di platform seperti itu, ganti implementasi
// loadMemoryStore/saveMemoryStore di bawah dengan database (Vercel KV,
// Supabase, MongoDB, dll). Di server dengan disk persisten (VPS, Railway,
// server sendiri) pendekatan file JSON ini sudah cukup dan akan bertahan
// antar restart.
const MEMORY_FILE = path.join(__dirname, 'memory-store.json');
const MAX_MEMORY_CHARS = 4000;

function loadMemoryStore() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}
function saveMemoryStore(store) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Gagal menyimpan memory-store.json:', e.message);
  }
}
function getUserMemory(deviceId) {
  if (!deviceId) return '';
  const store = loadMemoryStore();
  return store[deviceId]?.memory || '';
}
function setUserMemory(deviceId, memoryText) {
  if (!deviceId || !memoryText) return;
  const store = loadMemoryStore();
  store[deviceId] = { memory: memoryText.slice(0, MAX_MEMORY_CHARS), updatedAt: Date.now() };
  saveMemoryStore(store);
}
function clearUserMemory(deviceId) {
  if (!deviceId) return;
  const store = loadMemoryStore();
  delete store[deviceId];
  saveMemoryStore(store);
}

// Setelah tiap balasan AI, minta model merangkum ulang catatan ingatan
// penting tentang pengguna, digabung dengan catatan lama. Dijalankan di
// latar belakang (fire-and-forget) supaya TIDAK menunda balasan ke user.
async function updateMemoryInBackground(deviceId, userText, aiText) {
  if (!deviceId || !process.env.GROQ_API_KEY) return;
  try {
    const oldMemory = getUserMemory(deviceId);
    const prompt = `Ini adalah catatan ingatanmu tentang seorang pengguna dari percakapan-percakapan sebelumnya:
"""${oldMemory || '(belum ada catatan)'}"""

Percakapan baru saja terjadi:
Pengguna: "${(userText || '').slice(0, 500)}"
AI: "${(aiText || '').slice(0, 500)}"

Perbarui catatan ingatan tersebut. Simpan HANYA fakta yang layak diingat jangka panjang tentang pengguna (nama, pekerjaan/sekolah, preferensi, proyek yang sedang dikerjakan, konteks penting lain) dalam bentuk poin-poin singkat berbahasa Indonesia. Gabungkan dengan catatan lama, buang yang sudah tidak relevan atau sudah digantikan info baru. Jangan tulis penjelasan lain, jangan tulis ulang seluruh percakapan — HANYA daftar poin ingatan (maksimal 15 poin, satu poin per baris diawali "- "). Jika tidak ada fakta baru yang layak diingat, kembalikan catatan lama apa adanya.`;

    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 500
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const updated = data.choices?.[0]?.message?.content?.trim();
    if (updated) setUserMemory(deviceId, updated);
  } catch (e) {
    console.error('Gagal memperbarui ingatan:', e.message);
  }
}

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

// Dummy endpoints
app.get('/api/conversations', (req, res) => res.json([]));
app.get('/api/conversations/:id', (req, res) => res.status(404).json({ error: 'Tidak ditemukan' }));
app.delete('/api/conversations/:id', (req, res) => res.json({ ok: true }));

// ── INGATAN: lihat & hapus ──
app.get('/api/memory', (req, res) => {
  const deviceId = req.query.deviceId;
  if (!deviceId) return res.status(400).json({ error: 'deviceId diperlukan' });
  res.json({ memory: getUserMemory(deviceId) });
});

app.delete('/api/memory', (req, res) => {
  const deviceId = req.query.deviceId || req.body?.deviceId;
  if (!deviceId) return res.status(400).json({ error: 'deviceId diperlukan' });
  clearUserMemory(deviceId);
  res.json({ ok: true });
});

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

// ── MINDBOT v2.5 IMAGE GENERATION (deAPI.ai) — async job + polling ──
const DEAPI_BASE  = 'https://api.deapi.ai/api/v1/client';
const DEAPI_MODEL = 'ZImageTurbo_INT8'; // model cepat, cocok untuk realtime chat

function deapiHeaders() {
  return {
    'Authorization': `Bearer ${process.env.DEAPI_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

// 1. Submit job — balas cepat dengan requestId, TIDAK menunggu gambar jadi
app.post('/api/imagine', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt diperlukan' });

  const DEAPI_KEY = process.env.DEAPI_API_KEY;
  if (!DEAPI_KEY) return res.status(500).json({ error: 'DEAPI_API_KEY belum diset' });

  try {
    const submitResp = await fetch(`${DEAPI_BASE}/txt2img`, {
      method: 'POST',
      headers: deapiHeaders(),
      body: JSON.stringify({
        prompt: prompt + ', high quality, detailed, beautiful',
        model: DEAPI_MODEL,
        width: 768,
        height: 512,
        steps: 4,
        seed: -1
      })
    });

    if (!submitResp.ok) {
      const errText = await submitResp.text();
      throw new Error(`deAPI submit error (${submitResp.status}): ${errText}`);
    }

    const submitData = await submitResp.json();
    const requestId = submitData?.data?.request_id;
    if (!requestId) throw new Error('deAPI tidak mengembalikan request_id');

    res.json({ requestId, status: 'pending' });
  } catch (err) {
    console.error('Imagine submit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Cek status job — dipanggil berulang (polling) oleh frontend tiap 1-2 detik
app.get('/api/imagine/status/:requestId', async (req, res) => {
  const DEAPI_KEY = process.env.DEAPI_API_KEY;
  if (!DEAPI_KEY) return res.status(500).json({ error: 'DEAPI_API_KEY belum diset' });

  try {
    const statusResp = await fetch(`${DEAPI_BASE}/request-status/${req.params.requestId}`, {
      headers: deapiHeaders()
    });
    if (!statusResp.ok) {
      const errText = await statusResp.text();
      throw new Error(`deAPI status error (${statusResp.status}): ${errText}`);
    }

    const statusData = await statusResp.json();
    const d = statusData?.data || statusData; // fallback kalau nggak dibungkus "data"
    const rawStatus = (d?.status || '').toLowerCase();

    const DONE_STATUSES   = ['done', 'completed', 'success', 'succeeded', 'finished'];
    const FAILED_STATUSES = ['failed', 'error', 'cancelled'];

    if (DONE_STATUSES.includes(rawStatus)) {
      // Coba semua kemungkinan lokasi field URL gambar
      const imageUrl =
        d?.result_url ||
        d?.result?.url ||
        d?.result?.[0]?.url ||
        d?.result?.image_url ||
        d?.output_url ||
        d?.output?.[0]?.url ||
        d?.output?.url ||
        d?.url ||
        d?.download_url ||
        d?.assets?.[0]?.url ||
        d?.results_alt_formats?.jpg ||
        d?.results_alt_formats?.webp ||
        null;

      if (!imageUrl) {
        // Belum ketemu field yang cocok — kirim raw data supaya bisa dicek di Network tab
        return res.json({ status: 'done', imageUrl: null, debugRaw: statusData });
      }
      return res.json({ status: 'completed', imageUrl });
    }

    if (FAILED_STATUSES.includes(rawStatus)) {
      return res.json({ status: 'failed', error: d?.error || d?.error_message || 'Gagal membuat gambar' });
    }

    res.json({ status: rawStatus || 'pending' });
  } catch (err) {
    console.error('Imagine status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── CHAT ──
app.post('/api/chat', upload.single('file'), async (req, res) => {
  const { message, sessionId, model: reqModel, deviceId } = req.body;
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

  const userMemory = deviceId ? getUserMemory(deviceId) : '';

  const systemPrompt = `Kamu adalah Mindbot Genius (MBG AI) asisten AI cerdas buatan Arziki. Jangan sebut model AI lain. Jawab dengan singkat dan dalam bahasa yang sama dengan pengguna. Tanggal hari ini: ${new Date().toLocaleDateString('id-ID', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}.${userMemory ? '\n\nBerikut catatan ingatanmu tentang pengguna ini dari percakapan-percakapan sebelumnya. Gunakan jika relevan dengan pertanyaan sekarang, dan jika pengguna bertanya apa yang kamu ingat tentang mereka, jawab berdasarkan catatan ini:\n'+userMemory : ''}${webContext ? '\n\nGunakan informasi berikut untuk menjawab pertanyaan user:\n'+webContext : ''}`;

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

    // Perbarui ingatan lintas-percakapan di latar belakang (tidak menunda respons di atas)
    if (deviceId) updateMemoryInBackground(deviceId, text || (file ? `[file: ${file.originalname}]` : ''), reply);
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// JANGAN pakai app.listen() di Vercel — export app-nya saja
module.exports = app;
