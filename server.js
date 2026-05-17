'use strict';

require('dotenv').config();

const express     = require('express');
const compression = require('compression');
const QRCode      = require('qrcode');
const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const admin       = require('firebase-admin');
const PDFDocument = require('pdfkit');
const ExcelJS     = require('exceljs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ─── Sécurité admin ─────────────────────────────────────────────────────────
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;

if (!ADMIN_PASSWORD) {
  console.warn('  [ADMIN] ADMIN_PASSWORD non défini : accès admin désactivé tant que ce mot de passe n\'est pas configuré.');
}

// ─── Firebase / Firestore ─────────────────────────────────────────────────────

let serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT || null;
if (!serviceAccountRaw && process.env.FIREBASE_SERVICE_ACCOUNT_FILE) {
  try {
    serviceAccountRaw = fs.readFileSync(process.env.FIREBASE_SERVICE_ACCOUNT_FILE, 'utf8');
  } catch {
    console.error('ERREUR : FIREBASE_SERVICE_ACCOUNT_FILE est défini, mais le fichier est introuvable ou illisible.');
    process.exit(1);
  }
}

if (!serviceAccountRaw) {
  console.error('ERREUR : La variable FIREBASE_SERVICE_ACCOUNT est manquante.');
  console.error('Astuce locale : définissez FIREBASE_SERVICE_ACCOUNT_FILE=.\\firebase-service-account.json dans .env');
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountRaw);
} catch {
  console.error('ERREUR : FIREBASE_SERVICE_ACCOUNT n\'est pas un JSON valide.');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db  = admin.firestore();
const col = db.collection('pointages');

// Préchauffage Firestore : établit la connexion dès le démarrage
// pour que la 1ère requête d'un agent ne subisse pas le délai de connexion
col.limit(1).get()
  .then(() => console.log('  Firestore connecté ✓'))
  .catch(e => console.error('  Firestore connexion échouée :', e.message));

// Helper : retourne les enregistrements triés, filtrés par date optionnelle
async function fetchRecords(date) {
  if (!date) {
    const snap = await col.orderBy('id', 'desc').limit(1000).get();
    return snap.docs.map(d => d.data());
  }

  const snap = await col.where('date', '==', date).get();
  return snap.docs
    .map(d => d.data())
    .sort((a, b) => (b.id || 0) - (a.id || 0));
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
const MAX_RADIUS_M = 20;      // rayon maximum autorisé pour le pointage QR (mètres)
const GEO_REQUIRED = true;    // GPS OBLIGATOIRE pour prouver la présence physique (sécurité anti-fraude)
const TOKEN_TTL_MS = 30_000;  // durée de vie d'un token QR (millisecondes)

// ─── Règles horaires ────────────────────────────────────────────────────────
const HEURE_DEBUT_MIN     =  8 * 60;       // 08:00 — heure de prise de poste
const HEURE_FIN_MIN        = 17 * 60 + 30;  // 17:30 — heure de fin normale (Lun-Ven)
const HEURE_FIN_SAMEDI_MIN = 12 * 60;       // 12:00 — heure de fin normale le samedi
const SEUIL_RETARD_MIN     =  9 * 60;       // 09:00 — alerte retard si arrivée > 09h00 (1h de grâce)
const HS_GRACE_MIN         = 60;            // délai supplémentaire après l'heure de fin normale

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

// Sessions de pointage actives (sessionId → {createdAt, expiresAt})
// Durée de vie d'une session : 5 minutes après le scan du QR code
const SESSION_TTL_MS = 5 * 60 * 1000;
const activeSessions = new Map();

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

/**
 * Crée une session de pointage à partir d'un token valide.
 * Retourne un sessionId unique valide pour 5 minutes.
 */
function createSession(token) {
  const sessionId = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  activeSessions.set(sessionId, {
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    token: token // stocke le token pour éviter les sessions orphelines
  });
  return sessionId;
}

/**
 * Valide et consomme une session de pointage.
 * Une session ne peut être utilisée qu'une seule fois (anti-double-pointage).
 */
function validateAndConsumeSession(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId.match(/^[0-9a-f]{32}$/)) {
    return false;
  }

  const session = activeSessions.get(sessionId);
  if (!session) return false;

  const now = Date.now();
  
  // Vérifier que la session n'a pas expiré
  if (now > session.expiresAt) {
    activeSessions.delete(sessionId);
    return false;
  }

  // Consommer la session (la supprimer pour éviter la réutilisation)
  activeSessions.delete(sessionId);
  return true;
}

/**
 * Nettoie automatiquement les sessions expirées (toutes les 30 secondes).
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions) {
    if (now > session.expiresAt) {
      activeSessions.delete(sessionId);
    }
  }
}

// Lancer le nettoyage automatique toutes les 30 secondes
setInterval(cleanupExpiredSessions, 30_000);

/**
 * Normalise un nom d'agent pour éviter les variations frauduleuses.
 * - Minuscules
 * - Accents supprimés
 * - Espaces multiples réduits à 1
 * - Caractères spéciaux supprimés
 * Exemple: "Jean-Paul Müller  " → "jean paul muller"
 */
function normalizeName(name) {
  if (!name) return '';
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')                           // décomposer accents
    .replace(/[\u0300-\u036f]/g, '')            // supprimer accents
    .replace(/[^a-z0-9\s]/g, '')                // supprimer caractères spéciaux
    .replace(/\s+/g, ' ')                       // espaces multiples → 1 seul
    .trim();
}

function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a), 'utf8');
  const bBuf = Buffer.from(String(b), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requestAdminAuth(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin Pointage", charset="UTF-8"');
  return res.status(401).send('Authentification admin requise.');
}

function getDayEndMinutes(dateFR) {
  if (!dateFR) return HEURE_FIN_MIN;
  const [d, m, y] = dateFR.split('/').map(Number);
  const day = new Date(y, m - 1, d).getDay();
  return day === 6 ? HEURE_FIN_SAMEDI_MIN : HEURE_FIN_MIN;
}

function getDayEndThresholdMinutes(dateFR) {
  return getDayEndMinutes(dateFR) + HS_GRACE_MIN;
}

function formatDayEnd(dateFR) {
  const endMin = getDayEndMinutes(dateFR);
  return `${String(Math.floor(endMin / 60)).padStart(2, '0')}h${String(endMin % 60).padStart(2, '0')}`;
}

function requireAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({
      error: 'Acces admin indisponible : ADMIN_PASSWORD non configure sur le serveur.'
    });
  }

  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) return requestAdminAuth(res);

  let decoded;
  try {
    decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
  } catch {
    return requestAdminAuth(res);
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return requestAdminAuth(res);

  const username = decoded.slice(0, sep);
  const password = decoded.slice(sep + 1);

  if (!safeCompare(username, ADMIN_USERNAME) || !safeCompare(password, ADMIN_PASSWORD)) {
    return requestAdminAuth(res);
  }

  next();
}

function isAdminProtectedPath(pathname) {
  return [
    '/admin',
    '/admin.html',
    '/records',
    '/reset',
    '/qrcode',
    '/qrcode-static',
    '/export/pdf',
    '/export/excel',
    '/alertes',
    '/rapports/heures',
    '/export/rapport/pdf',
    '/export/rapport/excel'
  ].includes(pathname);
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
app.use(compression());          // gzip — réduit la taille des réponses

// Redirection HTTP → HTTPS (Render envoie X-Forwarded-Proto)
// Indispensable : navigator.geolocation et les QR ne fonctionnent qu'en HTTPS
app.use((req, res, next) => {
  if (
    process.env.APP_URL &&                          // on est en production
    req.headers['x-forwarded-proto'] === 'http'    // requête entrante en HTTP
  ) {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});

// En-têtes de sécurité (évitent les avertissements navigateur mobile)
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains'); // HSTS 1 an
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json());
app.use((req, res, next) => {
  if (isAdminProtectedPath(req.path)) return requireAdminAuth(req, res, next);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',                  // cache navigateur 5 min pour CSS/JS/images
  etag:   true
}));

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
  if (process.env.APP_URL) {
    // Toujours forcer https:// en production — les QR http:// sont bloqués par les navigateurs mobiles
    return process.env.APP_URL.replace(/\/$/, '').replace(/^http:\/\//, 'https://');
  }
  return `http://${getLocalIP()}:${PORT}`;
}

/** Retourne l'URL de base depuis la requête courante. */
function getRequestBaseURL(req) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (host) return `${proto}://${host}`;
  return getAppBaseURL();
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
  res.setHeader('Cache-Control', 'no-store'); // jamais en cache — le token dans l'URL change toutes les 30s
  res.sendFile(path.join(__dirname, 'public', 'pointage.html'));
});

// Page kiosque — écran d'entrée (affiche le QR auto-renouvelé)
app.get('/kiosk', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'kiosk.html'));
});

// Tableau de bord administrateur
app.get('/admin', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store'); // toujours la dernière version
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * POST /init-session
 * Valide un token QR et crée une session de pointage.
 * Cette session doit être fournie au pointage pour empêcher les raccourcis.
 */
app.post('/init-session', (req, res) => {
  const { token } = req.body || {};

  if (!token) {
    return res.status(400).json({
      error: 'Token manquant. Veuillez scanner le QR code affiché à l\'écran.'
    });
  }

  if (!validateToken(token)) {
    return res.status(403).json({
      error: 'QR code expiré ou invalide. Rescannez le code affiché à l\'écran.'
    });
  }

  // Créer une session valide pour 5 minutes
  const sessionId = createSession(token);

  res.json({
    success: true,
    sessionId: sessionId,
    expiresIn_ms: SESSION_TTL_MS
  });
});

/**
 * POST /pointer
 * Enregistre la présence d'un agent.
 * La date et l'heure sont exclusivement générées par le serveur
 * → impossible pour l'agent de falsifier l'heure via son téléphone.
 */
app.post('/pointer', async (req, res) => {
  const { nom_agent: rawName, code_agent, session_id: sessionId, lat, lng, device_id, type, user_agent } = req.body || {};

  // ── 0. Validation de la session (OBLIGATOIRE pour empêcher les raccourcis) ─
  if (!sessionId) {
    return res.status(403).json({
      error: 'Session manquante. Vous devez scanner le QR code avant de pointer.'
    });
  }

  if (!validateAndConsumeSession(sessionId)) {
    return res.status(403).json({
      error: 'Session expirée ou invalide. Rescannez le QR code et réessayez.'
    });
  }

  // ── 1. Validation du nom ──────────────────────────────────────────────────
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    return res.status(400).json({ error: "Le nom de l'agent est requis." });
  }

  // ── 1b. Code agent optionnel (authentification supplémentaire) ───────────────
  // Si fourni, stocke le code; sinon marque comme 'non-authentifie'
  const agentCode = (typeof code_agent === 'string') ? code_agent.substring(0, 20) : null;

  // ── 1c. Type de pointage (arrivée ou sortie) ──────────────────────────────
  const pointageType = (type === 'sortie') ? 'sortie' : 'arrivee';
  const typeLabel    = pointageType === 'arrivee' ? "d'arrivée" : "de sortie";

  // ── 2. GÉOLOCALISATION — OBLIGATOIRE ─────────────────────────────────────
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
      error: 'Vous devriez être dans les locaux du bureau pour pointage.'
    });
  }

  // ── 3. Vérification doublon : un seul pointage par type/agent/appareil par jour ─
  // NORMALISATION DU NOM : évite les variations frauduleuses
  const nomNormalise = normalizeName(rawName);
  const nomAffiche = rawName.trim().substring(0, 100); // nom original pour affichage
  const { date, heure } = getServerDateTime();
  const did = typeof device_id === 'string' ? device_id.substring(0, 64) : null;
  const ua = typeof user_agent === 'string' ? user_agent.substring(0, 255) : 'inconnu';

  if (nomNormalise.length === 0) {
    return res.status(400).json({ error: "Nom d'agent invalide." });
  }

  try {
    // ── Lancer les 3 vérifications en parallèle ─
    const deviceQuery = did
      ? col.where('device_id', '==', did).where('date', '==', date).where('type', '==', pointageType).limit(1).get()
      : Promise.resolve({ empty: true });

    const [idSnap, byName, byDevice] = await Promise.all([
      col.orderBy('id', 'desc').limit(1).get(),
      col.where('nom_normalise', '==', nomNormalise).where('date', '==', date).where('type', '==', pointageType).limit(1).get(),
      deviceQuery
    ]);

    const id = idSnap.empty ? 1 : idSnap.docs[0].data().id + 1;

    if (!byName.empty) {
      return res.status(409).json({
        error: `Vous avez déjà effectué un pointage ${typeLabel} aujourd'hui (${date}). Impossible de faire 2 fois le même pointage.`
      });
    }
    if (!byDevice.empty) {
      return res.status(409).json({
        error: `Cet appareil a déjà été utilisé pour un pointage ${typeLabel} aujourd'hui (${date}). Appareil bloqué après le 1er pointage.`
      });
    }

    const record = {
      id,
      nom_agent: nomAffiche,
      nom_normalise: nomNormalise,            // ← NOUVEAU: nom normalisé pour vérifications
      code_agent: agentCode || 'non-fourni',  // ← NOUVEAU: authentification optionnelle
      date,
      heure,
      type: pointageType,
      device_id: did || 'inconnu',
      user_agent: ua,                          // ← NOUVEAU: trace le navigateur
      lat: latitude,                            // ← NOUVEAU: stocke localisation exacte
      lng: longitude,
      distance_m: Math.round(dist)            // ← NOUVEAU: distance vérifiée
    };
    await col.add(record);

    // ── Calcul alerte retard / heures supplémentaires ─────────────────────
    let alerte = null;
    const heureMin = timeStrToMinutes(heure);
    if (pointageType === 'arrivee' && heureMin > SEUIL_RETARD_MIN) {
      const retardMin = heureMin - HEURE_DEBUT_MIN;
      alerte = {
        type: 'retard',
        minutes: retardMin,
        message: `⚠️ Retard de ${fmtMin(retardMin)} — Arrivée à ${heure} (début prévu : 08h00).`
      };
    } else if (pointageType === 'sortie' && heureMin > getDayEndThresholdMinutes(date)) {
      const hsMin = heureMin - getDayEndMinutes(date);
      alerte = {
        type: 'heures_sup',
        minutes: hsMin,
        message: `ℹ️ Heures supplémentaires : +${fmtMin(hsMin)} — Sortie à ${heure} (fin prévue : ${formatDayEnd(date)}).`
      };
    }

    res.status(201).json({ success: true, id, nom_agent: nomAffiche, date, heure, type: pointageType, alerte });
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
app.get('/qrcode', async (req, res) => {
  const token     = currentToken();
  const now       = Date.now();
  const slot      = getSlot(now);
  const expiresIn = (slot + 1) * TOKEN_TTL_MS - now;

  const url = `${getRequestBaseURL(req)}/pointage?token=${token}`;
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
app.get('/qrcode-static', async (req, res) => {
  const url = `${getRequestBaseURL(req)}/pointage`;
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
  const colX    = [40, 230, 310, 420];
  const colW    = [185, 75, 105, 110];
  const headers = ['Nom Complet', 'Type', 'Date du jour', 'Heure'];
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
    const typeLabel = (r.type === 'sortie') ? 'Sortie' : 'Arrivée';
    drawRow(y, [r.nom_agent, typeLabel, r.date, r.heure], false);
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
    { header: 'Nom Complet',  key: 'nom',   width: 32 },
    { header: 'Type',         key: 'type',  width: 12 },
    { header: 'Date du jour', key: 'date',  width: 16 },
    { header: 'Heure',        key: 'heure', width: 14 }
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
    const typeLabel = (r.type === 'sortie') ? 'Sortie' : 'Arrivée';
    const row = ws.addRow({ nom: r.nom_agent, type: typeLabel, date: r.date, heure: r.heure });
    row.height = 18;
    const fill = idx % 2 === 0 ? 'FFF0F4F8' : 'FFFFFFFF';
    row.eachCell((cell, colNum) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { vertical: 'middle', horizontal: colNum === 1 ? 'left' : 'center' };
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

/**
 * GET /alertes
 * Retourne les alertes de retard, d'heures supplémentaires et le cumul HS mensuel par agent.
 */
app.get('/alertes', async (req, res) => {
  try {
    const snap    = await col.get();
    const records = snap.docs.map(d => d.data());

    const retards = [];
    const hsSup   = [];
    const agentHSMap = {}; // cumul HS mensuel par agent

    for (const r of records) {
      const heureMin = timeStrToMinutes(r.heure);
      const key      = r.nom_agent_lower || r.nom_agent.toLowerCase();
      const [d, m, y] = (r.date || '').split('/');
      const moisKey  = m && y ? `${m}/${y}` : '??';

      if (r.type !== 'sortie') {
        // Retard
        if (heureMin > SEUIL_RETARD_MIN) {
          retards.push({
            nom_agent:    r.nom_agent,
            date:         r.date,
            heure:        r.heure,
            retard_min:   heureMin - HEURE_DEBUT_MIN
          });
        }
      } else {
        // Heures supplémentaires
        if (heureMin > getDayEndThresholdMinutes(r.date)) {
          const hsMin = heureMin - getDayEndMinutes(r.date);
          hsSup.push({
            nom_agent: r.nom_agent,
            date:      r.date,
            heure:     r.heure,
            hs_min:    hsMin
          });
          if (!agentHSMap[key]) agentHSMap[key] = { nom_agent: r.nom_agent, mois: {} };
          agentHSMap[key].mois[moisKey] = (agentHSMap[key].mois[moisKey] || 0) + hsMin;
        }
      }
    }

    retards.sort((a, b) => parseDateFR(b.date) - parseDateFR(a.date));
    hsSup.sort((a, b) => parseDateFR(b.date) - parseDateFR(a.date));

    const cumulHS = Object.values(agentHSMap).map(agent => ({
      nom_agent: agent.nom_agent,
      mois: Object.entries(agent.mois)
        .map(([mois, minutes]) => ({ mois, minutes }))
        .sort((a, b) => {
          const [ma, ya] = a.mois.split('/').map(Number);
          const [mb, yb] = b.mois.split('/').map(Number);
          return new Date(yb, mb - 1) - new Date(ya, ma - 1);
        })
    })).sort((a, b) => a.nom_agent.localeCompare(b.nom_agent, 'fr'));

    res.json({ retards, hsSup, cumulHS });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

// ─── Helpers Rapport d'Heures ─────────────────────────────────────────────────

/** Convertit "HH:MM:SS" ou "HH:MM" en minutes */
function timeStrToMinutes(str) {
  if (!str) return 0;
  const [h, m] = str.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Convertit "DD/MM/YYYY" en timestamp pour comparaison */
function parseDateFR(str) {
  if (!str) return 0;
  const [d, m, y] = str.split('/').map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Nom du jour de la semaine depuis une date FR */
function jourSemaineFR(dateFR) {
  const [d, m, y] = dateFR.split('/').map(Number);
  return ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'][new Date(y, m - 1, d).getDay()];
}

/** Formate des minutes en "Xh MM" */
function fmtMin(min) {
  if (min === null || min === undefined) return '—';
  return `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`;
}

/**
 * Groupe les enregistrements par agent+date, apparie arrivée/sortie,
 * calcule la durée, filtre par plage de dates.
 */
function buildRapportData(records, debut, fin) {
  const debutTs = parseDateFR(debut);
  const finTs   = parseDateFR(fin);
  const agentMap = {};

  for (const r of records) {
    const ts = parseDateFR(r.date);
    if (ts < debutTs || ts > finTs) continue;
    const key = r.nom_agent_lower || r.nom_agent.toLowerCase();
    if (!agentMap[key]) agentMap[key] = { nom_agent: r.nom_agent, jours: {} };
    agentMap[key].nom_agent = r.nom_agent;
    if (!agentMap[key].jours[r.date]) agentMap[key].jours[r.date] = { arrivee: null, sortie: null };
    if (r.type === 'sortie') agentMap[key].jours[r.date].sortie  = r.heure;
    else                     agentMap[key].jours[r.date].arrivee = r.heure;
  }

  return Object.values(agentMap).map(agent => {
    const jours = Object.entries(agent.jours).map(([date, e]) => {
      let minutes = null;
      if (e.arrivee && e.sortie) {
        const diff = timeStrToMinutes(e.sortie) - timeStrToMinutes(e.arrivee);
        minutes = diff > 0 ? diff : null;
      }
      return { date, arrivee: e.arrivee, sortie: e.sortie, minutes };
    }).sort((a, b) => parseDateFR(a.date) - parseDateFR(b.date));
    return { nom_agent: agent.nom_agent, jours };
  }).sort((a, b) => a.nom_agent.localeCompare(b.nom_agent, 'fr'));
}

/**
 * GET /rapports/heures
 * Retourne tous les pointages groupés par agent/date avec les durées calculées.
 * Le client gère le filtrage par période.
 */
app.get('/rapports/heures', async (req, res) => {
  try {
    const snap    = await col.get();
    const records = snap.docs.map(d => d.data());
    // Retourner toutes les données (debut/fin = min/max du jeu de données)
    const agentMap = {};
    for (const r of records) {
      const key = r.nom_agent_lower || r.nom_agent.toLowerCase();
      if (!agentMap[key]) agentMap[key] = { nom_agent: r.nom_agent, jours: {} };
      agentMap[key].nom_agent = r.nom_agent;
      if (!agentMap[key].jours[r.date]) agentMap[key].jours[r.date] = { arrivee: null, sortie: null };
      if (r.type === 'sortie') agentMap[key].jours[r.date].sortie  = r.heure;
      else                     agentMap[key].jours[r.date].arrivee = r.heure;
    }
    const result = Object.values(agentMap).map(agent => {
      const jours = Object.entries(agent.jours).map(([date, e]) => {
        let minutes = null;
        if (e.arrivee && e.sortie) {
          const diff = timeStrToMinutes(e.sortie) - timeStrToMinutes(e.arrivee);
          minutes = diff > 0 ? diff : null;
        }
        return { date, arrivee: e.arrivee, sortie: e.sortie, minutes };
      }).sort((a, b) => parseDateFR(a.date) - parseDateFR(b.date));
      return { nom_agent: agent.nom_agent, jours };
    }).sort((a, b) => a.nom_agent.localeCompare(b.nom_agent, 'fr'));
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
});

/**
 * GET /export/rapport/pdf?debut=DD/MM/YYYY&fin=DD/MM/YYYY&titre=...
 * Export PDF du rapport d'heures par agent pour une période.
 */
app.get('/export/rapport/pdf', async (req, res) => {
  const { debut, fin, titre } = req.query;
  const dateRe = /^\d{2}\/\d{2}\/\d{4}$/;
  if (!debut || !fin || !dateRe.test(debut) || !dateRe.test(fin)) {
    return res.status(400).json({ error: 'Paramètres debut et fin requis (DD/MM/YYYY).' });
  }
  let agents;
  try {
    const snap = await col.get();
    agents = buildRapportData(snap.docs.map(d => d.data()), debut, fin);
  } catch { return res.status(500).end(); }

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="rapport_heures_${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);

  const dateExport   = new Date().toLocaleDateString('fr-FR');
  const titreDoc     = titre || 'Rapport des Heures de Travail';
  const periodeLabel = debut === fin ? `Le ${debut}` : `Du ${debut} au ${fin}`;

  doc.fillColor('#0d47a1').fontSize(18).font('Helvetica-Bold').text(titreDoc, { align: 'center' });
  doc.moveDown(0.3);
  doc.fillColor('#555').fontSize(10).font('Helvetica').text(`${periodeLabel}   |   Exporté le ${dateExport}`, { align: 'center' });
  doc.moveDown(1.2);

  const cx  = [40, 155, 255, 345, 420, 490];
  const cw  = [110, 95,  85,  70,  65,  85];
  const hdrs = ['Date', 'Arrivée', 'Sortie', 'Durée', 'Jour', 'Statut'];
  const rowH = 18;

  function drawRapportHeader(y) {
    doc.rect(40, y, 520, rowH).fill('#e8eaf6');
    doc.fillColor('#3949ab').fontSize(8).font('Helvetica-Bold');
    hdrs.forEach((h, i) => doc.text(h, cx[i] + 3, y + 5, { width: cw[i] - 4, lineBreak: false }));
    return y + rowH;
  }

  for (const agent of agents) {
    let y = doc.y;
    if (y > 680) { doc.addPage(); y = 40; }

    doc.fillColor('#0d47a1').fontSize(12).font('Helvetica-Bold').text(agent.nom_agent, 40, y);
    y += 18;
    y = drawRapportHeader(y);

    for (let idx = 0; idx < agent.jours.length; idx++) {
      if (y > 748) { doc.addPage(); y = 40; y = drawRapportHeader(y); }
      const j      = agent.jours[idx];
      const duree  = fmtMin(j.minutes);
      const statut = j.arrivee && j.sortie ? 'Complet' : j.arrivee ? 'Sans sortie' : 'Sans arr.';
      if (idx % 2 === 0) doc.rect(40, y, 520, rowH).fill('#f5f7fb');
      doc.fillColor('#333').fontSize(8).font('Helvetica');
      [j.date, j.arrivee || '—', j.sortie || '—', duree, jourSemaineFR(j.date), statut].forEach((v, i) => {
        doc.text(v, cx[i] + 3, y + 5, { width: cw[i] - 4, lineBreak: false });
      });
      y += rowH;
    }

    const totalMin = agent.jours.reduce((s, j) => s + (j.minutes || 0), 0);
    doc.rect(40, y, 520, rowH).fill('#0d47a1');
    doc.fillColor('#fff').fontSize(9).font('Helvetica-Bold');
    doc.text(
      `Total : ${agent.jours.length} jour(s) — ${fmtMin(totalMin)} de travail`,
      43, y + 5, { lineBreak: false }
    );
    y += rowH + 16;
    doc.text('', 40, y); // repositionne doc.y
    doc.moveDown(0.2);
  }
  doc.end();
});

/**
 * GET /export/rapport/excel?debut=DD/MM/YYYY&fin=DD/MM/YYYY
 * Export Excel du rapport d'heures : onglet récap + un onglet par agent.
 */
app.get('/export/rapport/excel', async (req, res) => {
  const { debut, fin } = req.query;
  const dateRe = /^\d{2}\/\d{2}\/\d{4}$/;
  if (!debut || !fin || !dateRe.test(debut) || !dateRe.test(fin)) {
    return res.status(400).json({ error: 'Paramètres debut et fin requis (DD/MM/YYYY).' });
  }
  let agents;
  try {
    const snap = await col.get();
    agents = buildRapportData(snap.docs.map(d => d.data()), debut, fin);
  } catch { return res.status(500).end(); }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Système Pointage';

  // ── Feuille récapitulative ────────────────────────────────────────────────
  const wsR = wb.addWorksheet('Récapitulatif');
  wsR.mergeCells('A1:E1');
  const rc = wsR.getCell('A1');
  rc.value = `Rapport des Heures — ${debut === fin ? debut : `${debut} au ${fin}`}`;
  rc.font  = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  rc.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };
  rc.alignment = { horizontal: 'center', vertical: 'middle' };
  wsR.getRow(1).height = 26;

  wsR.columns = [
    { key: 'nom',    width: 32 },
    { key: 'jours',  width: 14 },
    { key: 'htotal', width: 16 },
    { key: 'moy',    width: 14 },
    { key: 'incompl',width: 18 },
  ];
  const hRowR = wsR.addRow(['Agent', 'Jours pointés', 'Heures totales', 'Moy./jour', 'Incomplets']);
  hRowR.height = 20;
  hRowR.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };
    cell.font = { bold: true, color: { argb: 'FF3949AB' }, size: 10 };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });

  agents.forEach((agent, idx) => {
    const totalMin    = agent.jours.reduce((s, j) => s + (j.minutes || 0), 0);
    const joursDone   = agent.jours.filter(j => j.minutes !== null).length;
    const joursIncmpl = agent.jours.length - joursDone;
    const moy         = joursDone > 0 ? Math.round(totalMin / joursDone) : 0;
    const row = wsR.addRow({
      nom:    agent.nom_agent,
      jours:  agent.jours.length,
      htotal: fmtMin(totalMin),
      moy:    joursDone > 0 ? fmtMin(moy) : '—',
      incompl: joursIncmpl,
    });
    row.height = 18;
    const fill = idx % 2 === 0 ? 'FFF0F4F8' : 'FFFFFFFF';
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFD0D0D0' } } };
    });
    wsR.getCell(`A${row.number}`).alignment = { horizontal: 'left', vertical: 'middle' };
  });

  // ── Une feuille par agent ─────────────────────────────────────────────────
  for (const agent of agents) {
    const sheetName = agent.nom_agent.substring(0, 31).replace(/[\\/*?:[\]]/g, '_');
    const ws = wb.addWorksheet(sheetName);
    ws.mergeCells('A1:F1');
    const tc = ws.getCell('A1');
    tc.value = agent.nom_agent;
    tc.font  = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
    tc.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };
    tc.alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 24;

    ws.columns = [
      { key: 'date',    width: 14 }, { key: 'jour',    width: 8  },
      { key: 'arrivee', width: 12 }, { key: 'sortie',  width: 12 },
      { key: 'duree',   width: 12 }, { key: 'statut',  width: 16 },
    ];
    const h2 = ws.addRow(['Date', 'Jour', 'Arrivée', 'Sortie', 'Durée', 'Statut']);
    h2.height = 20;
    h2.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EAF6' } };
      cell.font = { bold: true, color: { argb: 'FF3949AB' }, size: 10 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    agent.jours.forEach((j, idx) => {
      const statut = j.arrivee && j.sortie ? '✓ Complet' : j.arrivee ? '⚠ Sans sortie' : '⚠ Sans arrivée';
      const row = ws.addRow([j.date, jourSemaineFR(j.date), j.arrivee || '—', j.sortie || '—', fmtMin(j.minutes), statut]);
      row.height = 17;
      const fill = idx % 2 === 0 ? 'FFF5F7FB' : 'FFFFFFFF';
      row.eachCell(cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } } };
      });
    });

    const totalMin = agent.jours.reduce((s, j) => s + (j.minutes || 0), 0);
    const tRow = ws.addRow([`${agent.jours.length} jour(s)`, '', '', '', fmtMin(totalMin), 'TOTAL']);
    tRow.height = 20;
    tRow.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D47A1' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="rapport_heures_${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ─── Démarrage HTTP ──────────────────────────────────────────────────────────

// Health-check — utilisé par Render et le self-ping pour garder le serveur éveillé
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: Date.now() }));

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

  // Self-ping toutes les 10 min pour éviter le sleep sur Render (plan hobby)
  if (process.env.APP_URL) {
    const PING_URL = process.env.APP_URL.replace(/\/$/, '') + '/health';
    setInterval(() => {
      fetch(PING_URL).catch(() => {}); // silencieux
    }, 10 * 60 * 1000);
    console.log(`  Self-ping actif   : ${PING_URL} (toutes les 10 min)\n`);
  }
});
