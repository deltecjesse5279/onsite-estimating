const express = require('express');
const basicAuth = require('express-basic-auth');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'deltec2024';
const APP_USER = process.env.APP_USER || 'deltec';

// ── Storage backend ──────────────────────────────────────────────────────────
// Uses PostgreSQL when DATABASE_URL is set (Render production),
// falls back to local JSON file for dev without a database.

const USE_PG = !!process.env.DATABASE_URL;
let pool = null;

if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  // Create tables on startup if they don't exist
  pool.query(`
    CREATE TABLE IF NOT EXISTS estimates (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS estimate_pdfs (
      estimate_id TEXT PRIMARY KEY,
      pdf_data BYTEA NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `).catch(err => console.error('DB init error:', err));
}

// ── Anthropic client ──────────────────────────────────────────────────────────
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── File fallback (local dev) ─────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, 'data', 'estimates.json');
const PDF_DIR   = path.join(__dirname, 'data', 'pdfs');

if (!USE_PG) {
  if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({}));
  if (!fs.existsSync(PDF_DIR))   fs.mkdirSync(PDF_DIR, { recursive: true });
}

function readEstimatesFile() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function writeEstimatesFile(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Express setup ─────────────────────────────────────────────────────────────
app.use(basicAuth({
  users: { [APP_USER]: APP_PASSWORD },
  challenge: true,
  realm: 'OnSite Estimating'
}));

app.use(express.json({ limit: '20mb' }));
app.use('/api/estimates/:id/pdf', express.raw({ type: 'application/pdf', limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Estimates API ─────────────────────────────────────────────────────────────

// List all estimates
app.get('/api/estimates', async (req, res) => {
  try {
    if (USE_PG) {
      const result = await pool.query(
        `SELECT id, data->>'name' AS name, data->>'client' AS client,
                data->>'estimateNum' AS "estimateNum",
                data->>'status' AS status,
                data->>'total' AS total,
                updated_at AS "updatedAt",
                jsonb_array_length(COALESCE(data->'sheets', '[]'::jsonb)) AS "sheetCount"
         FROM estimates ORDER BY updated_at DESC`
      );
      return res.json(result.rows);
    }
    const data = readEstimatesFile();
    const list = Object.entries(data).map(([id, est]) => ({
      id, name: est.name, client: est.client,
      estimateNum: est.estimateNum, status: est.status, total: est.total,
      updatedAt: est.updatedAt,
      sheetCount: (est.sheets || []).length
    }));
    list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get single estimate
app.get('/api/estimates/:id', async (req, res) => {
  try {
    if (USE_PG) {
      const result = await pool.query('SELECT data FROM estimates WHERE id=$1', [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json(result.rows[0].data);
    }
    const data = readEstimatesFile();
    const est = data[req.params.id];
    if (!est) return res.status(404).json({ error: 'Not found' });
    res.json(est);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Save estimate (create or update)
app.post('/api/estimates', async (req, res) => {
  try {
    const id = req.body.id || ('est_' + Date.now());
    const now = new Date().toISOString();
    const incoming = { ...req.body, id, updatedAt: now };
    if (USE_PG) {
      // Merge at the DB level so a save from a client that only knows about
      // some fields (index.html, for example, never sends drawingsState)
      // can't wipe out fields it doesn't carry. On a brand-new id this is a
      // plain insert; on conflict, existing JSONB is merged with incoming,
      // with incoming's keys winning on overlap.
      await pool.query(
        `INSERT INTO estimates (id, data, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET data = estimates.data || $2::jsonb, updated_at=$3`,
        [id, incoming, now]
      );
      return res.json({ id, updatedAt: now });
    }
    const data = readEstimatesFile();
    data[id] = { ...(data[id] || {}), ...incoming };
    writeEstimatesFile(data);
    res.json({ id, updatedAt: now });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Patch estimate (partial merge — e.g. status changes from the projects list).
// Deliberately does NOT bump updated_at, so a quick status flip doesn't
// reorder the list under the default "most recently updated" sort.
app.patch('/api/estimates/:id', async (req, res) => {
  try {
    const fields = req.body || {};
    if (USE_PG) {
      const result = await pool.query(
        `UPDATE estimates SET data = data || $2::jsonb
         WHERE id=$1 RETURNING id`,
        [req.params.id, fields]
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true });
    }
    const data = readEstimatesFile();
    if (!data[req.params.id]) return res.status(404).json({ error: 'Not found' });
    data[req.params.id] = { ...data[req.params.id], ...fields };
    writeEstimatesFile(data);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete estimate
app.delete('/api/estimates/:id', async (req, res) => {
  try {
    if (USE_PG) {
      const result = await pool.query('DELETE FROM estimates WHERE id=$1 RETURNING id', [req.params.id]);
      if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
      await pool.query('DELETE FROM estimate_pdfs WHERE estimate_id=$1', [req.params.id]);
      return res.json({ ok: true });
    }
    const data = readEstimatesFile();
    if (!data[req.params.id]) return res.status(404).json({ error: 'Not found' });
    delete data[req.params.id];
    writeEstimatesFile(data);
    const pdfPath = path.join(PDF_DIR, req.params.id + '.pdf');
    if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PDF API ───────────────────────────────────────────────────────────────────

// Upload PDF
app.post('/api/estimates/:id/pdf', async (req, res) => {
  const id = req.params.id;
  if (!Buffer.isBuffer(req.body) || req.body.length === 0)
    return res.status(400).json({ error: 'No PDF data' });
  try {
    if (USE_PG) {
      await pool.query(
        `INSERT INTO estimate_pdfs (estimate_id, pdf_data, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (estimate_id) DO UPDATE SET pdf_data=$2, updated_at=NOW()`,
        [id, req.body]
      );
      return res.json({ ok: true, size: req.body.length });
    }
    fs.writeFileSync(path.join(PDF_DIR, id + '.pdf'), req.body);
    res.json({ ok: true, size: req.body.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Download PDF
app.get('/api/estimates/:id/pdf', async (req, res) => {
  const id = req.params.id;
  try {
    if (USE_PG) {
      const result = await pool.query('SELECT pdf_data FROM estimate_pdfs WHERE estimate_id=$1', [id]);
      if (!result.rows.length) return res.status(404).json({ error: 'No PDF' });
      res.setHeader('Content-Type', 'application/pdf');
      return res.send(result.rows[0].pdf_data);
    }
    const pdfPath = path.join(PDF_DIR, id + '.pdf');
    if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'No PDF' });
    res.setHeader('Content-Type', 'application/pdf');
    res.sendFile(pdfPath);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Check if PDF exists
app.head('/api/estimates/:id/pdf', async (req, res) => {
  const id = req.params.id;
  try {
    if (USE_PG) {
      const result = await pool.query(
        'SELECT octet_length(pdf_data) AS size FROM estimate_pdfs WHERE estimate_id=$1', [id]
      );
      if (!result.rows.length) return res.status(404).end();
      res.setHeader('Content-Length', result.rows[0].size);
      return res.end();
    }
    const pdfPath = path.join(PDF_DIR, id + '.pdf');
    if (!fs.existsSync(pdfPath)) return res.status(404).end();
    res.setHeader('Content-Length', fs.statSync(pdfPath).size);
    res.end();
  } catch(e) { res.status(500).end(); }
});

// ── Auto Count API ────────────────────────────────────────────────────────────

// Stage 1: characterize the reference symbol
// Receives: { refImage: base64 PNG string (no data URL prefix) }
// Returns:  { ok: true, character: { suggested_name, key_features, ... } }
app.post('/api/symbols/characterize', async (req, res) => {
  const { refImage } = req.body;
  if (!refImage) return res.status(400).json({ error: 'refImage required' });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: refImage }
          },
          {
            type: 'text',
            text: `You are an electrical estimator's assistant analyzing a SINGLE symbol cropped from an electrical construction drawing (floor plans, panel schedules, riser diagrams). The symbol follows standard North American electrical drafting conventions.

Identify it and describe its visual structure so it can be detected automatically elsewhere on the same drawing set.

HARD RULES:
- This is ALWAYS an electrical drawing symbol. Names from software, web design, UI, or any unrelated domain (for example "loading spinner", "progress indicator", "button") are NEVER valid answers. If you are unsure, give a functional ELECTRICAL description, never a non-electrical guess.
- suggested_name: use the standard electrical convention name when recognizable (for example "Duplex receptacle 15A", "Single-pole switch", "Recessed light fixture", "Smoke detector", "Data/comms outlet", "Panelboard"). If not confidently recognizable, give a short functional electrical description such as "Ceiling-mounted circular device".
- category: classify into one of Power, Lighting, Fire Alarm, Auxiliary/Comms, Exit/Emergency, Security, or Unknown.
- too_complex: set true if the crop contains more than one distinct symbol, a wiring or schematic region, a legend block, or mostly text, rather than one discrete symbol. When true, automated detection will be unreliable and the user should re-crop tighter around a single symbol.

Return ONLY a valid JSON object, no explanation, no markdown fences:
{
  "suggested_name": "electrical convention name, or a functional electrical description if unsure",
  "category": "Power | Lighting | Fire Alarm | Auxiliary/Comms | Exit/Emergency | Security | Unknown",
  "too_complex": true or false,
  "primary_shape": "dominant shape description",
  "key_features": ["up to 5 specific visual features that define this symbol"],
  "has_circle": true or false,
  "has_arc": true or false,
  "line_count": approximate number of distinct lines as integer,
  "aspect_ratio": "W:H e.g. 1:1 or 2:1",
  "is_symmetric": true or false,
  "do_not_confuse_with": ["2 to 3 OTHER electrical symbols that look similar but should NOT match"]
}`
          }
        ]
      }]
    });

    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    const character = JSON.parse(raw);
    res.json({ ok: true, character });

  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Stage 2: scan a single tile for symbol matches
// Receives: { tileImage: base64 PNG, refImage: base64 PNG, character: object }
// Returns:  { ok: true, matches: [{ x, y, w, h, confidence, partial, rotation }] }
app.post('/api/symbols/scan-tile', async (req, res) => {
  const { tileImage, refImage, character } = req.body;
  if (!tileImage || !refImage || !character) {
    return res.status(400).json({ error: 'tileImage, refImage, and character are required' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'REFERENCE SYMBOL — this is what you are looking for:'
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: refImage }
          },
          {
            type: 'text',
            text: `SYMBOL CHARACTERISTICS:\n${JSON.stringify(character, null, 2)}\n\nDRAWING TILE — scan this image for matches:`
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: tileImage }
          },
          {
            type: 'text',
            text: `TASK: Find every instance of the reference symbol in the drawing tile.

INCLUDE matches that are:
- Rotated at any angle
- Scaled up to 30% larger or smaller than the reference
- Adjacent to text labels or dimension strings
- Partially cut off at a tile edge — mark these "partial": true

EXCLUDE anything that:
- Is a different symbol type even if it shares one feature
- Is text, a dimension, a north arrow, or a title block element
- Appears in the do_not_confuse_with list above

Return pixel coordinates relative to this tile image.
Return ONLY this JSON — no explanation, no markdown fences:
{
  "matches": [
    {
      "x": left edge in pixels,
      "y": top edge in pixels,
      "w": width in pixels,
      "h": height in pixels,
      "confidence": 0.0 to 1.0,
      "partial": false,
      "rotation": estimated degrees from upright
    }
  ]
}

If no matches found return: {"matches": []}`
          }
        ]
      }]
    });

    const raw = response.content[0].text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(raw);
    res.json({ ok: true, matches: result.matches || [] });

  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`OnSite Estimating running on port ${PORT} [${USE_PG ? 'PostgreSQL' : 'file storage'}]`);
});
