const axios = require('axios');

const API_VERSION = 'v22.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

// Caché por botId (o 'global') para tokens y phone number IDs
const tokenCache = new Map();
const phoneIdCache = new Map();

function defaults() {
  return {
    appId: process.env.WHATSAPP_APP_ID,
    appSecret: process.env.WHATSAPP_APP_SECRET,
    wabaId: process.env.WHATSAPP_WABA_ID,
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    phone: process.env.WHATSAPP_PHONE,
  };
}

/**
 * Build config object from bot settings (per-bot) or env vars (global fallback).
 * @param {object} [settings] — getSettings(botId) result
 */
function buildConfig(settings) {
  if (!settings) return defaults();
  return {
    appId: settings.whatsappAppId || process.env.WHATSAPP_APP_ID,
    appSecret: settings.whatsappAppSecret || process.env.WHATSAPP_APP_SECRET,
    wabaId: settings.whatsappWabaId || process.env.WHATSAPP_WABA_ID,
    phoneNumberId: settings.whatsappPhoneNumberId || process.env.WHATSAPP_PHONE_NUMBER_ID,
    accessToken: settings.whatsappAccessToken || process.env.WHATSAPP_ACCESS_TOKEN,
    verifyToken: settings.whatsappVerifyToken || process.env.WHATSAPP_VERIFY_TOKEN,
    phone: settings.whatsappPhone || process.env.WHATSAPP_PHONE,
  };
}

/**
 * Get (and cache) an access token for a bot config.
 */
async function getAccessToken(config) {
  const key = config.phoneNumberId || 'global';
  if (tokenCache.has(key)) return tokenCache.get(key);
  if (config.accessToken) {
    tokenCache.set(key, config.accessToken);
    return config.accessToken;
  }

  const { data } = await axios.get(`https://graph.facebook.com/oauth/access_token`, {
    params: { client_id: config.appId, client_secret: config.appSecret, grant_type: 'client_credentials' },
  });
  tokenCache.set(key, data.access_token);
  console.log('Token de acceso generado desde App ID + Secret');
  return data.access_token;
}

/**
 * Discover the phone number ID from the WABA (and cache it).
 */
async function getPhoneNumberId(config) {
  const key = config.wabaId || 'global';
  if (phoneIdCache.has(key)) return phoneIdCache.get(key);
  if (config.phoneNumberId) {
    phoneIdCache.set(key, config.phoneNumberId);
    return config.phoneNumberId;
  }

  const token = await getAccessToken(config);
  const { data } = await axios.get(`${BASE_URL}/${config.wabaId}/phone_numbers`, {
    params: { access_token: token },
  });

  const numbers = data.data || [];
  if (numbers.length === 0) throw new Error('No se encontraron números de teléfono en esta cuenta');

  const preferred = numbers.find((n) => n.display_phone_number === config.phone) || numbers[0];
  phoneIdCache.set(key, preferred.id);
  console.log(`Número WhatsApp detectado: ${preferred.display_phone_number} (ID: ${preferred.id})`);
  return preferred.id;
}

async function sendMessage(to, text, settings) {
  const cfg = buildConfig(settings);
  const token = await getAccessToken(cfg);
  const phoneNumberId = await getPhoneNumberId(cfg);

  const { data } = await axios.post(`${BASE_URL}/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text',
    text: { body: text },
  }, { headers: { Authorization: `Bearer ${token}` } });
  return data;
}

async function markAsRead(sender, messageId, settings) {
  const cfg = buildConfig(settings);
  const token = await getAccessToken(cfg);
  const phoneNumberId = await getPhoneNumberId(cfg);

  const { data } = await axios.post(`${BASE_URL}/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', status: 'read', message_id: messageId,
  }, { headers: { Authorization: `Bearer ${token}` } });
  return data;
}

module.exports = { sendMessage, markAsRead, getPhoneNumberId, buildConfig };
