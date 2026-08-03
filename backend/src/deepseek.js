const axios = require('axios');
const {
  shouldEscalate, trackNegative, resetNegative, wasAnswerClear,
  sendEscalationEmail, checkPendingEscalation, setPendingEscalation, clearPendingEscalation
} = require('./escalation');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const KNOWLEDGE_SERVICE_URL = process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:8000';

// Conversation history per user (in memory — max 6 messages)
const conversationHistory = new Map();

/**
 * Search the knowledge base for relevant context.
 */
async function searchKnowledge(query) {
  try {
    const { data } = await axios.post(
      `${KNOWLEDGE_SERVICE_URL}/search`,
      { query, top_k: 3, use_reranker: true },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return data.results || [];
  } catch (err) {
    console.warn('Knowledge search fallback:', err.message);
    return [];
  }
}

/**
 * Send a message to DeepSeek V4 Flash and handle escalation if needed.
 * @returns {Promise<{ answer: string, chunks: Array, escalated: boolean }>}
 */
async function chatWithDeepSeek(userMessage, userName = 'Usuario', userId = 'unknown') {
  let relevantChunks = [];
  let error = null;

  // ── Conversation memory (last 6 messages) ─────────────────────────
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const history = conversationHistory.get(userId);

  // ── Check if user is responding to a pending escalation ────────────
  const pendingCheck = checkPendingEscalation(userId, userMessage);
  if (pendingCheck.pending) {
    if (pendingCheck.confirm) {
      // User confirmed — send the escalation email
      const escalationData = pendingCheck.escalationData;
      await sendEscalationEmail(escalationData);
      return {
        answer: '¡Listo! Ya notifiqué a nuestro equipo. Te contactarán pronto al número ' + (userName || userId) + '. ¿Necesitas algo más mientras tanto? 😊',
        chunks: [],
        escalated: true,
      };
    }
    // User rejected or said something else — cancel escalation
    clearPendingEscalation(userId);
  }

  // 1. Retrieve relevant knowledge
  try {
    relevantChunks = await searchKnowledge(userMessage);
  } catch (err) {
    error = err.message;
  }

  // ── Escalation check BEFORE generating response ─────────────────
  const preEscalate = shouldEscalate(userId, userMessage, relevantChunks);
  if (preEscalate.escalate) {
    return await askForEscalation({
      userId, userName, query: userMessage,
      reason: preEscalate.reason,
      chunks: relevantChunks,
    });
  }

  // 2. Build system prompt
  let systemPrompt;

  if (relevantChunks.length > 0) {
    const context = relevantChunks
      .map((c, i) => `[Fuente ${i + 1}]:\n${c.content}`)
      .join('\n\n---\n\n');

    systemPrompt =
      'Eres Ana, asesora de Angela\'s Vacations LLC, una agencia boutique con 20 años de experiencia. ' +
      'Estás ayudando a familias interesadas en el crucero de Quincea\u00f1eras a bordo del MSC World America ' +
      '(20-27 marzo 2027).\n\n' +
      (history.length > 0
        ? 'HISTORIAL DE LA CONVERSACIÓN (ya llevan hablando un rato, NO saludes de nuevo):\n' +
          history.slice(-6).map((m, i) => `  ${m.role === 'user' ? 'Cliente' : 'Tú (Ana)'}: ${m.text}`).join('\n') + '\n\n'
        : '') +
      'ESTILO DE RESPUESTA:\n' +
      '- Responde en espa\u00f1ol, con calidez y entusiasmo, como si estuvieras en WhatsApp.\n' +
      '- S\u00e9 natural, cercana y emp\u00e1tica. Usa emojis ocasionalmente.\n' +
      '- NUNCA menciones "fuentes", "contexto", "base de conocimiento" ni t\u00e9rminos t\u00e9cnicos.\n' +
      '- NUNCA digas "seg\u00fan la informaci\u00f3n proporcionada" o frases similares.\n' +
      '- Responde como una asesora humana que conoce bien el producto.\n' +
      '- Si ya hay historial, NO vuelvas a saludar ni a presentarte. Contin\u00faa la conversaci\u00f3n donde qued\u00f3.\n\n' +
      'LO QUE SABES (datos del evento):\n' +
      `${context}\n\n` +
      'REGLAS:\n' +
      '- Puedes HACER CÁLCULOS y armar planes personalizados usando los precios de arriba.\n' +
      '- Si el cliente te da número de personas, edades y tipo de cabina, calcula el costo total.\n' +
      '- Sugiere la distribución de cabinas más eficiente. Máximo 4 personas por cabina.\n' +
      '- Muestra el desglose: cuánto paga cada grupo (adultos vs menores de 17).\n' +
      '- Si te faltan datos para calcular (ej: no especificaron tipo de cabina), pregunta.\n' +
      '- Si te preguntan algo que NO está en los datos de arriba, di que no tienes ese detalle ' +
      'pero ofrece información relacionada que SÍ conozcas.\n' +
      '- NO inventes precios, fechas ni condiciones que no estén arriba.\n' +
      '- Si te preguntan algo ajeno al evento, responde amablemente que solo puedes ayudar con el crucero.';
  } else {
    systemPrompt =
      'Eres Ana, asesora de Angela\'s Vacations LLC. ' +
      'Responde en espa\u00f1ol, con calidez y naturalidad.\n\n' +
      (history.length > 0
        ? 'HISTORIAL DE LA CONVERSACIÓN (ya llevan hablando un rato, NO saludes de nuevo):\n' +
          history.slice(-6).map((m, i) => `  ${m.role === 'user' ? 'Cliente' : 'Tú (Ana)'}: ${m.text}`).join('\n') + '\n\n'
        : '') +
      'En este momento no tienes acceso a la informaci\u00f3n del evento. ' +
      'Dile al cliente que el sistema est\u00e1 iniciando y que por favor intente de nuevo en unos segundos. ' +
      'S\u00e9 amable y pide disculpas brevemente. ' +
      (history.length > 0 ? 'NO saludes de nuevo, ya est\u00e1n en medio de una conversaci\u00f3n.' : '');
  }

  // 3. Call DeepSeek V4 Flash
  let content;
  try {
    const { data } = await axios.post(
      'https://api.deepseek.com/chat/completions',
      {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 800,
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    content = data.choices[0].message.content;

    if (!content || content.trim().length === 0) {
      // Retry with more tokens
      const retry = await axios.post(
        'https://api.deepseek.com/chat/completions',
        {
          model: 'deepseek-v4-flash',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.7,
          max_tokens: 1500,
        },
        {
          headers: {
            Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      );
      content = retry.data.choices[0].message.content;
    }
  } catch (err) {
    // Case 4: API error
    return await askForEscalation({
      userId, userName, query: userMessage,
      reason: `Error de API: ${err.message}`,
      chunks: relevantChunks,
    });
  }

  if (!content || content.trim().length === 0) {
    return await askForEscalation({
      userId, userName, query: userMessage,
      reason: 'DeepSeek devolvió respuesta vacía después de reintento',
      chunks: relevantChunks,
    });
  }

  // Track negative or reset based on answer quality
  if (wasAnswerClear(relevantChunks)) {
    resetNegative(userId);
  } else {
    trackNegative(userId);
  }

  // Save to history
  history.push({ role: 'user', text: userMessage.substring(0, 200) });
  history.push({ role: 'assistant', text: content.substring(0, 300) });
  if (history.length > 6) history.splice(0, history.length - 6);

  return { answer: content, chunks: relevantChunks, escalated: false };
}

// ─── Escalation handlers ────────────────────────────────────────────────

async function askForEscalation({ userId, userName, query, reason, chunks }) {
  console.log(`⚠️  Escalación pendiente — ${reason}`);

  // Store escalation data for when user responds
  setPendingEscalation(userId, { userId, userName, query, reason });

  return {
    answer:
      'Parece que necesitas ayuda más personalizada para tu consulta. ' +
      '¿Quieres que le notifique a uno de nuestros asesores para que te contacte? ' +
      'Responde "sí" para enviar la notificación o "no" para continuar. 😊',
    chunks,
    escalated: false, // not yet — waiting for confirmation
  };
}

async function handleEscalation({ userId, userName, query, reason, chunks }) {
  console.log(`🚨 ESCALANDO — ${reason}`);
  const sent = await sendEscalationEmail({ userId, userName, query, reason });
  const message = sent
    ? '¡Listo! He notificado a nuestro equipo de asesores. Te contactarán pronto al número proporcionado. ¿Necesitas algo más mientras tanto? 😊'
    : 'Voy a transferirte con un asesor humano para atenderte mejor. Por favor espera un momento. 🙏';
  return { answer: message, chunks, escalated: true };
}

module.exports = { chatWithDeepSeek, searchKnowledge };
