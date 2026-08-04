// ============================================================================
// Configuración en runtime — persistida en PostgreSQL (tabla bot_settings).
// Precedencia: bot_settings (DB) > variables de entorno > defaults.
// ============================================================================
const { query } = require('./db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function splitEmails(raw) {
  if (!raw) return null;
  const list = raw.split(',').map((e) => e.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

function envDefaults() {
  return {
    escalationEmails: splitEmails(process.env.ESCALATION_EMAIL) || ['juanktrejos15@gmail.com'],
    senderEmail: process.env.RESEND_SENDER_EMAIL || 'onboarding@resend.dev',
    resendApiKey: process.env.RESEND_API_KEY || '',
    whatsappAppId: process.env.WHATSAPP_APP_ID || '',
    whatsappAppSecret: process.env.WHATSAPP_APP_SECRET || '',
    whatsappWabaId: process.env.WHATSAPP_WABA_ID || '',
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    whatsappAccessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    whatsappVerifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    whatsappPhone: process.env.WHATSAPP_PHONE || '',
    minConfidence: parseFloat(process.env.MIN_CONFIDENCE || '0'),
    maxNegativeResponses: parseInt(process.env.MAX_NEGATIVE_RESPONSES || '5', 10),
    temperature: 0.7,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
    maxTokens: parseInt(process.env.MAX_TOKENS || '2000', 10),
    topK: 3,
    maxHistoryMessages: parseInt(process.env.MAX_HISTORY_MESSAGES || '6', 10),
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

/** Carga settings desde DB, con fallback a env defaults. */
async function load(botId) {
  try {
    const { rows } = await query(
      'SELECT settings FROM bot_settings WHERE bot_id IS NOT DISTINCT FROM $1',
      [botId || null]
    );
    if (rows.length > 0) {
      return { ...envDefaults(), ...rows[0].settings };
    }
  } catch (err) {
    console.warn(`No se pudo leer settings para ${botId || 'global'} desde DB:`, err.message);
  }
  return envDefaults();
}

/** Persiste settings en DB (upsert). */
async function persist(botId, data) {
  await query(
    `INSERT INTO bot_settings (bot_id, settings)
     VALUES ($1, $2)
     ON CONFLICT (bot_id) WHERE bot_id IS NOT DISTINCT FROM $1
     DO UPDATE SET settings = $2, updated_at = NOW()`,
    [botId || null, JSON.stringify(data)]
  );
}

function cacheKey(botId) { return botId || '__global__'; }

/** Copia de los settings actuales (nunca una referencia mutable). */
async function getSettings(botId) {
  const key = cacheKey(botId);
  if (!settingsCache.has(key)) settingsCache.set(key, await load(botId));
  return { ...settingsCache.get(key) };
}

/** Aplica y persiste un subconjunto de settings. Lanza Error si algo es inválido. */
async function updateSettings(botId, patch = {}) {
  const key = cacheKey(botId);
  const current = await getSettings(botId);
  const next = { ...current };

  for (const [k, v] of Object.entries(patch)) {
    if (!(k in VALIDATORS)) throw new Error(`Parámetro desconocido: ${k}`);
    if (!VALIDATORS[k](v)) throw new Error(`Valor inválido para "${k}"`);
    next[k] = k === 'escalationEmails' ? v.map((e) => e.trim()) : v;
  }

  settingsCache.set(key, next);
  await persist(botId, next);
  return await getSettings(botId);
}

/** Elimina los settings persistidos y vuelve a env defaults. */
async function resetSettings(botId) {
  await query(
    'DELETE FROM bot_settings WHERE bot_id IS NOT DISTINCT FROM $1',
    [botId || null]
  );
  settingsCache.delete(cacheKey(botId));
  return await getSettings(botId);
}

/** Limpia la caché de settings para un bot (al eliminarlo). */
function clearSettingsCache(botId) {
  settingsCache.delete(cacheKey(botId));
}

module.exports = { getSettings, updateSettings, resetSettings, clearSettingsCache };
