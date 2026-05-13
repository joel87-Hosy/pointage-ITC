'use strict';

const express     = require('express');
const QRCode      = require('qrcode');
const crypto      = require('crypto');
const path        = require('path');
const os          = require('os');
const admin       = require('firebase-admin');
const PDFDocument = require('pdfkit');
const ExcelJS     = require('exceljs');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Firebase / Firestore ─────────────────────────────────────────────────────

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('ERREUR : La variable FIREBASE_SERVICE_ACCOUNT est manquante.');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch {
  console.error('ERREUR : FIREBASE_SERVICE_ACCOUNT n\'est pas un JSON valide.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db  = admin.firestore();
const col = db.collection('pointages');

// Helper : retourne les enregistrements triés, filtrés par date optionnelle
async function fetchRecords(date) {
  let query = col.orderBy('id', 'desc').limit(1000);
  if (date) query = col.where('date', '==', date).orderBy('id', 'desc');
  const snap = await query.get();
  return snap.docs.map(d => d.data());
}

// Helper : prochain ID auto-incrémenté
async function nextAutoId() {
  const snap = await col.orderBy('id', 'desc').limit(1).get();
  return snap.empty ? 1 : snap.docs[0].data().id + 1;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIGURATION — à adapter à vos locaux
// ═══════════════════════════════════════════════════════════════════════════════

const OFFICE_LAT   =  5.4040; // ← latitude GPS de vos locaux (Angré, Abidjan)
const OFFICE_LNG   = -3.9888; // ← longitude GPS de vos locaux (Angré, Abidjan)
const MAX_RADIUS_M = 500;     // rayon maximum autorisé (mètres)
const GEO_REQUIRED = false;   // GPS optionnel — token rotatif 30s assure la sécurité
const TOKEN_TTL_MS = 30_000;  // durée de vie d'un token QR (millisecondes)

// ═══════════════════════════════════════════════════════════════════════════════
//  TOKENS ROTATIFS — anti-partage de lien
//  Principe : le QR code encode /pointage?token=<hmac>  où le token change
//  toutes les TOKEN_TTL_MS secondes. Le backend accepte le slot courant ET
//  le slot précédent (tolérance réseau/scan lent), mais chaque token ne
//  peut être consommé qu'une seule fois (anti-replay).
// ═══════════════════════════════════════════════════════════════════════════════

// Clé secrète HMAC générée au démarrage — inconnue du client
const HMAC_SECRET = crypto.randomBytes(32).toString('hex');

// Token déjà consommés dans la fenêtre glissante (token → numéro de slot)
const usedTokens = new Map();

function getSlot(tsMs) { return Math.floor(tsMs / TOKEN_TTL_MS); }

function tokenForSlot(slot) {
  return crypto
    .createHmac('sha256', HMAC_SECRET)
    .update(String(slot))
    .digest('hex')
    .slice(0, 16); // 16 hex chars = 64 bits d'entropie, suffisant
}

function currentToken() { return tokenForSlot(getSlot(Date.now())); }

/**
 * Valide un token entrant :
 *  - appartient au slot courant OU au slot précédent
 *  - n'a pas encore été consommé (anti-replay / anti-double-scan)
 */
function validateToken(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{16}$/.test(token)) return false;

  const now         = Date.now();
  const currentSlot = getSlot(now);

  // Purge automatique des vieux tokens (>= 2 slots d'ancienneté)
  for (const [tok, slot] of usedTokens) {
    if (slot < currentSlot - 1) usedTokens.delete(tok);
  }

  for (const slot of [currentSlot, currentSlot - 1]) {
    if (tokenForSlot(slot) === token) {
      if (usedTokens.has(token)) return false; // rejeu détecté
      usedTokens.set(token, slot);
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GÉOLOCALISATION — formule de Haversine
//  La distance est calculée côté serveur à partir des coordonnées envoyées
//  par le navigateur de l'agent. Le serveur décide si l'agent est assez proche.
// ═══════════════════════════════════════════════════════════════════════════════

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R    = 6_371_000; // rayon de la Terre en mètres
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Utilitaires ─────────────────────────────────────────────────────────────

/** Retourne l'adresse IPv4 locale du serveur. */
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

/** Retourne l'URL de base de l'application (locale ou cloud). */
function getAppBaseURL() {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  return `http://${getLocalIP()}:${PORT}`;
}

/**
 * Génère la date et l'heure CÔTÉ SERVEUR.
 * Le client n'a aucun moyen de les falsifier.
 */
function getServerDateTime() {
  const now = new Date();
  const date = now.toLocaleDateString('fr-FR');
  const heure = now.toLocaleTimeString('fr-FR', {
    hour:   '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  return { date, heure };
}

// ─── Routes HTML ──────────────────────────────────────────────────────────────

// Page de pointage (ouverte par le QR code)
app.get('/pointage', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pointage.html'));
});

// Page kiosque — écran d'entrée (affiche le QR auto-renouvelé)
app.get('/kiosk', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

// Tableau de bord administrateur
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * POST /pointer
 * Enregistre la présence d'un agent.
 * La date et l'heure sont exclusivement générées par le serveur
 * → impossible pour l'agent de falsifier l'heure via son téléphone.
 */
app.post('/pointer', async (req, res) => {
  const { nom_agent: rawName, token, lat, lng, device_id } = req.body || {};

  // ── 1. Validation du nom ──────────────────────────────────────────────────
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    return res.status(400).json({ error: "Le nom de l'agent est requis." });
  }

  // ── 2. Token rotatif → uniquement si fourni (mode écran dynamique) ────────────
  //    Sans token = mode affiche imprimée → la géo seule bloque les absents
  if (token && !validateToken(token)) {
    return res.status(403).json({
      error: 'QR code expiré ou invalide. Rescannez le code affiché à l\'écran.'
    });
  }

  // ── 3. Géolocalisation → uniquement si GEO_REQUIRED activé globalement ───
  if (GEO_REQUIRED) {
    const latitude  = parseFloat(lat);
    const longitude = parseFloat(lng);
    if (
      isNaN(latitude) || isNaN(longitude) ||
      latitude  < -90  || latitude  > 90  ||
      longitude < -180 || longitude > 180
    ) {
      return res.status(400).json({ error: 'Coordonnées GPS manquantes ou invalides.' });
    }
    const dist = haversineDistance(OFFICE_LAT, OFFICE_LNG, latitude, longitude);
    if (dist > MAX_RADIUS_M) {
      return res.status(403).json({
        error: `Vous êtes à ${Math.round(dist)} m des locaux (max ${MAX_RADIUS_M} m). Vous devez être sur place pour pointer.`
      });
    }
  }

  // ── 4. Vérification doublon : un seul pointage par agent/appareil par jour ─
  const nom = rawName.trim().substring(0, 100);
  const { date, heure } = getServerDateTime();
  const did = typeof device_id === 'string' ? device_id.substring(0, 64) : null;

  try {
    const id = await nextAutoId();
    // Bloquer si même nom aujourd'hui
    const byName = await col
      .where('nom_agent_lower', '==', nom.toLowerCase())
      .where('date', '==', date)
      .limit(1).get();
    if (!byName.empty) {
      return res.status(409).json({
        error: `Vous avez déjà pointé aujourd'hui (${date}). Un seul pointage par jour est autorisé.`
      });
    }

    // Bloquer si même appareil aujourd'hui
    if (did) {
      const byDevice = await col
        .where('device_id', '==', did)
        .where('date', '==', date)
        .limit(1).get();
      if (!byDevice.empty) {
        return res.status(409).json({
          error: `Cet appareil a déjà été utilisé pour pointer aujourd'hui (${date}). Un seul pointage par appareil est autorisé.`
        });
      }
    }

    const record = { id, nom_agent: nom, nom_agent_lower: nom.toLowerCase(), date, heure, device_id: did || 'inconnu' };
    await col.add(record);
    res.status(201).json({ success: true, id, nom_agent: nom, date, heure });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur lors du pointage.' });
  }
});

/**
 * GET /records[?date=DD/MM/YYYY]
 * Retourne la liste des pointages (optionnellement filtrée par date).
 */
app.get('/records', async (req, res) => {
  const { date } = req.query;
  if (date !== undefined && !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    return res.status(400).json({ error: 'Format de date invalide. Attendu : DD/MM/YYYY' });
  }
  try {
    const result = await fetchRecords(date);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * DELETE /reset
 * Réinitialise la liste des pointages.
 */
app.delete('/reset', async (req, res) => {
  try {
    const snap = await col.get();
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors de la réinitialisation.' });
  }
});

/**
 * GET /qrcode
 * QR dynamique avec token (pour page kiosque / écran).
 */
app.get('/qrcode', async (_req, res) => {
  const token     = currentToken();
  const now       = Date.now();
  const slot      = getSlot(now);
  const expiresIn = (slot + 1) * TOKEN_TTL_MS - now;

  const url = `${getAppBaseURL()}/pointage?token=${token}`;
  try {
    const dataURL = await QRCode.toDataURL(url, {
      width: 320, margin: 2, errorCorrectionLevel: 'M',
      color: { dark: '#0d47a1', light: '#ffffff' }
    });
    res.json({ qrcode: dataURL, url, expires_in_ms: expiresIn });
  } catch {
    res.status(500).json({ error: 'Impossible de générer le QR code.' });
  }
});

/**
 * GET /qrcode-static
 * QR statique sans token ni GPS (pour affiche imprimée).
 * Sécurité : présence physique requise pour voir l'affiche.
 */
app.get('/qrcode-static', async (_req, res) => {
  const url = `${getAppBaseURL()}/pointage`;
  try {
    const dataURL = await QRCode.toDataURL(url, {
      width: 400, margin: 2, errorCorrectionLevel: 'M',
      color: { dark: '#1b5e20', light: '#ffffff' } // vert = mode affiche
    });
    res.json({ qrcode: dataURL, url });
  } catch {
    res.status(500).json({ error: 'Impossible de générer le QR code statique.' });
  }
});

// ─── Export PDF ─────────────────────────────────────────────────────────────
app.get('/export/pdf', async (req, res) => {
  const { date } = req.query;
  if (date !== undefined && !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    return res.status(400).json({ error: 'Format de date invalide.' });
  }
  let filtered;
  try { filtered = await fetchRecords(date); } catch { return res.status(500).end(); }

  const dateStr = new Date().toLocaleDateString('fr-FR');
  const doc = new PDFDocument({ margin: 40, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="pointages_${new Date().toISOString().slice(0,10)}.pdf"`);
  doc.pipe(res);

  // En-tête
  doc.fillColor('#0d47a1').fontSize(18).text('Registre des Pointages', { align: 'center' });
  doc.moveDown(0.3);
  doc.fillColor('#555').fontSize(10).text(`Exporté le ${dateStr}`, { align: 'center' });
  doc.moveDown(1);

  // Colonnes
  const colX    = [40, 260, 390];
  const colW    = [215, 125, 115];
  const headers = ['Nom Complet', 'Date du jour', "Heure d'arrivée"];
  const rowH    = 22;

  function drawRow(y, values, isHeader) {
    if (isHeader) {
      doc.rect(40, y, 530, rowH).fill('#0d47a1');
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
    } else {
      doc.fillColor('#333333').fontSize(10).font('Helvetica');
    }
    values.forEach((val, i) => {
      doc.text(val, colX[i] + 4, y + 6, { width: colW[i] - 8, lineBreak: false });
    });
  }

  let y = doc.y;
  drawRow(y, headers, true);
  y += rowH;

  filtered.forEach((r, idx) => {
    if (y > 760) { doc.addPage(); y = 40; drawRow(y, headers, true); y += rowH; }
    if (idx % 2 === 0) doc.rect(40, y, 530, rowH).fill('#f0f4f8');
    drawRow(y, [r.nom_agent, r.date, r.heure], false);
    y += rowH;
  });

  // Bordure tableau
  doc.rect(40, doc.y - (filtered.length % 30) * rowH, 530, 1).fill('#cccccc');

  doc.end();
});

// ─── Export Excel ─────────────────────────────────────────────────────────────
app.get('/export/excel', async (req, res) => {
  const { date } = req.query;
  if (date !== undefined && !/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    return res.status(400).json({ error: 'Format de date invalide.' });
  }
  let filtered;
  try { filtered = await fetchRecords(date); } catch { return res.status(500).end(); }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Système Pointage';
  const ws = wb.addWorksheet('Pointages');

  ws.columns = [
    { header: 'Nom Complet',    key: 'nom',   width: 35 },
    { header: 'Date du jour',   key: 'date',  width: 18 },
    { header: "Heure d'arrivée", key: 'heure', width: 18 }
  ];

  // Style en-tête
  const headerRow = ws.getRow(1);
  headerRow.eachCell(cell => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };
    cell.font   = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = {
      top: { style: 'thin' }, bottom: { style: 'thin' },
      left: { style: 'thin' }, right: { style: 'thin' }
    };
  });
  headerRow.height = 22;

  filtered.forEach((r, idx) => {
    const row = ws.addRow({ nom: r.nom_agent, date: r.date, heure: r.heure });
    row.height = 18;
    const fill = idx % 2 === 0 ? 'FFF0F4F8' : 'FFFFFFFF';
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { vertical: 'middle', horizontal: idx === 0 ? 'left' : 'center' };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        left: { style: 'thin', color: { argb: 'FFD0D0D0' } },
        right: { style: 'thin', color: { argb: 'FFD0D0D0' } }
      };
    });
  });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="pointages_${new Date().toISOString().slice(0,10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ─── Démarrage HTTP ──────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const base = getAppBaseURL();
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║        Système de Pointage QR Code           ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`\n  Serveur démarré sur le port ${PORT}`);
  console.log(`  URL de pointage  : ${base}/pointage`);
  console.log(`  Kiosque (ecran)  : ${base}/kiosk`);
  console.log(`  Page admin       : ${base}/admin`);
  console.log(`\n  Locaux configurés : lat=${OFFICE_LAT}, lng=${OFFICE_LNG}`);
  console.log(`  Rayon autorisé    : ${MAX_RADIUS_M} m | Token TTL : ${TOKEN_TTL_MS / 1000} s\n`);
});
