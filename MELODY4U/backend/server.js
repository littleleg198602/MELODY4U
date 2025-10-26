// server.js
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

import { R2 } from './r2.js'; // <<<<<< SPRÁVNÝ IMPORT – r2.js je ve STEJNÉ složce

// ---- Nastavení cesty na ffmpeg binárku ----
ffmpeg.setFfmpegPath(ffmpegPath.path);

// ---- Helpers ----
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Multer pro přijímání uploadu do paměti (buffer)
const upload = multer({ storage: multer.memoryStorage() });

// ---- Env proměnné ----
const {
  BASE_URL = '',
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_ACCOUNT_ID,
  R2_BUCKET_NAME,
  R2_ENDPOINT,
  PORT = 10000,
} = process.env;

if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_ACCOUNT_ID || !R2_BUCKET_NAME || !R2_ENDPOINT) {
  console.warn('[WARN] Chybí některé R2 proměnné. Zkontroluj v Render → Environment.');
}

// ---- Init R2 klienta ----
const r2 = new R2({
  accountId: R2_ACCOUNT_ID,
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
  bucket: R2_BUCKET_NAME,
  endpoint: R2_ENDPOINT, // např. https://<accountid>.r2.cloudflarestorage.com
});

// ---- Express ----
const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ========== Ping / zdraví / kontrola ffmpeg ==========
app.get('/', (req, res) => {
  res.json({ ok: true, name: 'melody4u-api', ts: Date.now() });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/ffmpeg-check', (req, res) => {
  try {
    const exists = fs.existsSync(ffmpegPath.path);
    res.json({ path: ffmpegPath.path, exists });
  } catch (e) {
    res.json({ path: ffmpegPath.path, exists: false, error: String(e) });
  }
});

// ========== UPLOAD ==========
/**
 * Přijme multipart/form-data s polem "file".
 * Uloží do R2 pod uploads/<uuid>-<original>.
 * Vrací { ok, key, url }
 */
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Missing file' });

    const original = (req.file.originalname || 'upload.bin').replace(/\s+/g, '-');
    const key = `uploads/${uuidv4()}-${original}`;

    await r2.putObject(key, req.file.buffer, req.file.mimetype || undefined);

    // Pokud máš public bucket/doménu – public URL:
    const url = r2.publicUrl(key);

    return res.json({ ok: true, key, url });
  } catch (err) {
    console.error('UPLOAD error:', err);
    res.status(500).json({ ok: false, error: 'Upload failed' });
  }
});

// ========== RENDER (MIX) ==========
/**
 * Body: { voiceKey: string, musicKey: string }
 * Postup:
 * 1) vygenerovat podepsané GET URL pro oba objekty na R2
 * 2) dát je ffmpegu jako HTTP input
 * 3) smíchat → MP3 → uložit do /tmp → nahrát zpět do R2 → vrátit public URL
 */
app.post('/render', async (req, res) => {
  try {
    const { voiceKey, musicKey } = req.body || {};
    if (!voiceKey || !musicKey) {
      return res.status(400).json({ ok: false, error: 'Missing voiceKey or musicKey' });
    }

    // Podepsané GET URL (platné 10 minut)
    const voiceUrl = await r2.signedUrl(voiceKey, 600);
    const musicUrl = await r2.signedUrl(musicKey, 600);

    // Dočasný soubor pro výstup
    const outFile = path.join(os.tmpdir(), `mix-${uuidv4()}.mp3`);

    // --- smíchání (stejná délka dle kratší stopy) ---
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(voiceUrl)
        .input(musicUrl)
        .complexFilter([
          // Normalizace hlasitostí a mix
          // můžeš upravit poměry volume=1.0/0.6 apod.
          '[0:a]volume=1.0[a0];[1:a]volume=0.8[a1];[a0][a1]amix=inputs=2:duration=shortest:dropout_transition=0[a]'
        ])
        .outputOptions(['-map [a]', '-ac 2', '-ar 44100', '-b:a 192k'])
        .on('error', (e) => reject(e))
        .on('end', () => resolve())
        .save(outFile);
    });

    // Nahrajeme výstup do R2
    const outKey = `output/${uuidv4()}.mp3`;
    const fileBuffer = await fs.promises.readFile(outFile);
    await r2.putObject(outKey, fileBuffer, 'audio/mpeg');

    // Smažeme lokální dočasný soubor
    try { fs.unlinkSync(outFile); } catch (e) {}

    const url = r2.publicUrl(outKey);
    return res.json({ ok: true, outKey, url });
  } catch (err) {
    console.error('RENDER error:', err);
    return res.status(500).json({ ok: false, error: 'Render failed' });
  }
});

// ========== Start ==========
app.listen(PORT, () => {
  console.log('API running on', PORT);
});
