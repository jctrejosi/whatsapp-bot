const axios = require('axios');
const {
  shouldEscalate,
  sendEscalationEmail, checkPendingEscalation, setPendingEscalation, clearPendingEscalation
} = require('./escalation');
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
 * Call DeepSeek with optional function calling.
 * If the model returns tool_calls, execute them and call again with results.
 */
async function callDeepSeek(messages, tools = null, attempt = 1) {
  const maxTokens = attempt === 1 ? 1200 : attempt === 2 ? 2000 : 3000;

  const body = {
    model: 'deepseek-v4-flash',
    messages,
    temperature: 0.7,
    max_tokens: maxTokens,
  };
  if (tools) body.tools = tools;

  let { data } = await axios.post('https://api.deepseek.com/chat/completions', body, { headers: DEEPSEEK_HEADERS });
  const msg = data.choices[0].message;
  const finishReason = data.choices[0].finish_reason;

  // If response was truncated, retry with more tokens
  if (finishReason === 'length' && attempt < 3 && msg.content && !msg.tool_calls) {
    console.log(`⚠️  Respuesta truncada (${msg.content.length} chars), reintentando con ${maxTokens * 1.7} tokens...`);
    return callDeepSeek(messages, tools, attempt + 1);
  }

  // Handle function calling
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    console.log(`Function call: ${msg.tool_calls.map(t => t.function.name).join(', ')}`);

    // Execute functions and collect results
    const toolResults = [];
    for (const toolCall of msg.tool_calls) {
      const fn = FUNCTION_MAP[toolCall.function.name];
      if (fn) {
        const args = JSON.parse(toolCall.function.arguments || '{}');
        const result = fn(args);
        console.log(`  → ${toolCall.function.name}(${JSON.stringify(args)}) = OK`);
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

    const retry = await axios.post(
      'https://api.deepseek.com/chat/completions',
      { model: 'deepseek-v4-flash', messages: followUp, temperature: 0.7, max_tokens: 1500 },
      { headers: DEEPSEEK_HEADERS }
    );

    return retry.data.choices[0].message;
  }

  return msg;
}

/**
 * Send a message to DeepSeek V4 Flash with function calling and RAG.
 * @returns {Promise<{ answer: string, chunks: Array, escalated: boolean }>}
 */
async function chatWithDeepSeek(userMessage, userName = 'Usuario', userId = 'unknown') {
  let relevantChunks = [];

  // ── Conversation memory ──────────────────────────────────────────
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  const history = conversationHistory.get(userId);

  // ── Escalation: only when user explicitly asks ───────────────────
  const pendingCheck = checkPendingEscalation(userId, userMessage);
  if (pendingCheck.pending && pendingCheck.confirm) {
    sendEscalationEmail(pendingCheck.escalationData);
    return {
      answer: '¡Listo! Ya notifiqué a nuestro equipo. Te contactarán pronto. ¿Necesitas algo más mientras tanto? 😊',
      chunks: [], escalated: true,
    };
  }

  // 1. Retrieve relevant knowledge
  try {
    relevantChunks = await searchKnowledge(userMessage);
  } catch (err) {
    console.error('Search error:', err.message);
  }

  // ── Check if user wants an advisor ──────────────────────────────
  if (shouldEscalate(userId, userMessage, relevantChunks).escalate) {
    setPendingEscalation(userId, { userId, userName, query: userMessage, reason: 'Cliente solicitó asesor' });
    return {
      answer: '¿Quieres que le notifique a uno de nuestros asesores para que te contacte personalmente? Responde "sí" para enviar la notificación o "no" para continuar. 😊',
      chunks: relevantChunks, escalated: false,
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
      (history.length > 0
        ? 'HISTORIAL:\n' + history.slice(-6).map(m => `  ${m.role === 'user' ? 'Cliente' : 'Tú'}: ${m.text}`).join('\n') + '\n\n'
        : '') +
      'ESTILO DE RESPUESTA:\n' +
      '- Responde en espa\u00f1ol, con calidez y entusiasmo. Usa emojis ocasionalmente.\n' +
      '- NUNCA menciones "fuentes", "contexto" ni t\u00e9rminos t\u00e9cnicos.\n' +
      '- Si ya hay historial, NO saludes de nuevo.\n\n' +
      'CU\u00c1NDO USAR FUNCIONES:\n' +
      '- Para calcular precios y armar planes de grupo \u2192 usa calcular_plan\n' +
      '- Para fechas de pago y cancelaciones \u2192 usa obtener_fechas_pago\n' +
      '- Para la lista de qu\u00e9 incluye el paquete \u2192 usa obtener_que_incluye\n' +
      '- Para el itinerario d\u00eda por d\u00eda \u2192 usa obtener_itinerario\n' +
      '- Para TODO lo dem\u00e1s: compara, explica, recomienda, resume usando los DATOS DEL EVENTO.\n\n' +
      'DATOS DEL EVENTO:\n' + context;
  } else {
    systemPrompt =
      'Eres Ana, asesora de Angela\'s Vacations LLC. Responde en español, con calidez.\n' +
      'No tienes acceso a la información. Pide disculpas y sugiere intentar de nuevo.';
  }

  messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userMessage });

  // 3. Call DeepSeek with function calling
  let content;
  try {
    const msg = await callDeepSeek(messages, TOOLS);
    content = msg.content;
  } catch (err) {
    console.error('DeepSeek error:', err.message);
    return { answer: 'Lo siento, tuve un problema técnico. ¿Puedes intentarlo de nuevo? 🙏', chunks: [], escalated: false };
  }

  if (!content || content.trim().length === 0) {
    return { answer: 'Lo siento, no pude procesar tu mensaje. ¿Puedes intentarlo de nuevo?', chunks: [], escalated: false };
  }

  // Save to history
  history.push({ role: 'user', text: userMessage.substring(0, 200) });
  history.push({ role: 'assistant', text: content.substring(0, 300) });
  if (history.length > 6) history.splice(0, history.length - 6);

  return { answer: content, chunks: relevantChunks, escalated: false };
}

module.exports = { chatWithDeepSeek, searchKnowledge };
