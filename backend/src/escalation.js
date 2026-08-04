const axios = require('axios');
const { getSettings } = require('./settings');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SENDER_NAME = 'Quinceañera Bot';

// Track consecutive negative responses per user (in memory — resets on restart)
const negativeCounts = new Map();

// Track pending escalations waiting for user confirmation
const pendingEscalations = new Map();

// ─── Keywords that trigger immediate escalation ──────────────────────────

const ESCALATION_KEYWORDS = [
  'hablar con un asesor',
  'quiero hablar con alguien',
  'persona real',
  'agente humano',
  'atención personalizada',
  'atención personal',
  'atencion personalizada',
  'comunicarme con un asesor',
  'comunícame con un asesor',
  'comunícame con',
  'contáctame con un asesor',
  'contactar con un asesor',
  'contacto con un asesor',
  'contratar con un asesor',
  'asesor real',
  'asesor por favor',
  'quiero un asesor',
  'necesito un asesor',
  'necesito hablar con',
  'quiero que me contacten',
  'que me llame',
  'que me llamen',
  'comunicarme con alguien',
  'ponerme en contacto',
  'atención al cliente',
  'hablar con una persona',
  'hablar con un humano',
  'hablar con alguien de verdad',
  'me gustaría contratar',
  'no me entiendes',
  'no sirves',
  'no me resuelves',
  'no me estás ayudando',
];

// ─── Main escalation check ───────────────────────────────────────────────

/**
 * Check if the user is explicitly asking for a human advisor.
 */
function shouldEscalate(userId, query, chunks) {
  const queryLower = query.toLowerCase().trim();

  // Only escalate when the user explicitly asks for a human
  if (ESCALATION_KEYWORDS.some(kw => queryLower.includes(kw))) {
    return { escalate: true, reason: 'El usuario solicitó hablar con un asesor' };
  }

  return { escalate: false, reason: '' };
}

/**
 * If the bot couldn't give a clear answer, increment the negative counter.
 * If it gave a good answer, reset it.
 */
function wasAnswerClear(chunks) {
  // Only count as unclear if the knowledge base returned NOTHING at all
  return chunks && chunks.length > 0;
}

function trackNegative(userId) {
  const count = (negativeCounts.get(userId) || 0) + 1;
  negativeCounts.set(userId, count);
  return count;
}

function resetNegative(userId) {
  negativeCounts.delete(userId);
}

// ─── Email-based escalation (Resend) ────────────────────────────────────

/**
 * Send the escalation notification to ALL configured advisor emails.
 * @returns {Promise<{ ok: boolean, results: Array<{ to: string, ok: boolean, error: string|null }> }>}
 */
async function sendEscalationEmail({ userId, userName, query, history, reason }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY no configurada — email no enviado');
    return { ok: false, results: [], error: 'RESEND_API_KEY no configurada' };
  }

  const { escalationEmails, senderEmail } = getSettings();
  if (!escalationEmails || escalationEmails.length === 0) {
    console.warn('No hay correos de asesores configurados — email no enviado');
    return { ok: false, results: [], error: 'No hay correos de asesores configurados' };
  }

  const from = `${SENDER_NAME} <${senderEmail}>`;

  const historyText = (history || [])
    .map(m => `${m.role === 'user' ? '👤' : '🤖'}: ${m.text}`)
    .join('\n\n');

  const html = `
    <h2>🚢 Escalación — Quinceañera Cruise Bot</h2>
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

  const attempts = await Promise.allSettled(
    escalationEmails.map((to) =>
      axios.post(
        'https://api.resend.com/emails',
        {
          from,
          to,
          subject: `🚢 Solicitud de asesor: ${(query || reason).substring(0, 70)}`,
          html,
        },
        {
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
        }
      )
    )
  );

  const results = attempts.map((r, i) => ({
    to: escalationEmails[i],
    ok: r.status === 'fulfilled',
    error:
      r.status === 'rejected'
        ? r.reason?.response?.data?.message || r.reason?.response?.data?.name || r.reason?.message
        : null,
  }));

  results.forEach((r) => {
    if (r.ok) console.log(`Email de escalación enviado a ${r.to}`);
    else console.error(`Error enviando email a ${r.to}:`, r.error);
  });

  return { ok: results.some((r) => r.ok), results };
}

// ─── Pending escalation confirmation ─────────────────────────────────────

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
  wasAnswerClear,
  sendEscalationEmail,
  checkPendingEscalation,
  setPendingEscalation,
  clearPendingEscalation,
};
