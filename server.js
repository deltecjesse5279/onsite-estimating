const express = require('express');
const basicAuth = require('express-basic-auth');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'estimates.json');
const APP_PASSWORD = process.env.APP_PASSWORD || 'deltec2024';
const APP_USER = process.env.APP_USER || 'deltec';
const DATABASE_URL = process.env.DATABASE_URL || null;

// --- Storage backend: Postgres if DATABASE_URL set, else JSON file ---
let db = null;

async function initStorage() {
  if (DATABASE_URL) {
    const { Client } = require('pg');
    db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();
    await db.query(`
      CREATE TABLE IF NOT EXISTS estimates (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('Using PostgreSQL storage');
  } else {
    // Ensure data directory exists for file fallback
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
      fs.mkdirSync(path.join(__dirname, 'data'));
    }
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(DATA_FILE, JSON.stringify({}));
    }
    console.log('Using file storage (data/estimates.json)');
  }
}

async function readEstimates() {
  if (db) {
    const res = await db.query('SELECT id, data FROM estimates');
    const out = {};
    res.rows.forEach(r => { out[r.id] = r.data; });
    return out;
  }
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return {}; }
}

async function writeEstimate(id, est) {
  if (db) {
    await db.query(
      `INSERT INTO estimates (id, data, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [id, JSON.stringify(est)]
    );
  } else {
    const all = await readEstimates();
    all[id] = est;
    fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
  }
}

async function deleteEstimate(id) {
  if (db) {
    await db.query('DELETE FROM estimates WHERE id = $1', [id]);
  } else {
    const all = await readEstimates();
    delete all[id];
    fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
  }
}

// Basic auth on everything
app.use(basicAuth({
  users: { [APP_USER]: APP_PASSWORD },
  challenge: true,
  realm: 'Deltec Estimating'
}));

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Estimates API ---

// List all estimates
app.get('/api/estimates', async (req, res) => {
  try {
    const data = await readEstimates();
    const list = Object.entries(data).map(([id, est]) => ({
      id,
      name: est.name,
      client: est.client,
      estimateNum: est.estimateNum,
      updatedAt: est.updatedAt,
      sheetCount: (est.sheets || []).length
    }));
    list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(list);
  } catch(e) {
    res.status(500).json({ error: 'Failed to read estimates' });
  }
});

// Get single estimate
app.get('/api/estimates/:id', async (req, res) => {
  try {
    const data = await readEstimates();
    const est = data[req.params.id];
    if (!est) return res.status(404).json({ error: 'Not found' });
    res.json(est);
  } catch(e) {
    res.status(500).json({ error: 'Failed to read estimate' });
  }
});

// Save estimate (create or update)
app.post('/api/estimates', async (req, res) => {
  try {
    const id = req.body.id || ('est_' + Date.now());
    const est = { ...req.body, id, updatedAt: new Date().toISOString() };
    await writeEstimate(id, est);
    res.json({ id, updatedAt: est.updatedAt });
  } catch(e) {
    res.status(500).json({ error: 'Failed to save estimate' });
  }
});

// Delete estimate
app.delete('/api/estimates/:id', async (req, res) => {
  try {
    const data = await readEstimates();
    if (!data[req.params.id]) return res.status(404).json({ error: 'Not found' });
    await deleteEstimate(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: 'Failed to delete estimate' });
  }
});

// Boot
initStorage().then(() => {
  app.listen(PORT, () => {
    console.log(`Deltec Estimating running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialise storage:', err);
  process.exit(1);
});
