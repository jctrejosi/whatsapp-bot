const axios = require('axios');
const {
  shouldEscalate,
  sendEscalationEmail, checkPendingEscalation, setPendingEscalation, clearPendingEscalation,
  wasAnswerClear, trackNegative, resetNegative,
} = require('./escalation');
const { getSettings } = require('./settings');
const { TOOLS, FUNCTION_MAP } = require('./functions');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const KNOWLEDGE_SERVICE_URL = process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:8000';

// Conversation history per user (in memory — max 6 messages)
const conversationHistory = new Map();

const DEEPSEEK_HEADERS = {
  Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * Search the knowledge base for relevant context.
 */
async function searchKnowledge(query, botId) {
  const { topK, useReranker, minConfidence } = getSettings(botId);
  try {
    const { data } = await axios.post(
      `${KNOWLEDGE_SERVICE_URL}/search`,
      { query, top_k: topK, use_reranker: useReranker, min_similarity: minConfidence },
      { headers: { 'Content-Type': 'application/json' } }
    );
    return data.results || [];
  } catch (err) {
    console.warn('Knowledge search fallback:', err.message);
    return [];
  }
}

/**
 * Call DeepSeek with optional function calling.
 * If the model returns tool_calls, execute them and call again with results.
 */
async function callDeepSeek(messages, tools = null, attempt = 1, botId) {
  const { temperature, maxTokens, model } = getSettings(botId);
  // Escala: primer intento = maxTokens; 2º = x1.7; 3º = x2.5
  const tokens = Math.round(maxTokens * (attempt === 1 ? 1 : attempt === 2 ? 1.7 : 2.5));

  const body = {
    model,
    messages,
    temperature,
    max_tokens: tokens,
  };
  if (tools) body.tools = tools;

  let { data } = await axios.post('https://api.deepseek.com/chat/completions', body, { headers: DEEPSEEK_HEADERS });
  const msg = data.choices[0].message;
  const finishReason = data.choices[0].finish_reason;

  // If response was truncated, retry with more tokens
  if (finishReason === 'length' && attempt < 3 && msg.content && !msg.tool_calls) {
    console.log(`⚠️  Respuesta truncada (${msg.content.length} chars), reintentando con más tokens...`);
    return callDeepSeek(messages, tools, attempt + 1);
  }

  // Handle function calling
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    console.log(`Function call: ${msg.tool_calls.map(t => t.function.name).join(', ')}`);

    // Execute functions and collect results
    const toolResults = [];
    let escalate = null;
    for (const toolCall of msg.tool_calls) {
      const fn = FUNCTION_MAP[toolCall.function.name];
      if (fn) {
        const args = JSON.parse(toolCall.function.arguments || '{}');
        const result = fn(args);
        console.log(`  → ${toolCall.function.name}(${JSON.stringify(args)}) = OK`);
        if (result._escalate && !escalate) escalate = result.lead || {};
        toolResults.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
    }

    // Send results back for final response
    const followUp = [
      ...messages,
      { role: 'assistant', content: null, tool_calls: msg.tool_calls },
      ...toolResults,
    ];

    const { model, maxTokens } = getSettings(botId);
    const retry = await axios.post(
      'https://api.deepseek.com/chat/completions',
      { model, messages: followUp, temperature: 0.7, max_tokens: Math.max(2500, maxTokens) },
      { headers: DEEPSEEK_HEADERS }
    );

    const finalMsg = retry.data.choices[0].message;
    if (escalate) {
      finalMsg._escalate = true;
      finalMsg._escalateData = escalate;
    }
    return finalMsg;
  }

  return msg;
}

/**
 * Send a message to DeepSeek V4 Flash with function calling and RAG.
 * @returns {Promise<{ answer: string, chunks: Array, escalated: boolean }>}
 */
async function chatWithDeepSeek(userMessage, userName = 'Usuario', userId = 'unknown', botId) {
  let relevantChunks = [];

  // ── Conversation memory (per bot) ─────────────────────────────────
  const convKey = `${botId || 'global'}::${userId}`;
  if (!conversationHistory.has(convKey)) conversationHistory.set(convKey, []);
  const history = conversationHistory.get(convKey);

  // Snapshot de la conversación (incluye el mensaje actual) para el correo al asesor
  const historySnapshot = [...history, { role: 'user', text: userMessage }];

  // ── Escalation: only when user explicitly asks ───────────────────
  const pendingCheck = checkPendingEscalation(userId, userMessage);
  if (pendingCheck.pending && pendingCheck.confirm) {
    const emailResult = await sendEscalationEmail({ ...pendingCheck.escalationData, botId });
    return {
      answer: emailResult.ok
        ? '¡Listo! Ya notifiqué a nuestro equipo. Te contactarán pronto. ¿Necesitas algo más mientras tanto? 😊'
        : `Lo siento, hubo un problema al notificar a nuestro equipo: ${emailResult.error || 'error desconocido'}. 😕`,
      chunks: [], escalated: emailResult.ok,
    };
  }

  // 1. Retrieve relevant knowledge
  try {
    relevantChunks = await searchKnowledge(userMessage, botId);
  } catch (err) {
    console.error('Search error:', err.message);
  }

  // ── Negative-response tracking (offers an advisor after N unclear answers) ──
  const { maxNegativeResponses } = getSettings(botId);
  if (wasAnswerClear(relevantChunks)) {
    resetNegative(userId);
  } else if (maxNegativeResponses > 0) {
    const count = trackNegative(userId);
    if (count >= maxNegativeResponses) {
      resetNegative(userId);
      setPendingEscalation(userId, {
        userId, userName, query: userMessage,
        reason: `Varios intentos sin respuesta clara (${count})`,
        history: historySnapshot,
      });
      return {
        answer: 'Parece que no estoy logrando ayudarte con eso... 😅 ¿Quieres que le notifique a un asesor para que te contacte personalmente? Responde "sí" y le avisamos.',
        chunks: relevantChunks, escalated: false,
      };
    }
  }

  // ── Check if user explicitly asks for an advisor (auto-send, no confirmation) ──
  if (shouldEscalate(userId, userMessage, relevantChunks).escalate) {
    const emailResult = await sendEscalationEmail({
      userId, userName, query: userMessage,
      reason: 'Cliente solicitó asesor',
      history: historySnapshot,
      botId,
    });
    return {
      answer: emailResult.ok
        ? '¡Listo! Ya notifiqué a nuestro equipo. Te contactarán pronto. ¿Necesitas algo más mientras tanto? 😊'
        : `Lo siento, hubo un problema al notificar a nuestro equipo: ${emailResult.error || 'error desconocido'}. 😕`,
      chunks: relevantChunks, escalated: emailResult.ok,
    };
  }

  // 2. Build messages with RAG context
  const messages = [];
  let systemPrompt;

  if (relevantChunks.length > 0) {
    const context = relevantChunks.map((c, i) => `[Fuente ${i + 1}]:\n${c.content}`).join('\n\n---\n\n');

    systemPrompt =
      'Eres Ana, asesora de Angela\'s Vacations LLC, una agencia boutique con 20 años de experiencia. ' +
      'Estás ayudando a familias interesadas en el crucero de Quinceañeras a bordo del MSC World America ' +
      '(20-27 marzo 2027).\n\n' +
      'ESTILO DE RESPUESTA:\n' +
      '- Responde en espa\u00f1ol, con calidez y entusiasmo. Usa emojis ocasionalmente.\n' +
      '- NUNCA menciones "fuentes", "contexto" ni t\u00e9rminos t\u00e9cnicos.\n' +
      '- Si ya hay historial, NO saludes de nuevo.\n\n' +
      'CU\u00c1NDO USAR FUNCIONES:\n' +
      '- Para calcular precios y armar planes de grupo \u2192 usa calcular_plan\n' +
      '- Para fechas de pago y cancelaciones \u2192 usa obtener_fechas_pago\n' +
      '- Para la lista de qu\u00e9 incluye el paquete \u2192 usa obtener_que_incluye\n' +
      '- Para el itinerario d\u00eda por d\u00eda \u2192 usa obtener_itinerario\n' +
      '- Cuando el cliente muestra intención de comprar, dice "estoy de acuerdo", "me gusta el precio", "perfecto", "¿cómo reservo?", "¿cómo sigo?" o frases similares \u2192 PRIMERO pide sus datos (nombre, teléfono o correo) y cuántas personas viajarán. Cuando los tengas, usa iniciar_cierre_venta.\n' +
      '- Para TODO lo dem\u00e1s: compara, explica, recomienda, resume usando los DATOS DEL EVENTO.\n\n' +
      'DATOS DEL EVENTO:\n' + context;
  } else {
    systemPrompt =
      'Eres Ana, asesora de Angela\'s Vacations LLC. Responde en español, con calidez y entusiasmo.\n' +
      'Aunque no tengas acceso a la base de conocimiento en este momento, tu prioridad es ayudar al cliente:\n' +
      '- Si el cliente muestra intención clara de comprar o reservar \u2192 PRIMERO pide sus datos de contacto (nombre, teléfono o correo) y pregunta cuántas personas viajarán. Cuando te los dé, usa iniciar_cierre_venta.\n' +
      '- Si pregunta por precios, dale rangos generales y ofrece el contacto con un asesor.\n' +
      '- En TODOS los casos, responde de forma positiva y orientada a cerrar la venta.';
  }

  messages.push({ role: 'system', content: systemPrompt });

  // Historial previo como turnos reales de mensajes (contexto para el modelo)
  const { maxHistoryMessages } = getSettings(botId);
  for (const m of history.slice(-maxHistoryMessages)) {
    messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  }

  messages.push({ role: 'user', content: userMessage });

  // 3. Call DeepSeek with function calling
  let content;
  let escalated = false;
  try {
    const msg = await callDeepSeek(messages, TOOLS, 1, botId);
    content = msg.content;
    if (msg._escalate) {
      escalated = true;
      const lead = msg._escalateData;
      const reason = [
        'Cierre de venta',
        lead.nombre ? `— ${lead.nombre}` : '',
        lead.telefono ? `📞 ${lead.telefono}` : '',
        lead.email ? `✉️ ${lead.email}` : '',
        lead.num_personas ? `👥 ${lead.num_personas} personas` : '',
        lead.tipo_cabina ? `🛏️ ${lead.tipo_cabina}` : '',
        lead.notas ? `📝 ${lead.notas}` : '',
        lead.motivo ? `💬 ${lead.motivo}` : '',
      ].filter(Boolean).join(' | ');
      sendEscalationEmail({
        userId, userName, query: userMessage,
        reason,
        history: historySnapshot,
        type: 'sales',
        botId,
      });
    }
  } catch (err) {
    console.error('DeepSeek error:', err.message);
    return { answer: 'Lo siento, tuve un problema técnico. ¿Puedes intentarlo de nuevo? 🙏', chunks: [], escalated: false };
  }

  if (!content || content.trim().length === 0) {
    setPendingEscalation(userId, {
      userId, userName, query: userMessage,
      reason: 'Cliente listo para cerrar venta',
      history: historySnapshot,
    });
    return { answer: '¡Gracias por tu interés! 😊 ¿Quieres que un asesor te contacte para ayudarte con la reserva? Responde "sí" y te conectamos.', chunks: [], escalated: false };
  }

  // Si el modelo respondió sin fragmentos de la base de conocimiento, sugiere
  // contactar con un asesor (sin escalar automáticamente)
  if (!escalated && content && (!relevantChunks || relevantChunks.length === 0)) {
    setPendingEscalation(userId, {
      userId, userName, query: userMessage,
      reason: 'Información no encontrada en la base de conocimiento',
      history: historySnapshot,
    });
    content += '\n\n💡 Si necesitas información más precisa o personalizada, un asesor puede ayudarte. ¿Quieres que te contactemos? Responde "sí" y te avisamos.';
  }

  // Save to history (depth y truncado para acotar tokens; profundidad configurable)
  history.push({ role: 'user', text: userMessage.substring(0, 500) });
  history.push({ role: 'assistant', text: content.substring(0, 800) });
  if (history.length > maxHistoryMessages) history.splice(0, history.length - maxHistoryMessages);

  return { answer: content, chunks: relevantChunks, escalated };
}

module.exports = { chatWithDeepSeek, searchKnowledge };
