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
