const axios = require('axios');

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

/**
 * Send a message to DeepSeek and get the AI response.
 * @param {string} userMessage - The user's message text
 * @param {string} userName - The user's name for personalization
 * @returns {Promise<string>} The AI response text
 */
async function chatWithDeepSeek(userMessage, userName = 'Usuario') {
  const { data } = await axios.post(
    'https://api.deepseek.com/chat/completions',
    {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content:
            'Eres un asistente útil y amigable que responde a través de WhatsApp. ' +
            'Responde en español, de forma clara y concisa. ' +
            'Sé cálido y natural. Si no sabes algo, dilo honestamente.',
        },
        {
          role: 'user',
          content: userMessage,
        },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    },
    {
      headers: {
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return data.choices[0].message.content;
}

module.exports = { chatWithDeepSeek };
