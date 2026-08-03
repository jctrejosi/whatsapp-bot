const axios = require('axios');

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
 * Send a message to DeepSeek V4 Flash, answering ONLY from the knowledge base.
 * @param {string} userMessage - The user's message text
 * @param {string} userName - The user's name for personalization
 * @returns {Promise<string>} The AI response text
 */
async function chatWithDeepSeek(userMessage, userName = 'Usuario') {
  // 1. Retrieve relevant knowledge
  const relevantChunks = await searchKnowledge(userMessage);

  // 2. Build system prompt — strictly bound to the knowledge base
  let systemPrompt;

  if (relevantChunks.length > 0) {
    const context = relevantChunks
      .map((c, i) => `[Fuente ${i + 1}]:\n${c.content}`)
      .join('\n\n---\n\n');

    systemPrompt =
      'Eres un asistente especializado en el evento de Quinceañeras a bordo del MSC World America (20-27 marzo 2027), ' +
      'organizado por Angela\'s Vacations LLC. ' +
      'Responde en español, de forma clara, concisa y amable.\n\n' +
      'REGLAS ESTRICTAS:\n' +
      '- Responde ÚNICAMENTE usando la información del CONTEXTO proporcionado abajo.\n' +
      '- NO inventes información que no aparezca en el CONTEXTO.\n' +
      '- Si el CONTEXTO no contiene la respuesta, di exactamente: ' +
      '"No tengo esa información en mi base de conocimiento. ¿Puedo ayudarte con otra pregunta sobre el crucero de Quinceañeras?"\n' +
      '- NO respondas preguntas que no estén relacionadas con el evento.\n\n' +
      `CONTEXTO:\n${context}`;
  } else {
    systemPrompt =
      'Eres un asistente especializado ÚNICAMENTE en el evento de Quinceañeras a bordo del MSC World America ' +
      '(20-27 marzo 2027), organizado por Angela\'s Vacations LLC.\n\n' +
      'REGLAS ESTRICTAS:\n' +
      '- NO tienes acceso a la base de conocimiento en este momento.\n' +
      '- NO inventes información.\n' +
      '- Responde siempre con: ' +
      '"Lo siento, no tengo acceso a la información en este momento. ¿Puedes intentarlo de nuevo o preguntarme sobre el crucero de Quinceañeras?"\n' +
      '- NO respondas preguntas que no estén relacionadas con el evento de Quinceañeras.';
  }

  // 3. Call DeepSeek V4 Flash
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

  const content = data.choices[0].message.content;

  // V4 Flash may have consumed all tokens on reasoning; retry with more tokens if empty
  if (!content || content.trim().length === 0) {
    console.warn('DeepSeek V4 Flash returned empty content, retrying with more tokens');
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
    return retry.data.choices[0].message.content ||
      'Lo siento, no pude procesar tu mensaje. ¿Puedes intentarlo de nuevo?';
  }

  return content;
}

module.exports = { chatWithDeepSeek };
