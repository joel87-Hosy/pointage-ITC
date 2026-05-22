'use strict';

const fs = require('fs');

function toFirestoreRows(snap) {
  return snap.docs.map(d => d.data());
}

function createFirestoreStore() {
  const admin = require('firebase-admin');

  let serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT || null;
  if (!serviceAccountRaw && process.env.FIREBASE_SERVICE_ACCOUNT_FILE) {
    try {
      serviceAccountRaw = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8');
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_FILE est defini, mais le fichier est introuvable ou illisible.');
    }
  }

  if (!serviceAccountRaw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT est manquante.');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountRaw);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT n\'est pas un JSON valide.');
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  const db = admin.firestore();
  const col = db.collection('pointages');

  return {
    name: 'Firestore',

    async warmup() {
      await col.limit(1).get();
    },

    async fetchRecords(date) {
      if (!date) {
        const snap = await col.orderBy('id', 'desc').limit(1000).get();
        return toFirestoreRows(snap);
      }

      const snap = await col.where('date', '==', date).get();
      return toFirestoreRows(snap).sort((a, b) => (b.id || 0) - (a.id || 0));
    },

    async fetchAllRecords() {
      const snap = await col.get();
      return toFirestoreRows(snap);
    },

    async getNextId() {
      const snap = await col.orderBy('id', 'desc').limit(1).get();
      return snap.empty ? 1 : snap.docs[0].data().id + 1;
    },

    async hasDuplicateByName(nomNormalise, date, type) {
      const snap = await col
        .where('nom_normalise', '==', nomNormalise)
        .where('date', '==', date)
        .where('type', '==', type)
        .limit(1)
        .get();
      return !snap.empty;
    },

    async hasDuplicateByDevice(deviceId, date, type) {
      if (!deviceId) return false;
      const snap = await col
        .where('device_id', '==', deviceId)
        .where('date', '==', date)
        .where('type', '==', type)
        .limit(1)
        .get();
      return !snap.empty;
    },

    async getAgentByDevice(deviceId) {
      if (!deviceId) return null;
      const snap = await col
        .where('device_id', '==', deviceId)
        .limit(100)
        .get();
      if (snap.empty) return null;

      const rows = toFirestoreRows(snap)
        .filter(r => r.nom_agent)
        .sort((a, b) => (a.id || 0) - (b.id || 0));
      if (!rows.length) return null;

      return {
        nom_agent: rows[0].nom_agent,
        nom_normalise: rows[0].nom_normalise || null
      };
    },

    async insertRecord(record) {
      await col.add(record);
    },

    async deleteAllRecords() {
      const snap = await col.get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  };
}

function createPostgresStore() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false }
  });

  async function ensureSchema() {
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

  function rowToRecord(row) {
    return {
      id: row.id,
      badge_id: row.badge_id,
      nom_agent: row.nom_agent,
      nom_normalise: row.nom_normalise,
      code_agent: row.code_agent,
      date: row.date,
      heure: row.heure,
      type: row.type,
      device_id: row.device_id,
      user_agent: row.user_agent,
      lat: row.lat,
      lng: row.lng,
      distance_m: row.distance_m
    };
  }

  return {
    name: 'PostgreSQL',

    async warmup() {
      await ensureSchema();
      await pool.query('SELECT 1');
    },

    async fetchRecords(date) {
      await ensureSchema();
      const result = date
        ? await pool.query('SELECT * FROM pointages WHERE date = $1 ORDER BY id DESC', [date])
        : await pool.query('SELECT * FROM pointages ORDER BY id DESC LIMIT 1000');
      return result.rows.map(rowToRecord);
    },

    async fetchAllRecords() {
      await ensureSchema();
      const result = await pool.query('SELECT * FROM pointages ORDER BY id DESC');
      return result.rows.map(rowToRecord);
    },

    async getNextId() {
      await ensureSchema();
      const result = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM pointages');
      return Number(result.rows[0].next_id);
    },

    async hasDuplicateByName(nomNormalise, date, type) {
      await ensureSchema();
      const result = await pool.query(
        'SELECT 1 FROM pointages WHERE nom_normalise = $1 AND date = $2 AND type = $3 LIMIT 1',
        [nomNormalise, date, type]
      );
      return result.rowCount > 0;
    },

    async hasDuplicateByDevice(deviceId, date, type) {
      if (!deviceId) return false;
      await ensureSchema();
      const result = await pool.query(
        'SELECT 1 FROM pointages WHERE device_id = $1 AND date = $2 AND type = $3 LIMIT 1',
        [deviceId, date, type]
      );
      return result.rowCount > 0;
    },

    async getAgentByDevice(deviceId) {
      if (!deviceId) return null;
      await ensureSchema();
      const result = await pool.query(
        `SELECT nom_agent, nom_normalise
         FROM pointages
         WHERE device_id = $1
           AND nom_agent IS NOT NULL
           AND nom_agent <> ''
         ORDER BY id ASC
         LIMIT 1`,
        [deviceId]
      );
      return result.rows[0] || null;
    },

    async insertRecord(record) {
      await ensureSchema();
      await pool.query(
        `INSERT INTO pointages (
          id, badge_id, nom_agent, nom_normalise, code_agent, date, heure, type,
          device_id, user_agent, lat, lng, distance_m
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
    },

    async deleteAllRecords() {
      await ensureSchema();
      await pool.query('DELETE FROM pointages');
    }
  };
}

function createPointageStore() {
  if (process.env.DATABASE_URL) return createPostgresStore();
  return createFirestoreStore();
}

module.exports = { createPointageStore };
