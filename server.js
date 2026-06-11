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

app.use(express.json({ limit: '10mb' }));
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
    const est = { ...req.body, id, updatedAt: now };
    if (USE_PG) {
      await pool.query(
        `INSERT INTO estimates (id, data, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET data=$2, updated_at=$3`,
        [id, est, now]
      );
      return res.json({ id, updatedAt: now });
    }
    const data = readEstimatesFile();
    data[id] = est;
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`OnSite Estimating running on port ${PORT} [${USE_PG ? 'PostgreSQL' : 'file storage'}]`);
});
