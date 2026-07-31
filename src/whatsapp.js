const axios = require('axios');

const API_VERSION = 'v22.0';
const BASE_URL = `https://graph.facebook.com/${API_VERSION}`;

const APP_ID = process.env.WHATSAPP_APP_ID;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const WABA_ID = process.env.WHATSAPP_WABA_ID;

let cachedToken = process.env.WHATSAPP_ACCESS_TOKEN || null;
let cachedPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || null;

/**
 * Get (and cache) an access token.
 * Uses the token from .env if provided, otherwise generates
 * an app access token from the App ID + App Secret.
 */
async function getAccessToken() {
  if (cachedToken) return cachedToken;

  const { data } = await axios.get(
    `https://graph.facebook.com/oauth/access_token`,
    {
      params: {
        client_id: APP_ID,
        client_secret: APP_SECRET,
        grant_type: 'client_credentials',
      },
    }
  );
  cachedToken = data.access_token;
  console.log('Token de acceso generado desde App ID + Secret');
  return cachedToken;
}

/**
 * Discover the phone number ID from the WABA (and cache it).
 */
async function getPhoneNumberId() {
  if (cachedPhoneNumberId) return cachedPhoneNumberId;

  const token = await getAccessToken();
  const { data } = await axios.get(`${BASE_URL}/${WABA_ID}/phone_numbers`, {
    params: { access_token: token },
  });

  const numbers = data.data || [];
  if (numbers.length === 0) {
    throw new Error('No se encontraron números de teléfono en esta cuenta de WhatsApp Business');
  }

  // Prefer the number matching WHATSAPP_PHONE if provided, otherwise take the first
  const preferred =
    numbers.find((n) => n.display_phone_number === process.env.WHATSAPP_PHONE) ||
    numbers[0];

  cachedPhoneNumberId = preferred.id;
  console.log(
    `Número de WhatsApp detectado: ${preferred.display_phone_number} (ID: ${preferred.id})`
  );
  return cachedPhoneNumberId;
}

/**
 * Send a text message to a WhatsApp user.
 * @param {string} to - Recipient phone number
 * @param {string} text - Message body
 */
async function sendMessage(to, text) {
  const token = await getAccessToken();
  const phoneNumberId = await getPhoneNumberId();

  const { data } = await axios.post(
    `${BASE_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data;
}

/**
 * Mark an incoming message as read.
 * @param {string} sender - Sender phone number
 * @param {string} messageId - WhatsApp message ID
 */
async function markAsRead(sender, messageId) {
  const token = await getAccessToken();
  const phoneNumberId = await getPhoneNumberId();

  const { data } = await axios.post(
    `${BASE_URL}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return data;
}

module.exports = { sendMessage, markAsRead, getPhoneNumberId };
