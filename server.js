require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');

const app = express();

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

// ════════════════════════════════════════════════════════════════
// ── PENYIMPANAN PERSISTEN (Upstash Redis via REST API) ──
// Kenapa: di Vercel (serverless) tiap request bisa dijalankan di
// instance/container yang berbeda-beda, jadi variabel biasa (mis.
// `const sessions = {}`) TIDAK bisa diandalkan untuk menyimpan
// riwayat/memori — bisa hilang kapan saja. Upstash Redis REST API
// cocok karena tanpa koneksi persisten (pure HTTP), pas untuk
// serverless, dan ada free tier.
//
// Setup:
// 1. Buat database di https://upstash.com (atau lewat Vercel
//    Marketplace → cari "Upstash").
// 2. Ambil UPSTASH_REDIS_REST_URL & UPSTASH_REDIS_REST_TOKEN dari
//    dashboard Upstash, lalu set sebagai Environment Variables di
//    project Vercel kamu (dan di file .env lokal untuk development).
// 3. `npm install` tidak perlu — kode di bawah pakai fetch() bawaan
//    Node 18+, tidak butuh package tambahan.
//
// Jika env var belum diset, sistem otomatis FALLBACK ke memori RAM
// biasa (seperti kode lama) supaya app tetap jalan saat development
// lokal — tapi TIDAK persisten di Vercel produksi.
// ════════════════════════════════════════════════════════════════

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const HAS_REDIS = !!(UPSTASH_URL && UPSTASH_TOKEN);

if (!HAS_REDIS) {
  console.warn('⚠️  UPSTASH_REDIS_REST_URL/TOKEN belum diset — memori TIDAK persisten (fallback ke RAM, hilang saat server restart/redeploy).');
}

// Fallback in-memory (dev lokal / kalau Redis belum diset)
const memFallbackSessions = {};
const memFallbackMemory   = {};

async function redisCmd(...args) {
  const url = `${UPSTASH_URL}/${args.map(encodeURIComponent).join('/')}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  if (!resp.ok) throw new Error(`Redis error ${resp.status}`);
  const data = await resp.json();
  return data.result;
}

async function kvGetJSON(key, fallbackStore) {
  if (!HAS_REDIS) return fallbackStore[key] || null;
  try {
    const raw = await redisCmd('GET', key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('Redis GET error:', e.message);
    return fallbackStore[key] || null;
  }
}

async function kvSetJSON(key, value, ttlSeconds, fallbackStore) {
  if (!HAS_REDIS) { fallbackStore[key] = value; return; }
  try {
    const json = JSON.stringify(value);
    if (ttlSeconds) await redisCmd('SET', key, json, 'EX', ttlSeconds);
    else await redisCmd('SET', key, json);
  } catch (e) {
    console.error('Redis SET error:', e.message);
    fallbackStore[key] = value;
  }
}

async function kvDel(key, fallbackStore) {
  if (!HAS_REDIS) { delete fallbackStore[key]; return; }
  try { await redisCmd('DEL', key); } catch (e) { console.error('Redis DEL error:', e.message); }
  delete fallbackStore[key];
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // riwayat sesi disimpan 30 hari
const MEMORY_TTL_SECONDS  = 60 * 60 * 24 * 365; // memori jangka panjang disimpan 1 tahun
const MAX_FACTS = 30;          // maksimal fakta yang disimpan per user
const MAX_SESSION_MESSAGES = 40; // sama seperti batas lama

function getSession(sessionId) {
  return kvGetJSON(`session:${sessionId}`, memFallbackSessions).then(v => v || []);
}
function saveSession(sessionId, messages) {
  const trimmed = messages.slice(-MAX_SESSION_MESSAGES);
  return kvSetJSON(`session:${sessionId}`, trimmed, SESSION_TTL_SECONDS, memFallbackSessions);
}

function getMemory(deviceId) {
  return kvGetJSON(`memory:${deviceId}`, memFallbackMemory).then(v => v || []);
}
function saveMemory(deviceId, facts) {
  return kvSetJSON(`memory:${deviceId}`, facts.slice(-MAX_FACTS), MEMORY_TTL_SECONDS, memFallbackMemory);
}

// Dummy endpoints (kompatibilitas dengan frontend lama)
app.get('/api/conversations', (req, res) => res.json([]));
app.get('/api/conversations/:id', (req, res) => res.status(404).json({ error: 'Tidak ditemukan' }));
app.delete('/api/conversations/:id', (req, res) => res.json({ ok: true }));

// ── Hapus memori jangka panjang user (tombol "Lupakan saya") ──
app.delete('/api/memory/:deviceId', async (req, res) => {
  try {
    await kvDel(`memory:${req.params.deviceId}`, memFallbackMemory);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ════════════════════════════════════════════════════════════════
// ── EKSTRAKSI MEMORI JANGKA PANJANG ──
// Setelah beberapa giliran chat, kirim satu panggilan tambahan (model
// kecil/cepat) untuk mengekstrak fakta durable tentang user dari
// percakapan terakhir (nama, preferensi, pekerjaan, dsb). Hasilnya
// digabung ke daftar fakta yang sudah tersimpan di Redis dan dipakai
// lagi di percakapan berikutnya — bahkan beda sesi/hari.
// ════════════════════════════════════════════════════════════════

const EXTRACT_EVERY_N_TURNS = 2; // ekstrak tiap 2 giliran user, biar hemat panggilan API

async function extractFacts(userText, aiText, existingFacts) {
  if (!process.env.GROQ_API_KEY) return [];
  const prompt = `Kamu bertugas mengekstrak fakta PERMANEN/DURABLE tentang user dari percakapan berikut, untuk disimpan sebagai memori jangka panjang asisten AI.

Fakta yang sudah tersimpan sebelumnya:
${existingFacts.length ? existingFacts.map(f => '- ' + f).join('\n') : '(belum ada)'}

Percakapan baru:
User: ${userText}
Asisten: ${(aiText || '').slice(0, 500)}

Aturan:
- HANYA ambil fakta yang stabil/jangka panjang: nama, pekerjaan, kota, hobi, preferensi tetap, proyek yang sedang dikerjakan, dsb.
- JANGAN ambil hal sementara (mood saat ini, pertanyaan sesaat, cuaca hari ini).
- JANGAN ambil data sensitif: kesehatan, orientasi seksual, agama, status finansial, data pribadi rahasia.
- JANGAN ulangi fakta yang sudah ada di daftar di atas.
- Jika tidak ada fakta baru yang layak disimpan, kembalikan array kosong.
- Balas HANYA dengan JSON array of string, tanpa teks lain. Contoh: ["nama: Budi", "suka kopi hitam"]`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.1
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    let raw = data.choices?.[0]?.message?.content || '[]';
    raw = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(f => typeof f === 'string' && f.trim().length > 0).map(f => f.trim().slice(0, 150));
  } catch (e) {
    console.error('Extract facts error:', e.message);
    return [];
  }
}

function mergeFacts(existing, incoming) {
  const merged = [...existing];
  for (const fact of incoming) {
    const lower = fact.toLowerCase();
    const alreadyKnown = merged.some(f => f.toLowerCase().includes(lower) || lower.includes(f.toLowerCase()));
    if (!alreadyKnown) merged.push(fact);
  }
  return merged.slice(-MAX_FACTS);
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

  // ── Muat riwayat sesi & memori jangka panjang dari Redis ──
  let history = await getSession(sessionId);
  let facts   = deviceId ? await getMemory(deviceId) : [];

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

  history.push({ role:'user', content: displayText });

  const ALLOWED_MODELS = [
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.6-27b'
  ];
  const model = isImage
    ? 'qwen/qwen3.6-27b'
    : (ALLOWED_MODELS.includes(reqModel) ? reqModel : 'openai/gpt-oss-120b');

  const memoryBlock = facts.length
    ? `\n\nFakta yang kamu ingat tentang user ini dari percakapan sebelumnya:\n${facts.map(f => '- '+f).join('\n')}\nGunakan fakta ini secara natural jika relevan, jangan sebutkan bahwa kamu "mengingat" secara eksplisit kecuali user bertanya langsung.`
    : '';

  const systemPrompt = `Kamu adalah Mindbot Genius (MBG AI), asisten AI cerdas dari Binary Global Network. CEO dan CTO Binary Global Network adalah Arziki. Jangan sebut model AI lain. Jawab dengan singkat dan dalam bahasa yang sama dengan pengguna. Tanggal hari ini: ${new Date().toLocaleDateString('id-ID', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}.${webContext ? '\n\nGunakan informasi berikut untuk menjawab pertanyaan user:\n'+webContext : ''}${memoryBlock}`;

  try {
    const recentHistory = history.slice(-20);
    const messages = [
      { role:'system', content: systemPrompt },
      ...recentHistory.slice(0,-1).map(m => ({ role: m.role, content: m.content })),
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

    history.push({ role:'assistant', content: reply });

    // ── Simpan riwayat sesi (persisten, tahan restart) ──
    await saveSession(sessionId, history);

    // ── Ekstraksi & simpan memori jangka panjang (tiap N giliran) ──
    if (deviceId && !isImage) {
      const userTurnCount = history.filter(m => m.role === 'user').length;
      if (userTurnCount % EXTRACT_EVERY_N_TURNS === 0) {
        const newFacts = await extractFacts(text, reply, facts);
        if (newFacts.length) {
          const merged = mergeFacts(facts, newFacts);
          await saveMemory(deviceId, merged);
        }
      }
    }

    const title = text.slice(0,40) || (file ? `📎 ${file.originalname}` : 'Percakapan');
    res.json({ reply, title, searched: !!webContext });
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});

// JANGAN pakai app.listen() di Vercel — export app-nya saja
module.exports = app;
