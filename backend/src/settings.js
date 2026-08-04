// ============================================================================
// Configuración en runtime — persistida en data/settings.json
// (editable desde el dashboard de administración).
//
// Precedencia: data/settings.json  >  variables de entorno  >  defaults
// ============================================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitEmails(raw) {
  if (!raw) return null;
  const list = raw.split(',').map((e) => e.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

// Valores que replican el comportamiento original del código (usados cuando
// ni el archivo de settings ni las env vars proveen un valor).
function envDefaults() {
  return {
    // Correos de los asesores que reciben la notificación de escalación
    escalationEmails: splitEmails(process.env.ESCALATION_EMAIL) || ['juanktrejos15@gmail.com'],

    // Remitente usado en los correos (debe pertenecer a un dominio verificado en Resend)
    senderEmail: process.env.RESEND_SENDER_EMAIL || 'onboarding@resend.dev',

    // Similitud mínima (0-1) para considerar un fragmento relevante en la búsqueda
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0'),

    // Intentos seguidos sin respuesta clara antes de ofrecer hablar con un asesor (0 = desactivado)
    maxNegativeResponses: parseInt(process.env.MAX_NEGATIVE_RESPONSES || '5', 10),

    // Creatividad del modelo
    temperature: 0.7,

    // Modelo DeepSeek usado para el chat (flash = rápido, deepseek-chat = Pro)
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',

    // Tokens máximos de la primera respuesta
    maxTokens: 1200,

    // Fragmentos de conocimiento usados por respuesta
    topK: 3,

    // Mensajes de historial (turnos) que se envían como contexto en cada pregunta
    maxHistoryMessages: parseInt(process.env.MAX_HISTORY_MESSAGES || '6', 10),

    // Usar DeepSeek V4 Pro como reranker de los resultados
    useReranker: true,
  };
}

const ALLOWED_MODELS = ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-v3', 'deepseek-v3-lite', 'deepseek-r1'];

const VALIDATORS = {
  escalationEmails: (v) =>
    Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'string' && EMAIL_RE.test(e.trim())),
  senderEmail: (v) => typeof v === 'string' && EMAIL_RE.test(v.trim()),
  model: (v) => typeof v === 'string' && ALLOWED_MODELS.includes(v),
  minConfidence: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1,
  maxNegativeResponses: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  temperature: (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 2,
  maxTokens: (v) => Number.isInteger(v) && v >= 128 && v <= 8192,
  topK: (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  maxHistoryMessages: (v) => Number.isInteger(v) && v >= 1 && v <= 30,
  useReranker: (v) => typeof v === 'boolean',
};

let settings;

function load() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const file = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
      return { ...envDefaults(), ...file };
    }
  } catch (err) {
    console.warn('No se pudo leer data/settings.json, usando defaults:', err.message);
  }
  return envDefaults();
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/** Copia de los settings actuales (nunca una referencia mutable). */
function getSettings() {
  if (!settings) settings = load();
  return { ...settings };
}

/** Aplica y persiste un subconjunto de settings. Lanza Error si algo es inválido. */
function updateSettings(patch = {}) {
  if (!settings) settings = load();
  const next = { ...settings };

  for (const [key, value] of Object.entries(patch)) {
    if (!(key in VALIDATORS)) throw new Error(`Parámetro desconocido: ${key}`);
    if (!VALIDATORS[key](value)) throw new Error(`Valor inválido para "${key}"`);

    next[key] = key === 'escalationEmails' ? value.map((e) => e.trim()) : value;
  }

  settings = next;
  persist();
  return getSettings();
}

/** Elimina el archivo y vuelve a env vars / defaults. */
function resetSettings() {
  try {
    fs.rmSync(SETTINGS_FILE, { force: true });
  } catch (err) {
    console.warn('No se pudo eliminar data/settings.json:', err.message);
  }
  settings = envDefaults();
  return getSettings();
}

module.exports = { getSettings, updateSettings, resetSettings, SETTINGS_FILE };
