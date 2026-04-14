const express = require('express');
const basicAuth = require('express-basic-auth');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'estimates.json');
const APP_PASSWORD = process.env.APP_PASSWORD || 'deltec2024';
const APP_USER = process.env.APP_USER || 'deltec';

// Ensure data directory exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'));
}
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({}));
}

// Basic auth on everything
app.use(basicAuth({
  users: { [APP_USER]: APP_PASSWORD },
  challenge: true,
  realm: 'Deltec Estimating'
}));

app.use(express.json({ limit: '5mb' }));
app.use('/api/estimates/:id/pdf', express.raw({ type: 'application/pdf', limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PDF_DIR = path.join(__dirname, 'data', 'pdfs');
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// --- Estimates API ---

function readEstimates() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeEstimates(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// List all estimates
app.get('/api/estimates', (req, res) => {
  const data = readEstimates();
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
});

// Get single estimate
app.get('/api/estimates/:id', (req, res) => {
  const data = readEstimates();
  const est = data[req.params.id];
  if (!est) return res.status(404).json({ error: 'Not found' });
  res.json(est);
});

// Save estimate (create or update)
app.post('/api/estimates', (req, res) => {
  const data = readEstimates();
  const id = req.body.id || ('est_' + Date.now());
  data[id] = {
    ...req.body,
    id,
    updatedAt: new Date().toISOString()
  };
  writeEstimates(data);
  res.json({ id, updatedAt: data[id].updatedAt });
});

// Upload PDF for an estimate
app.post('/api/estimates/:id/pdf', (req, res) => {
  const id = req.params.id;
  if (!Buffer.isBuffer(req.body) || req.body.length === 0)
    return res.status(400).json({ error: 'No PDF data' });
  const pdfPath = path.join(PDF_DIR, id + '.pdf');
  try {
    fs.writeFileSync(pdfPath, req.body);
    res.json({ ok: true, size: req.body.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Download PDF for an estimate
app.get('/api/estimates/:id/pdf', (req, res) => {
  const pdfPath = path.join(PDF_DIR, req.params.id + '.pdf');
  if (!fs.existsSync(pdfPath)) return res.status(404).json({ error: 'No PDF' });
  res.setHeader('Content-Type', 'application/pdf');
  res.sendFile(pdfPath);
});

// Check if PDF exists for an estimate
app.head('/api/estimates/:id/pdf', (req, res) => {
  const pdfPath = path.join(PDF_DIR, req.params.id + '.pdf');
  if (!fs.existsSync(pdfPath)) return res.status(404).end();
  const stat = fs.statSync(pdfPath);
  res.setHeader('Content-Length', stat.size);
  res.end();
});

// Delete estimate
app.delete('/api/estimates/:id', (req, res) => {
  const data = readEstimates();
  if (!data[req.params.id]) return res.status(404).json({ error: 'Not found' });
  delete data[req.params.id];
  writeEstimates(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Deltec Estimating running on port ${PORT}`);
});
