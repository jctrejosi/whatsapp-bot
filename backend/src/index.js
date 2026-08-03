require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { sendMessage, markAsRead } = require('./whatsapp');
const { chatWithDeepSeek } = require('./deepseek');

const app = express();

// ─── CORS ───────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// ─── Request logging ────────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `[${res.statusCode}] ${req.method} ${req.originalUrl}` +
      ` | origin=${req.headers.origin || 'none'}` +
      ` | ${Date.now() - start}ms`
    );
    if (res.statusCode >= 400) {
      console.log(`  → Headers: ${JSON.stringify(req.headers)}`);
    }
  });
  next();
});

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
      const result = await chatWithDeepSeek(messageText, senderName, senderPhone);
      const aiResponse = result.answer;
      console.log(`Respuesta DeepSeek: "${aiResponse}"`);

      // Save conversation asynchronously (don't block response)
      knowledge.post('/conversations', {
        user_id: senderPhone,
        user_name: senderName,
        message: messageText,
        response: aiResponse,
        chunks_used: [],
      }).catch(err => console.warn('Conversation save failed:', err.message));

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

const axios = require('axios');

const KNOWLEDGE_URL = process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:8000';

// ─── Proxy to knowledge-service ────────────────────────────────────────
const knowledge = axios.create({ baseURL: KNOWLEDGE_URL });

app.get('/sources', async (req, res) => {
  try {
    console.log(`Proxy → ${KNOWLEDGE_URL}/sources`);
    const { data } = await knowledge.get('/sources');
    res.json(data);
  } catch (e) {
    console.error(`Proxy /sources FAILED: ${e.code || e.message}`);
    res.status(502).json({ error: 'Knowledge service unreachable' });
  }
});

app.get('/sources/:id', async (req, res) => {
  try {
    const { data } = await knowledge.get(`/sources/${req.params.id}`);
    res.json(data);
  } catch (e) { res.status(502).json({ error: 'Knowledge service unreachable' }); }
});

app.post('/ingest', async (req, res) => {
  try {
    const { data } = await knowledge.post('/ingest', req.body);
    res.json(data);
  } catch (e) { res.status(502).json({ error: 'Knowledge service unreachable' }); }
});

app.get('/health', async (req, res) => {
  try {
    console.log(`Proxy → ${KNOWLEDGE_URL}/health`);
    const { data } = await knowledge.get('/health');
    res.json(data);
  } catch (e) {
    console.error(`Proxy /health FAILED: ${e.code || e.message}`);
    res.status(502).json({ error: 'Knowledge service unreachable' });
  }
});

// ─── Conversation history ──────────────────────────────────────────────
app.get('/conversations/:userId', async (req, res) => {
  try {
    const { data } = await knowledge.get(`/conversations/${req.params.userId}`);
    res.json(data);
  } catch (e) {
    console.error(`Proxy /conversations FAILED: ${e.code || e.message}`);
    res.status(502).json({ error: 'Knowledge service unreachable' });
  }
});

// ─── Chat endpoint (for frontend) ─────────────────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { query, user_id, user_name } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });

    console.log(`Chat: "${query.substring(0, 80)}..."`);
    const result = await chatWithDeepSeek(query, user_name || 'Usuario', user_id || 'web');
    res.json({ query, answer: result.answer });
  } catch (error) {
    console.error('Chat error:', error.message);
    res.status(500).json({ error: 'Error procesando el mensaje' });
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
