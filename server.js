const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Hash SHA-256 du mot de passe correcteur : Douane_CE2026
const CORRECTOR_HASH = 'af1abd791ae251219722ef2b9d30c081f5216c00df1c9506960ed5190298bb2d';

// ── BASE DE DONNÉES SQLite ────────────────────────────────────
const db = new Database(process.env.DB_PATH || './douanes.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    phase_num INTEGER,
    jour_nom TEXT,
    read_at INTEGER,
    created_at INTEGER DEFAULT (strftime('%s','now'))
  );

  CREATE TABLE IF NOT EXISTS corrections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phase_num INTEGER NOT NULL,
    jour_nom TEXT NOT NULL,
    feedback TEXT,
    corrected_at INTEGER DEFAULT (strftime('%s','now'))
  );
`);

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── API STATE ────────────────────────────────────────────────

// GET tout l'état
app.get('/api/state', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM state').all();
  const state = {};
  rows.forEach(r => {
    try { state[r.key] = JSON.parse(r.value); }
    catch { state[r.key] = r.value; }
  });
  res.json(state);
});

// POST mettre à jour une clé
app.post('/api/state', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key requis' });
  db.prepare(`
    INSERT INTO state (key, value, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, JSON.stringify(value));
  res.json({ ok: true });
});

// POST soumettre un travail → crée une notification
app.post('/api/submit', (req, res) => {
  const { phase_num, jour_nom, key, value } = req.body;

  // Sauvegarder l'état
  db.prepare(`
    INSERT INTO state (key, value, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, JSON.stringify(value));

  // Créer notification
  db.prepare(`
    INSERT INTO notifications (type, message, phase_num, jour_nom)
    VALUES ('submit', ?, ?, ?)
  `).run(
    `Travail soumis — Phase ${phase_num}, ${jour_nom}`,
    phase_num,
    jour_nom
  );

  res.json({ ok: true });
});

// ── API NOTIFICATIONS ────────────────────────────────────────

// GET notifications non lues
app.get('/api/notifications', (req, res) => {
  const notifs = db.prepare(`
    SELECT * FROM notifications
    ORDER BY created_at DESC
    LIMIT 50
  `).all();
  res.json(notifs);
});

// GET nombre de notifications non lues
app.get('/api/notifications/unread', (req, res) => {
  const { count } = db.prepare(`
    SELECT COUNT(*) as count FROM notifications WHERE read_at IS NULL
  `).get();
  res.json({ count });
});

// POST marquer comme lues
app.post('/api/notifications/read', (req, res) => {
  db.prepare(`
    UPDATE notifications SET read_at = strftime('%s','now') WHERE read_at IS NULL
  `).run();
  res.json({ ok: true });
});

// ── API CORRECTIONS ──────────────────────────────────────────

// POST appliquer une correction (nécessite mot de passe)
app.post('/api/correct', (req, res) => {
  const { password_hash, phase_num, jour_nom, feedback, key, value } = req.body;

  if (password_hash !== CORRECTOR_HASH) {
    return res.status(403).json({ error: 'Mot de passe incorrect' });
  }

  // Sauvegarder l'état corrigé
  db.prepare(`
    INSERT INTO state (key, value, updated_at)
    VALUES (?, ?, strftime('%s','now'))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, JSON.stringify(value));

  // Sauvegarder le feedback
  db.prepare(`
    INSERT INTO corrections (phase_num, jour_nom, feedback)
    VALUES (?, ?, ?)
  `).run(phase_num, jour_nom, feedback || '');

  // Créer notification pour l'élève
  db.prepare(`
    INSERT INTO notifications (type, message, phase_num, jour_nom)
    VALUES ('correction', ?, ?, ?)
  `).run(
    `Correction disponible — Phase ${phase_num}, ${jour_nom}`,
    phase_num,
    jour_nom
  );

  res.json({ ok: true });
});

// GET liste des travaux soumis (pour page correcteur)
app.get('/api/submitted', (req, res) => {
  const { password_hash } = req.query;
  if (password_hash !== CORRECTOR_HASH) {
    return res.status(403).json({ error: 'Accès refusé' });
  }

  const rows = db.prepare(`
    SELECT key, value, updated_at FROM state
    WHERE key LIKE 'p%'
    ORDER BY updated_at DESC
  `).all();

  const submitted = [];
  rows.forEach(r => {
    try {
      const v = JSON.parse(r.value);
      if (v.submitted) {
        submitted.push({
          key: r.key,
          data: v,
          updated_at: r.updated_at
        });
      }
    } catch {}
  });

  res.json(submitted);
});

// ── PING ─────────────────────────────────────────────────────
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ── FALLBACK SPA ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅ Serveur Douanes démarré sur le port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Page correcteur : http://localhost:${PORT}/correcteur.html\n`);
});
