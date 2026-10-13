'use strict';

require('dotenv').config();

const fs = require('fs');
const { Pool } = require('pg');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      if (row.some(value => value !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  if (field !== '' || row.length) {
    row.push(field.replace(/\r$/, ''));
    if (row.some(value => value !== '')) rows.push(row);
  }
  if (!rows.length) return [];

  const headers = rows.shift().map(header => header.trim());
  return rows.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function nullableNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Valeur numérique invalide dans le CSV: ${value}`);
  return number;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) throw new Error('Usage: node scripts/import-supabase-csv-to-postgres.js <export-pointages.csv>');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL PostgreSQL local est requis.');

  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const required = ['id', 'nom_agent', 'nom_normalise', 'code_agent', 'date', 'heure', 'type'];
  if (rows.length && required.some(column => !(column in rows[0]))) {
    throw new Error(`Le CSV doit contenir ces colonnes: ${required.join(', ')}`);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false
  });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
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
      )
    `);

    const ids = rows.map(row => Number(row.id));
    if (ids.some(id => !Number.isInteger(id) || id <= 0)) throw new Error('Le CSV contient un ID invalide.');
    if (new Set(ids).size !== ids.length) throw new Error('Le CSV contient des ID en double.');

    const existing = await client.query('SELECT COUNT(*)::int AS count FROM pointages');
    if (existing.rows[0].count > 0) {
      throw new Error('La table pointages locale n’est pas vide; import annulé pour éviter d’écraser des données.');
    }

    for (const row of rows) {
      await client.query(
        `INSERT INTO pointages (
          id, badge_id, nom_agent, nom_normalise, code_agent, date, heure, type,
          device_id, user_agent, lat, lng, distance_m
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          Number(row.id), row.badge_id || 'non-fourni', row.nom_agent, row.nom_normalise,
          row.code_agent || 'non-fourni', row.date, row.heure, row.type,
          row.device_id || 'inconnu', row.user_agent || 'inconnu',
          nullableNumber(row.lat), nullableNumber(row.lng), nullableNumber(row.distance_m)
        ]
      );
    }

    await client.query('CREATE INDEX IF NOT EXISTS idx_pointages_date ON pointages (date)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_pointages_nom_date_type ON pointages (nom_normalise, date, type)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_pointages_device_date_type ON pointages (device_id, date, type)');
    await client.query('COMMIT');
    console.log(`Import terminé : ${rows.length} pointage(s) importé(s).`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`Import annulé : ${error.message}`);
  process.exit(1);
});
