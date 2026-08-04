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

    // API key de Resend (también configurable desde env: RESEND_API_KEY)
    resendApiKey: process.env.RESEND_API_KEY || '',

    // WhatsApp (por bot, hereda del env global si no se configura)
    whatsappAppId: process.env.WHATSAPP_APP_ID || '',
    whatsappAppSecret: process.env.WHATSAPP_APP_SECRET || '',
    whatsappWabaId: process.env.WHATSAPP_WABA_ID || '',
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    whatsappPhone: process.env.WHATSAPP_PHONE || '',

    // Similitud mínima (0-1) para considerar un fragmento relevante en la búsqueda
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0'),

    // Intentos seguidos sin respuesta clara antes de ofrecer hablar con un asesor (0 = desactivado)
    maxNegativeResponses: parseInt(process.env.MAX_NEGATIVE_RESPONSES || '5', 10),

    // Creatividad del modelo
    temperature: 0.7,

    // Modelo DeepSeek usado para el chat (flash = rápido, deepseek-chat = Pro)
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',

    // Tokens máximos de la primera respuesta
    maxTokens: parseInt(process.env.MAX_TOKENS || '2000', 10),

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
  resendApiKey: (v) => typeof v === 'string',
  whatsappAppId: (v) => typeof v === 'string',
  whatsappAppSecret: (v) => typeof v === 'string',
  whatsappWabaId: (v) => typeof v === 'string',
  whatsappPhoneNumberId: (v) => typeof v === 'string',
  whatsappAccessToken: (v) => typeof v === 'string',
  whatsappVerifyToken: (v) => typeof v === 'string',
  whatsappPhone: (v) => typeof v === 'string',
};

const settingsCache = new Map(); // key: botId || '__global__'

function getSettingsFile(botId) {
  if (botId) return path.join(DATA_DIR, `bot-${botId}`, 'settings.json');
  return SETTINGS_FILE;
}

function load(botId) {
  const file = getSettingsFile(botId);
  try {
    if (fs.existsSync(file)) {
      return { ...envDefaults(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  } catch (err) {
    console.warn(`No se pudo leer ${file}, usando defaults:`, err.message);
  }
  return envDefaults();
}

function persist(botId, data) {
  const file = getSettingsFile(botId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function cacheKey(botId) { return botId || '__global__'; }

/** Copia de los settings actuales (nunca una referencia mutable). */
function getSettings(botId) {
  const key = cacheKey(botId);
  if (!settingsCache.has(key)) settingsCache.set(key, load(botId));
  return { ...settingsCache.get(key) };
}

/** Aplica y persiste un subconjunto de settings. Lanza Error si algo es inválido. */
function updateSettings(botId, patch = {}) {
  const key = cacheKey(botId);
  const current = getSettings(botId);
  const next = { ...current };

  for (const [k, v] of Object.entries(patch)) {
    if (!(k in VALIDATORS)) throw new Error(`Parámetro desconocido: ${k}`);
    if (!VALIDATORS[k](v)) throw new Error(`Valor inválido para "${k}"`);
    next[k] = k === 'escalationEmails' ? v.map((e) => e.trim()) : v;
  }

  settingsCache.set(key, next);
  persist(botId, next);
  return getSettings(botId);
}

/** Elimina el archivo y vuelve a env vars / defaults. */
function resetSettings(botId) {
  try {
    fs.rmSync(getSettingsFile(botId), { force: true });
  } catch (err) {
    console.warn(`No se pudo eliminar archivo de settings:`, err.message);
  }
  settingsCache.delete(cacheKey(botId));
  return getSettings(botId);
}

/** Limpia la caché de settings para un bot (al eliminarlo). */
function clearSettingsCache(botId) {
  settingsCache.delete(cacheKey(botId));
}

module.exports = { getSettings, updateSettings, resetSettings, clearSettingsCache, SETTINGS_FILE };
