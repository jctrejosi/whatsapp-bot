require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { sendMessage, markAsRead } = require('./whatsapp');
const { chatWithDeepSeek } = require('./deepseek');
const { getSettings, updateSettings, resetSettings } = require('./settings');
const { sendEscalationEmail } = require('./escalation');
const { getLogs } = require('./logger');
const { listBots, createBot, deleteBot, updateBot } = require('./bot-manager');

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

// ─── Bots (multi-bot platform) ────────────────────────────────────────

app.get('/bots', async (req, res) => {
  res.json(await listBots());
});

app.post('/bots', async (req, res) => {
  try {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name es requerido' });
    const result = await createBot({ name, description });
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/bots/:id', (req, res) => {
  try {
    res.json(await updateBot(req.params.id, req.body || {}));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/bots/:id', (req, res) => {
  try {
    await deleteBot(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ─── Per-bot settings ─────────────────────────────────────────────────

app.get('/bots/:id/settings', async (req, res) => {
  res.json(await getSettings(req.params.id));
});

app.put('/bots/:id/settings', (req, res) => {
  try {
    res.json(await updateSettings(req.params.id, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/bots/:id/settings/reset', async (req, res) => {
  res.json(await resetSettings(req.params.id));
});

app.post('/bots/:id/settings/test-email', async (req, res) => {
  try {
    const result = await sendEscalationEmail({
      userId: 'test',
      userName: 'Prueba de configuración',
      query: 'Correo de prueba desde el panel de configuración.',
      history: [],
      reason: 'Prueba de configuración del bot',
      botId: req.params.id,
    });
    if (result.ok) res.json(result);
    else res.status(502).json({ error: result.error || 'No se pudo enviar', results: result.results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Per-bot knowledge ─────────────────────────────────────────────

app.get('/bots/:id/knowledge', async (req, res) => {
  try {
    const { data } = await knowledge.get('/sources', { params: { bot_id: req.params.id } });
    res.json(data);
  } catch (e) { res.status(502).json({ error: knowledgeError('/sources') }); }
});

app.post('/bots/:id/knowledge/upload', async (req, res) => {
  try {
    const multer = require('multer');
    const upload = multer({ storage: multer.memoryStorage() }).single('file');
    upload(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'file is required' });

      // 1. Subir a Cloudinary
      const { uploadBuffer } = require('./cloudinary');
      const cloudResult = await uploadBuffer(req.file.buffer, {
        folder: `bots/${req.params.id}`,
        original_filename: req.file.originalname,
      });

      // 2. Enviar al knowledge-service para extracción + chunking + embeddings
      const FormData = require('form-data');
      const form = new FormData();
      form.append('file', req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
      if (req.params.id) form.append('bot_id', req.params.id);
      const { data } = await axios.post(`${KNOWLEDGE_URL}/ingest`, form, {
        headers: { ...form.getHeaders() },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      res.json({ ...data, cloudinary_url: cloudResult.url });
    });
  } catch (e) { res.status(502).json({ error: knowledgeError('/ingest') }); }
});

app.delete('/bots/:id/knowledge/:sourceId', async (req, res) => {
  try {
    await knowledge.delete(`/sources/${req.params.sourceId}`);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: knowledgeError('/sources') }); }
});

app.post('/bots/:id/chat', async (req, res) => {
  try {
    const { query, user_id, user_name } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    const result = await chatWithDeepSeek(query, user_name || 'Usuario', user_id || 'web', req.params.id);
    res.json({ query, answer: result.answer, chunks_used: result.chunks });
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: 'Error procesando' });
  }
});

// ─── Global settings (backward compat + global defaults) ────────────────
// ─── Global settings (backward compat + global defaults) ────────────────

// GET /settings — current global configuration
app.get('/settings', async (req, res) => { res.json(await getSettings()); });

// PUT /settings — validate and apply a subset of global settings
app.put('/settings', (req, res) => {
  try { res.json(await updateSettings(null, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// POST /settings/reset
app.post('/settings/reset', (req, res) => {
  try { res.json(await resetSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /settings/test-email
app.post('/settings/test-email', async (req, res) => {
  try {
    const result = await sendEscalationEmail({
      userId: 'test', userName: 'Prueba', query: 'Correo de prueba.',
      history: [], reason: 'Prueba de configuración',
    });
    if (result.ok) res.json(result);
    else res.status(502).json({ error: result.error || 'No se pudo enviar', results: result.results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Chat endpoint (global, backward compat) ───────────────────────────
app.post('/chat', async (req, res) => {
  try {
    const { query, user_id, user_name } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    const result = await chatWithDeepSeek(query, user_name || 'Usuario', user_id || 'web');
    res.json({ query, answer: result.answer, chunks_used: result.chunks });
  } catch (err) { res.status(500).json({ error: 'Error procesando' }); }
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
