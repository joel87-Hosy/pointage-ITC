'use strict';

require('dotenv').config();

const fs = require('fs');
const admin = require('firebase-admin');
const { Pool } = require('pg');

function loadFirebaseServiceAccount() {
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT || null;
  if (!raw && process.env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    raw = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8');
  }
  if (!raw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT ou FIREBASE_SERVICE_ACCOUNT_FILE est requis.');
  }
  return JSON.parse(raw);
}

async function ensureSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pointages (
      id INTEGER PRIMARY KEY,
      badge_id TEXT NOT NULL DEFAULT 'non-fourni',
      nom_agent TEXT NOT NULL,
      nom_normalise TEXT NOT NULL,
      code_agent TEXT NOT NULL DEFAULT 'non-fourni',
      date TEXT NOT NULL,
      heure TEXT NOT NULL,
      type TEXT NOT NULL,
      device_id TEXT NOT NULL DEFAULT 'inconnu',
      user_agent TEXT NOT NULL DEFAULT 'inconnu',
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      distance_m INTEGER
    );
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pointages_date ON pointages (date);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pointages_nom_date_type ON pointages (nom_normalise, date, type);');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pointages_device_date_type ON pointages (device_id, date, type);');
}

function cleanRecord(data) {
  return {
    id: Number(data.id),
    badge_id: data.badge_id || 'non-fourni',
    nom_agent: data.nom_agent || '',
    nom_normalise: data.nom_normalise || String(data.nom_agent || '').trim().toLowerCase(),
    code_agent: data.code_agent || 'non-fourni',
    date: data.date || '',
    heure: data.heure || '',
    type: data.type || 'arrivee',
    device_id: data.device_id || 'inconnu',
    user_agent: data.user_agent || 'inconnu',
    lat: data.lat ?? null,
    lng: data.lng ?? null,
    distance_m: data.distance_m ?? null
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL est requis pour PostgreSQL.');
  }

  admin.initializeApp({
    credential: admin.credential.cert(loadFirebaseServiceAccount())
  });

  const firestore = admin.firestore();
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
  });

  try {
    await ensureSchema(pool);
    const snap = await firestore.collection('pointages').get();
    let inserted = 0;
    let skipped = 0;

    for (const doc of snap.docs) {
      const record = cleanRecord(doc.data());
      if (!record.id || !record.nom_agent || !record.date || !record.heure) {
        skipped += 1;
        continue;
      }

      await pool.query(
        `INSERT INTO pointages (
          id, badge_id, nom_agent, nom_normalise, code_agent, date, heure, type,
          device_id, user_agent, lat, lng, distance_m
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (id) DO NOTHING`,
        [
          record.id,
          record.badge_id,
          record.nom_agent,
          record.nom_normalise,
          record.code_agent,
          record.date,
          record.heure,
          record.type,
          record.device_id,
          record.user_agent,
          record.lat,
          record.lng,
          record.distance_m
        ]
      );
      inserted += 1;
    }

    console.log(`Migration terminee. Documents lus: ${snap.size}, inseres/ignores si deja presents: ${inserted}, invalides: ${skipped}.`);
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
