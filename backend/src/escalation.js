const axios = require('axios');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ESCALATION_EMAIL = process.env.ESCALATION_EMAIL || 'info@angelasvacations.com';
const MIN_CONFIDENCE = parseFloat(process.env.MIN_CONFIDENCE || '0.65');
const MAX_NEGATIVE = parseInt(process.env.MAX_NEGATIVE_RESPONSES || '3');

// Track consecutive negative responses per user (in memory — resets on restart)
const negativeCounts = new Map();

// Track message counts to prevent early escalation
const messageCounts = new Map();
const MIN_MESSAGES_BEFORE_ESCALATE = 2;

// Greetings — don't escalate on these
const GREETINGS = [
  'hola', 'buenos días', 'buenas tardes', 'buenas noches', 'hey', 'hello', 'hi',
  'cómo estás', 'como estas', 'cómo va', 'como va', 'qué tal', 'que tal',
  'saludos', 'buenas', 'mucho gusto', 'gracias', 'ok', 'vale', 'bien', 'bien y tu',
];

// Track pending escalations waiting for user confirmation
const pendingEscalations = new Map();

// ─── Keywords that trigger immediate escalation ──────────────────────────

const ESCALATION_KEYWORDS = [
  'hablar con un asesor',
  'quiero hablar con alguien',
  'persona real',
  'agente humano',
  'atención personal',
  'comunicarme con un asesor',
  'asesor real',
  'hablar con una persona',
  'no me entiendes',
  'no sirves',
];

// ─── Main escalation check ───────────────────────────────────────────────

/**
 * Check if the conversation should be escalated to a human.
 * @returns {{ escalate: boolean, reason: string }}
 */
function shouldEscalate(userId, query, chunks, error) {
  const queryLower = query.toLowerCase().trim();

  // Never escalate on greetings / first contact
  if (GREETINGS.some(g => queryLower.includes(g))) {
    return { escalate: false, reason: '' };
  }

  // Track message count
  const msgCount = (messageCounts.get(userId) || 0) + 1;
  messageCounts.set(userId, msgCount);

  // Case 2: User explicitly asks for an advisor (always escalate regardless of count)
  if (ESCALATION_KEYWORDS.some(kw => queryLower.includes(kw))) {
    return { escalate: true, reason: 'El usuario solicitó hablar con un asesor' };
  }

  // Case 4: API error (always escalate)
  if (error) {
    return { escalate: true, reason: `Error de API: ${error}` };
  }

  // Cases below only trigger after minimum messages
  if (msgCount < MIN_MESSAGES_BEFORE_ESCALATE) {
    return { escalate: false, reason: '' };
  }

  // Case 1: No information found (only after several attempts)
  if (chunks && chunks.length === 0 && query.length > 20) {
    return { escalate: true, reason: 'No se encontró información en la base de conocimiento' };
  }

  // Case 3: Low confidence (only after several attempts)
  if (chunks && chunks.length > 0) {
    const maxSim = Math.max(...chunks.map(c => c.similarity || 0));
    if (maxSim < MIN_CONFIDENCE) {
      return { escalate: true, reason: `Baja confianza (${maxSim.toFixed(2)} < ${MIN_CONFIDENCE})` };
    }
  }

  return { escalate: false, reason: '' };
}

// ─── Negative response tracking ──────────────────────────────────────────

function trackNegative(userId) {
  const count = (negativeCounts.get(userId) || 0) + 1;
  negativeCounts.set(userId, count);
  return count;
}

function resetNegative(userId) {
  negativeCounts.delete(userId);
}

/**
 * Check Case 5: too many consecutive negative responses.
 */
function checkNegativeThreshold(userId) {
  const count = negativeCounts.get(userId) || 0;
  if (count >= MAX_NEGATIVE) {
    resetNegative(userId);
    return { escalate: true, reason: `${count} respuestas negativas consecutivas` };
  }
  return { escalate: false, reason: '' };
}

// ─── Send escalation email via Resend ─────────────────────────────────────

async function sendEscalationEmail({ userId, userName, query, history, reason }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY no configurada — email no enviado');
    return false;
  }

  const historyText = (history || [])
    .map(m => `${m.role === 'user' ? '👤' : '🤖'}: ${m.text}`)
    .join('\n\n');

  const html = `
    <h2>🚨 Escalación — Quinceañera Cruise Bot</h2>
    <p><strong>Motivo:</strong> ${reason}</p>
    <hr>
    <p><strong>Usuario:</strong> ${userName || 'Desconocido'} (${userId})</p>
    <p><strong>Último mensaje:</strong> "${query}"</p>
    <hr>
    <h3>Historial de la conversación:</h3>
    <pre style="background:#f5f5f5;padding:10px;border-radius:6px;white-space:pre-wrap">${historyText || '(sin historial)'}</pre>
    <hr>
    <p style="color:#888;font-size:12px">Quinceañera Cruise Bot — Escalación automática</p>
  `;

  try {
    await axios.post(
      'https://api.resend.com/emails',
      {
        from: 'Quinceañera Bot <bot@angelasvacations.com>',
        to: ESCALATION_EMAIL,
        subject: `🚨 Escalación: ${reason.substring(0, 60)}`,
        html,
      },
      {
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log(`Email de escalación enviado a ${ESCALATION_EMAIL}`);
    return true;
  } catch (err) {
    console.error('Error enviando email de escalación:', err.response?.data || err.message);
    return false;
  }
}

// ─── Permission-based escalation ────────────────────────────────────────

/**
 * Check if user has a pending escalation and is now responding to it.
 * @returns {{ pending: true, confirm: boolean, escalationData: object } | { pending: false }}
 */
function checkPendingEscalation(userId, userMessage) {
  const pending = pendingEscalations.get(userId);
  if (!pending) return { pending: false };

  const msg = userMessage.toLowerCase().trim();
  const yes = ['sí', 'si', 'yes', 'dale', 'envíale', 'enviale', 'ok', 'vale', 'claro', 'por favor', 'porfa', 'gracias', 'bueno', 'de acuerdo'];
  const no = ['no', 'nop', 'nope', 'cancelar', 'espera'];

  const confirmed = yes.some(w => msg === w || msg.startsWith(w + ' ') || msg.includes(' ' + w + ' ') || msg.includes(' ' + w));
  const rejected = no.some(w => msg === w || msg.startsWith(w + ' ') || msg.includes(' ' + w + ' ') || msg.includes(' ' + w));

  if (confirmed) {
    pendingEscalations.delete(userId);
    return { pending: true, confirm: true, escalationData: pending };
  }
  if (rejected) {
    pendingEscalations.delete(userId);
    return { pending: true, confirm: false, escalationData: pending };
  }
  // User said something else — treat as no and continue
  pendingEscalations.delete(userId);
  return { pending: true, confirm: false, escalationData: pending };
}

function setPendingEscalation(userId, data) {
  pendingEscalations.set(userId, data);
}

function clearPendingEscalation(userId) {
  pendingEscalations.delete(userId);
}

module.exports = {
  shouldEscalate,
  trackNegative,
  resetNegative,
  checkNegativeThreshold,
  sendEscalationEmail,
  checkPendingEscalation,
  setPendingEscalation,
  clearPendingEscalation,
};
