require('dotenv').config();

const express = require('express');
const { sendMessage, markAsRead } = require('./whatsapp');
const { chatWithDeepSeek } = require('./deepseek');

const app = express();
app.use(express.json());

// ─── Webhook verification (GET) ───────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('Webhook verificado correctamente');
    return res.status(200).send(challenge);
  }

  console.warn('Fallo en verificación del webhook');
  res.sendStatus(403);
});

// ─── Receive messages (POST) ──────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Always respond 200 quickly so Meta doesn't retry
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    // Only process incoming messages (not status updates)
    const messages = value?.messages;
    if (!messages) return;

    const contact = value.contacts?.[0];
    const metadata = value.metadata;

    for (const msg of messages) {
      // Ignore non-text messages and outgoing messages
      if (msg.type !== 'text' || msg.from === metadata?.phone_number_id) continue;

      const senderPhone = msg.from;
      const messageText = msg.text.body;
      const senderName = contact?.profile?.name || senderPhone;

      console.log(`Mensaje de ${senderName} (${senderPhone}): "${messageText}"`);

      // Mark message as read
      await markAsRead(senderPhone, msg.id);

      // Get response from DeepSeek
      const aiResponse = await chatWithDeepSeek(messageText, senderName);
      console.log(`Respuesta DeepSeek: "${aiResponse}"`);

      // Send response back to WhatsApp
      await sendMessage(senderPhone, aiResponse);
      console.log('Respuesta enviada a WhatsApp');
    }
  } catch (error) {
    console.error('Error procesando mensaje:', error.message);
    if (error.response) {
      console.error('Detalle:', JSON.stringify(error.response.data, null, 2));
    }
  }
});

// ─── Health check ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('WhatsApp Bot + DeepSeek está funcionando');
});

// ─── Start server ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
  console.log('Webhook: POST /webhook');
});
