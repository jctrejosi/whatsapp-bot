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
    systemPrompt: '',
    welcomeMessage: '',
    enabledFunctions: [], // vacío = todas habilitadas; si tiene valores, solo esas
    // Datos de negocio configurables (para las calling functions)
    planPricing: null,   // { tiers: { nombre: { guest1_2: number, ... } }, ... }
    planIncludes: null,   // ["item 1", "item 2", ...]
    planItinerary: null,  // [{ dia: 1, fecha: "...", lugar: "...", evento: "..." }, ...]
    planPayments: null,   // { primerDeposito: {...}, segundoDeposito: {...}, pagoFinal: {...}, cancelacion: "..." }
  };
}

const ALLOWED_MODELS = ['deepseek-v4-flash', 'deepseek-chat', 'deepseek-v3', 'deepseek-v3-lite', 'deepseek-r1'];

const VALIDATORS = {
  escalationEmails: (v) =>
    Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'string' && EMAIL_RE.test(e.trim())),
  senderEmail: (v) => typeof v === 'string' && EMAIL_RE.test(v.trim()),
  model: (v) =>
    typeof v === 'string' &&
    v.trim().length > 0 &&
    v.trim().length <= 100 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(v.trim()),
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
  systemPrompt: (v) => typeof v === 'string',
  welcomeMessage: (v) => typeof v === 'string',
  enabledFunctions: (v) => Array.isArray(v) && v.every((f) => typeof f === 'string' && f.trim().length > 0),
  planPricing: (v) => v === null || typeof v === 'object',
  planIncludes: (v) => v === null || (Array.isArray(v) && v.every((e) => typeof e === 'string')),
  planItinerary: (v) => v === null || Array.isArray(v),
  planPayments: (v) => v === null || typeof v === 'object',
};

const settingsCache = new Map(); // key: botId || '__global__' → { data, ts }
const CACHE_TTL_MS = 5000; // 5 segundos — suficiente para no re-leer en una misma request

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

/** Persiste settings en DB (upsert manual — compatible con índices únicos parciales). */
async function persist(botId, data) {
  const payload = [botId || null, JSON.stringify(data)];
  // Actualizar si la fila existe (bot_id IS NOT DISTINCT FROM cubre NULL y UUID)
  const update = await query(
    'UPDATE bot_settings SET settings = $2, updated_at = NOW() WHERE bot_id IS NOT DISTINCT FROM $1',
    payload
  );
  // Si no existía, insertarla
  if (update.rowCount === 0) {
    await query(
      'INSERT INTO bot_settings (bot_id, settings) VALUES ($1, $2)',
      payload
    );
  }
}

function cacheKey(botId) { return botId || '__global__'; }

/** Copia de los settings actuales (nunca una referencia mutable). */
async function getSettings(botId) {
  const key = cacheKey(botId);
  const entry = settingsCache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    return { ...entry.data };
  }
  const data = await load(botId);
  settingsCache.set(key, { data, ts: Date.now() });
  return { ...data };
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

  settingsCache.set(key, { data: next, ts: Date.now() });
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

module.exports = { getSettings, updateSettings, resetSettings, clearSettingsCache, ALLOWED_MODELS };
