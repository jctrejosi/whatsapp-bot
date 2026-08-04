require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { sendMessage, markAsRead } = require('./whatsapp');
const { chatWithDeepSeek } = require('./deepseek');
const { getSettings, updateSettings, resetSettings } = require('./settings');
const { sendEscalationEmail } = require('./escalation');
const { getLogs } = require('./logger');

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

// Mensaje de error con la URL intentada, para diagnóstico rápido
function knowledgeError(url) {
  return `Knowledge service unreachable (${KNOWLEDGE_URL}${url})`;
}

app.get('/sources', async (req, res) => {
  try {
    console.log(`Proxy → ${KNOWLEDGE_URL}/sources`);
    const { data } = await knowledge.get('/sources');
    res.json(data);
  } catch (e) {
    console.error(`Proxy /sources FAILED: ${e.code || e.message}`);
    res.status(502).json({ error: knowledgeError('/sources') });
  }
});

app.get('/sources/:id', async (req, res) => {
  try {
    const { data } = await knowledge.get(`/sources/${req.params.id}`);
    res.json(data);
  } catch (e) { res.status(502).json({ error: knowledgeError(`/sources/${req.params.id}`) }); }
});

app.post('/ingest', async (req, res) => {
  try {
    const { data } = await knowledge.post('/ingest', req.body);
    res.json(data);
  } catch (e) { res.status(502).json({ error: knowledgeError('/ingest') }); }
});

app.get('/health', async (req, res) => {
  try {
    console.log(`Proxy → ${KNOWLEDGE_URL}/health`);
    const { data } = await knowledge.get('/health');
    res.json(data);
  } catch (e) {
    console.error(`Proxy /health FAILED: ${e.code || e.message}`);
    res.status(502).json({ error: knowledgeError('/health') });
  }
});

// ─── Conversation history ──────────────────────────────────────────────
app.get('/conversations/:userId', async (req, res) => {
  try {
    const { data } = await knowledge.get(`/conversations/${req.params.userId}`);
    res.json(data);
  } catch (e) {
    console.error(`Proxy /conversations FAILED: ${e.code || e.message}`);
    res.status(502).json({ error: knowledgeError(`/conversations/${req.params.userId}`) });
  }
});

// ─── Logs (diagnóstico en producción) ──────────────────────────────────

app.get('/logs', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  res.json({ count: Math.min(limit, getLogs().length), logs: getLogs().slice(0, limit) });
});

// ─── Settings (admin dashboard) ─────────────────────────────────────────

// GET /settings — current configuration
app.get('/settings', (req, res) => {
  res.json(getSettings());
});

// PUT /settings — validate and apply a subset of settings
app.put('/settings', (req, res) => {
  try {
    res.json(updateSettings(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /settings/reset — back to env vars / defaults
app.post('/settings/reset', (req, res) => {
  try {
    res.json(resetSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /settings/test-email — send a test escalation email to all advisors
app.post('/settings/test-email', async (req, res) => {
  try {
    const result = await sendEscalationEmail({
      userId: 'test',
      userName: 'Prueba de configuración',
      query: 'Este es un correo de prueba enviado desde el panel de configuración.',
      history: [],
      reason: 'Prueba de configuración del bot',
    });
    if (result.ok) {
      res.json(result);
    } else {
      res.status(502).json({
        error: result.error || 'No se pudo enviar el correo',
        results: result.results,
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
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
