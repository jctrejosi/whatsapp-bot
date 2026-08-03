const axios = require('axios');
const { shouldEscalate, trackNegative, resetNegative, checkNegativeThreshold, sendEscalationEmail } = require('./escalation');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const KNOWLEDGE_SERVICE_URL = process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:8000';

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

  // 1. Retrieve relevant knowledge
  try {
    relevantChunks = await searchKnowledge(userMessage);
  } catch (err) {
    error = err.message;
  }

  // ── Escalation check BEFORE generating response ─────────────────
  const preEscalate = shouldEscalate(userId, userMessage, relevantChunks, error);
  if (preEscalate.escalate) {
    return await handleEscalation({
      userId, userName, query: userMessage,
      reason: preEscalate.reason,
      chunks: relevantChunks,
      history: [],
    });
  }

  // Check Case 5 (negative threshold) from previous interactions
  const negCheck = checkNegativeThreshold(userId);
  if (negCheck.escalate) {
    return await handleEscalation({
      userId, userName, query: userMessage,
      reason: negCheck.reason,
      chunks: relevantChunks,
      history: [],
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
      'Estás ayudando a familias interesadas en el crucero de Quinceañeras a bordo del MSC World America ' +
      '(20-27 marzo 2027).\n\n' +
      'ESTILO DE RESPUESTA:\n' +
      '- Responde en español, con calidez y entusiasmo, como si estuvieras en WhatsApp.\n' +
      '- Sé natural, cercana y empática. Usa emojis ocasionalmente.\n' +
      '- NUNCA menciones "fuentes", "contexto", "base de conocimiento" ni términos técnicos.\n' +
      '- NUNCA digas "según la información proporcionada" o frases similares.\n' +
      '- Responde como una asesora humana que conoce bien el producto.\n\n' +
      'LO QUE SABES (datos del evento):\n' +
      `${context}\n\n` +
      'REGLAS:\n' +
      '- Si te preguntan algo que NO está en los datos de arriba, di que no tienes ese detalle ' +
      'pero ofrece información relacionada que SÍ conozcas.\n' +
      '- NO inventes precios, fechas ni condiciones que no estén arriba.\n' +
      '- Si te preguntan algo ajeno al evento, responde amablemente que solo puedes ayudar con el crucero.';
  } else {
    systemPrompt =
      'Eres Ana, asesora de Angela\'s Vacations LLC. ' +
      'Responde en español, con calidez y naturalidad.\n\n' +
      'En este momento no tienes acceso a la información del evento. ' +
      'Dile al cliente que el sistema está iniciando y que por favor intente de nuevo en unos segundos. ' +
      'Sé amable y pide disculpas brevemente.';
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
    return await handleEscalation({
      userId, userName, query: userMessage,
      reason: `Error de API: ${err.message}`,
      chunks: relevantChunks,
      history: [],
    });
  }

  if (!content || content.trim().length === 0) {
    return await handleEscalation({
      userId, userName, query: userMessage,
      reason: 'DeepSeek devolvió respuesta vacía después de reintento',
      chunks: relevantChunks,
      history: [],
    });
  }

  // Successful response — reset negative counter
  resetNegative(userId);

  return { answer: content, chunks: relevantChunks, escalated: false };
}

// ─── Escalation handler ──────────────────────────────────────────────────

async function handleEscalation({ userId, userName, query, reason, chunks, history }) {
  console.log(`🚨 ESCALANDO — ${reason}`);

  // Send email
  const sent = await sendEscalationEmail({ userId, userName, query, history, reason, chunks });

  const message = sent
    ? 'He notificado a nuestro equipo de asesores sobre tu consulta. Te contactarán pronto. ¿Necesitas algo más mientras tanto? 😊'
    : 'Voy a transferirte con un asesor humano para atenderte mejor. Por favor espera un momento. 🙏';

  return { answer: message, chunks, escalated: true };
}

module.exports = { chatWithDeepSeek, searchKnowledge };
