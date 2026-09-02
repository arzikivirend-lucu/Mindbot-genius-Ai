require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js'); // npm install @supabase/supabase-js

// AdmZip bersifat opsional: kalau paket "adm-zip" belum ter-install,
// jangan sampai seluruh server ikut crash — cukup nonaktifkan fitur baca ZIP.
let AdmZip = null;
try {
  AdmZip = require('adm-zip'); // npm install adm-zip
} catch (e) {
  console.warn('⚠️  Paket "adm-zip" belum ter-install. Jalankan: npm install adm-zip — fitur baca isi ZIP dinonaktifkan sementara.');
}

const app = express();

const sessions = {};

// ── SUPABASE (auth + penyimpanan lintas perangkat) ──
// SUPABASE_URL & SUPABASE_ANON_KEY diambil dari Project Settings → API di dashboard Supabase.
// Kita PAKAI ANON KEY di backend (bukan service_role), tapi disisipi token JWT milik
// user yang sedang login pada tiap request — jadi Row Level Security di database
// tetap otomatis membatasi setiap user hanya bisa akses datanya sendiri.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn('⚠️  SUPABASE_URL / SUPABASE_ANON_KEY belum diset di environment variables — auth & sync lintas perangkat dinonaktifkan, app tetap jalan sebagai mode tamu (localStorage).');
}

function supabaseForRequest(req) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

// Middleware: kalau ada token Bearer yang valid, lampirkan req.user & req.supabase.
// TIDAK menolak request tanpa token — chat tetap bisa dipakai sebagai tamu.
async function attachUser(req, res, next) {
  req.user = null;
  req.supabase = null;
  const sb = supabaseForRequest(req);
  if (!sb) return next();
  try {
    const { data, error } = await sb.auth.getUser();
    if (!error && data && data.user) {
      req.user = data.user;
      req.supabase = sb;
    }
  } catch (e) { /* token invalid/kedaluwarsa — anggap tamu */ }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Silakan login terlebih dahulu' });
  next();
}

// ── Ekstensi yang dianggap "teks" dan boleh dibaca langsung isinya ──
const TEXT_EXTENSIONS = [
  '.js','.jsx','.mjs','.cjs','.ts','.tsx','.html','.htm','.css','.scss','.sass',
  '.json','.xml','.csv','.tsv','.md','.markdown','.py','.java','.c','.cpp','.h',
  '.hpp','.cs','.php','.rb','.go','.rs','.sh','.bash','.yml','.yaml','.sql',
  '.txt','.log','.ini','.toml','.env','.svg','.vue','.svelte','.graphql'
];

function isTextLike(mimetype, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (TEXT_EXTENSIONS.includes(ext)) return true;
  if (mimetype && (
    mimetype.startsWith('text/') ||
    ['application/json','application/javascript','application/xml','application/x-yaml','application/x-sh'].includes(mimetype)
  )) return true;
  return false;
}

function isZipLike(mimetype, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return ext === '.zip' || (mimetype && mimetype.includes('zip'));
}

// Baca ringkasan isi ZIP: struktur file + isi file-file teks di dalamnya (dibatasi)
function readZipSummary(buffer, maxFiles = 25, maxCharsPerFile = 1500, maxTotalChars = 12000) {
  if (!AdmZip) return null;
  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    let out = `[Isi arsip ZIP — ${entries.length} entri]\n\n`;
    const fileList = entries.map(e => (e.isDirectory ? '📁 ' : '📄 ') + e.entryName).join('\n');
    out += 'Struktur file:\n' + fileList.slice(0, 3000) + (fileList.length > 3000 ? '\n... (dipotong)' : '') + '\n\n';

    let shown = 0;
    let totalChars = out.length;
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      if (shown >= maxFiles || totalChars >= maxTotalChars) break;
      const ext = path.extname(entry.entryName).toLowerCase();
      if (!TEXT_EXTENSIONS.includes(ext)) continue;
      if (entry.header.size > 200 * 1024) continue;

      try {
        const content = entry.getData().toString('utf-8').slice(0, maxCharsPerFile);
        out += `--- ${entry.entryName} ---\n${content}\n\n`;
        totalChars += content.length + entry.entryName.length + 10;
        shown++;
      } catch (e) { /* lewati file yang gagal dibaca (kemungkinan biner) */ }
    }
    if (shown === 0) out += '(Tidak ada file teks yang bisa ditampilkan isinya, atau semua file terlalu besar/biner)\n';
    return out.slice(0, maxTotalChars + 3000);
  } catch (e) {
    console.error('Zip read error:', e.message);
    return null;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const okMimes = [
      'image/jpeg','image/png','image/gif','image/webp',
      'text/plain','application/pdf',
      'text/html','text/css','text/csv','text/markdown','text/xml',
      'application/json','application/javascript','text/javascript',
      'application/xml','application/x-yaml','application/zip',
      'application/x-zip-compressed','application/octet-stream'
    ];
    const okExts = TEXT_EXTENSIONS.concat(['.zip']);
    cb(null, okMimes.includes(file.mimetype) || okExts.includes(ext));
  }
});

app.use(express.json());
app.use(attachUser);
app.use(express.static(path.join(__dirname, '..', 'public')));

// Dummy endpoints (kompatibilitas lama)
app.get('/api/conversations-legacy', (req, res) => res.json([]));

// ═══════════════════════════════════════════════════════
// ── PERCAKAPAN (Supabase — hanya untuk user yang login) ──
// Menyimpan { id, title, messages[], preview } per baris, dibatasi RLS
// supaya tiap user cuma bisa baca/tulis/hapus percakapan miliknya sendiri.
// ═══════════════════════════════════════════════════════
app.get('/api/conversations', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('conversations')
    .select('id,title,preview,created_at,updated_at')
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/conversations/:id', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('conversations')
    .select('*')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: 'Percakapan tidak ditemukan' });
  res.json(data);
});

app.put('/api/conversations/:id', requireAuth, async (req, res) => {
  const { title, messages, preview } = req.body;
  const { data, error } = await req.supabase
    .from('conversations')
    .upsert({
      id: req.params.id,
      user_id: req.user.id,
      title: title || 'Percakapan Baru',
      messages: messages || [],
      preview: preview || '',
      updated_at: new Date().toISOString()
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/conversations/:id', requireAuth, async (req, res) => {
  const { error } = await req.supabase.from('conversations').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════
// ── INGATAN AI (Supabase — hanya untuk user yang login) ──
// Tamu (belum login) tetap pakai localStorage di sisi klien seperti sebelumnya.
// ═══════════════════════════════════════════════════════
app.get('/api/memory', requireAuth, async (req, res) => {
  const { data, error } = await req.supabase
    .from('memory_facts')
    .select('id,fact,created_at')
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/memory', requireAuth, async (req, res) => {
  const { facts } = req.body;
  if (!Array.isArray(facts) || !facts.length) return res.json({ inserted: [] });
  const rows = facts.filter(f => typeof f === 'string' && f.trim()).map(f => ({ user_id: req.user.id, fact: f.trim() }));
  if (!rows.length) return res.json({ inserted: [] });
  const { data, error } = await req.supabase.from('memory_facts').insert(rows).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ inserted: data });
});

app.delete('/api/memory/:id', requireAuth, async (req, res) => {
  const { error } = await req.supabase.from('memory_facts').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.delete('/api/memory', requireAuth, async (req, res) => {
  const { error } = await req.supabase.from('memory_facts').delete().eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
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
const DEAPI_MODEL = 'ZImageTurbo_INT8';

function deapiHeaders() {
  return {
    'Authorization': `Bearer ${process.env.DEAPI_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

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
    const d = statusData?.data || statusData;
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

// ── INGATAN AI: ekstraksi fakta per-pertukaran pesan ──
// Jika request datang dari user yang LOGIN (req.user ada), fakta baru langsung
// disimpan ke tabel memory_facts di Supabase (persist lintas perangkat).
// Jika TAMU, cukup dikembalikan ke klien supaya disimpan di localStorage sisi klien
// seperti sebelumnya — server tidak menyimpan apa pun untuk tamu.
app.post('/api/memory/extract', async (req, res) => {
  const { userText, aiText, existingMemory } = req.body;
  if (!userText && !aiText) return res.json({ facts: [] });

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.json({ facts: [] });

  const existing = Array.isArray(existingMemory) ? existingMemory.slice(0, 60) : [];

  const extractPrompt = `Kamu bertugas mengekstrak fakta PENTING dan TAHAN LAMA tentang pengguna dari potongan percakapan berikut, untuk disimpan sebagai memori jangka panjang asisten AI.

Hanya ambil fakta seperti: nama pengguna, pekerjaan/proyek yang sedang dikerjakan, preferensi personal, informasi identitas yang relevan, tujuan jangka panjang, atau konteks penting lain yang kemungkinan berguna di percakapan mendatang.
JANGAN ambil hal yang sifatnya sesaat (pertanyaan sekali pakai, small talk, permintaan teknis satu kali, atau hal yang sudah tercakup dalam memori yang sudah ada).

Memori yang SUDAH ada (jangan ulangi jika sudah tercakup):
${existing.length ? existing.map(f => '- ' + f).join('\n') : '(belum ada)'}

Percakapan baru:
User: "${(userText || '').slice(0, 500)}"
AI: "${(aiText || '').slice(0, 500)}"

Balas HANYA dengan array JSON berisi string fakta baru yang layak diingat (maksimal 3 item, singkat dan jelas, dalam Bahasa Indonesia). Jika tidak ada fakta baru yang layak diingat, balas dengan array kosong [].
Contoh format balasan: ["Nama pengguna adalah Budi", "Sedang mengerjakan aplikasi toko online"]`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [{ role: 'user', content: extractPrompt }],
        max_tokens: 300,
        temperature: 0.2
      }),
    });
    if (!resp.ok) return res.json({ facts: [] });
    const data = await resp.json();
    let raw = data.choices?.[0]?.message?.content || '[]';
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const match = raw.match(/\[[\s\S]*\]/);
    let facts = [];
    if (match) {
      try { facts = JSON.parse(match[0]); } catch (e) { facts = []; }
    }
    if (!Array.isArray(facts)) facts = [];
    facts = facts.filter(f => typeof f === 'string' && f.trim().length > 0).slice(0, 3);

    // Kalau user login, simpan langsung ke Supabase supaya tidak bergantung
    // pada klien untuk persist-nya.
    if (facts.length && req.user && req.supabase) {
      const rows = facts.map(f => ({ user_id: req.user.id, fact: f }));
      req.supabase.from('memory_facts').insert(rows).then(({ error }) => {
        if (error) console.warn('Gagal simpan ingatan ke Supabase:', error.message);
      });
    }

    res.json({ facts });
  } catch (err) {
    console.error('Memory extract error:', err.message);
    res.json({ facts: [] });
  }
});

// Bungkus middleware upload supaya error (file kebesaran, dll) selalu
// dibalas sebagai JSON, bukan halaman error HTML dari Express.
function safeUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Upload error:', err.message);
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Ukuran file terlalu besar (maksimal 20MB)'
        : (err.message || 'Gagal mengunggah file');
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

// ── CHAT ──
app.post('/api/chat', safeUpload, async (req, res) => {
  const { message, sessionId, model: reqModel, memory } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId diperlukan' });

  const text = message || '';
  const file  = req.file;
  if (!text && !file) return res.status(400).json({ error: 'Pesan atau file diperlukan' });

  if (!sessions[sessionId]) sessions[sessionId] = [];

  const isImage = file && file.mimetype.startsWith('image/');
  const isZip   = file && !isImage && isZipLike(file.mimetype, file.originalname);
  const isText  = file && !isImage && !isZip && isTextLike(file.mimetype, file.originalname);
  let groqContent, displayText = text;

  if (isImage) {
    const b64 = file.buffer.toString('base64');
    groqContent = [
      { type:'image_url', image_url:{ url:`data:${file.mimetype};base64,${b64}` } },
      { type:'text', text: text||'Tolong analisis gambar ini.' }
    ];
    displayText = text||'Analisis gambar ini.';
  } else if (isZip) {
    const zipSummary = readZipSummary(file.buffer);
    if (zipSummary) {
      groqContent = text
        ? `${text}\n\n[File ZIP: "${file.originalname}"]\n${zipSummary}`
        : `Analisis isi file ZIP ini:\n\n${zipSummary}`;
    } else {
      groqContent = text
        ? `${text}\n\n[File ZIP: "${file.originalname}" — gagal dibaca, mungkin rusak atau terenkripsi]`
        : `File ZIP "${file.originalname}" gagal dibaca (mungkin rusak atau terenkripsi).`;
    }
    displayText = text || `🗜️ ${file.originalname}`;
  } else if (isText) {
    const fc = file.buffer.toString('utf-8').slice(0,8000);
    groqContent = text ? `${text}\n\n[File: "${file.originalname}"]\n${fc}` : `Analisis file ini:\n\n${fc}`;
    displayText = text||`📄 ${file.originalname}`;
  } else if (file) {
    groqContent = text
      ? `${text}\n\n[File "${file.originalname}" diterima, namun tipe filenya tidak didukung untuk dibaca isinya.]`
      : `File "${file.originalname}" diterima, namun tipe filenya tidak didukung untuk dibaca isinya.`;
    displayText = text || `📎 ${file.originalname}`;
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

  // ── INGATAN AI ──
  // User login: ambil dari Supabase (sumber kebenaran, lintas perangkat).
  // Tamu: pakai apa yang dikirim klien dari localStorage (field `memory`).
  let memArr = [];
  if (req.user && req.supabase) {
    try {
      const { data } = await req.supabase.from('memory_facts').select('fact').order('created_at', { ascending: true });
      memArr = (data || []).map(r => r.fact);
    } catch (e) { /* abaikan, tetap lanjut tanpa memori */ }
  } else if (memory) {
    try {
      const memParsed = JSON.parse(memory);
      if (Array.isArray(memParsed)) memArr = memParsed;
    } catch (e) { /* abaikan jika format tidak valid */ }
  }

  let memoryContext = '';
  if (memArr.length) {
    memoryContext = '\n\nBerikut hal-hal yang kamu ingat tentang pengguna ini dari percakapan-percakapan sebelumnya:\n'
      + memArr.slice(0, 60).map(f => '- ' + f).join('\n')
      + '\nGunakan informasi ini secara alami jika relevan dengan pertanyaan pengguna saat ini. Jika pengguna bertanya apa yang kamu ingat tentangnya, sebutkan poin-poin di atas secara ringkas.';
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

  const systemPrompt = `Kamu adalah Mindbot Genius (MBG AI) asisten AI cerdas buatan Arziki. Jangan sebut model AI lain. Jawab dengan singkat dan dalam bahasa yang sama dengan pengguna. Tanggal hari ini: ${new Date().toLocaleDateString('id-ID', {weekday:'long',year:'numeric',month:'long',day:'numeric'})}.${memoryContext}${webContext ? '\n\nGunakan informasi berikut untuk menjawab pertanyaan user:\n'+webContext : ''}`;

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

// ── Jaring pengaman terakhir ──
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'Terjadi kesalahan pada server' });
});

// JANGAN pakai app.listen() di Vercel — export app-nya saja
module.exports = app;
