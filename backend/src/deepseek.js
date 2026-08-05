const axios = require('axios');
const {
  shouldEscalate,
  sendEscalationEmail, checkPendingEscalation, setPendingEscalation, clearPendingEscalation,
  wasAnswerClear, trackNegative, resetNegative,
  sendClientEmail,
} = require('./escalation');
const { getSettings } = require('./settings');
const { TOOLS, FUNCTION_MAP } = require('./functions');

/**
 * Devuelve las tools habilitadas para un bot (según settings.enabledFunctions).
 * Vacío/ausente = todas habilitadas.
 */
async function getToolsForBot(botId) {
  const settings = await getSettings(botId);
  const enabled = settings.enabledFunctions;
  if (!enabled || enabled.length === 0) return TOOLS;
  return TOOLS.filter((t) => enabled.includes(t.function.name));
}

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const KNOWLEDGE_SERVICE_URL = process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:8000';
const DEEPSEEK_API_URL = 'https://api.deepseek.com';

const { ALLOWED_MODELS } = require('./settings');

// System prompt default (fallback si el bot no tiene uno propio).
// Usa {context} como marcador donde se insertan los chunks de conocimiento.
const DEFAULT_SYSTEM_PROMPT = `Eres un asistente virtual profesional.

⚠️ REGLA DE ORO: PRIMERO entrega la información, DESPUÉS pregunta. Nunca al revés.
Cuando el cliente pida cualquier cosa ("planes", "info", "precios", "dame todo"),
su primera respuesta DEBE contener datos concretos de los DATOS DISPONIBLES.
Solo después de entregar la info, puedes hacer UNA pregunta puntual si falta algún dato.

ESTILO:
- Responde en el mismo idioma del usuario, con calidez.
- Si ya hay historial, NO saludes de nuevo.
- Solo di "no tengo información" si REALMENTE no hay nada en los DATOS DISPONIBLES.

FUNCIONES:
- Qué incluye → listar_caracteristicas
- Itinerario → obtener_cronograma
- Pagos → obtener_fechas_pago
- Precios → extrae las cifras de DATOS DISPONIBLES. Si el cliente dice "X personas"
  sin desglose, calcula con lo que tengas (precio por persona × total, o estima).
  Si necesitas adulto/menor para ser exacto, dalo por estimado y luego pregunta.
- Asesor → pide datos y usa comunicar_asesor.
- Correo → pide email y usa enviar_correo_informacion.
- Compra → pide datos y usa iniciar_cierre_venta.

DATOS DISPONIBLES:
{context}`;

const DEFAULT_SYSTEM_PROMPT_FALLBACK = `Eres un asistente virtual profesional. Responde en el mismo idioma del usuario, con calidez y entusiasmo.

No tienes información cargada en este momento. Si no encuentras lo que el cliente necesita, ofrécele amablemente contactar a un asesor.`;

// Conversation history per user (in memory — max 6 messages)
const conversationHistory = new Map();

const DEEPSEEK_HEADERS = {
  Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
  'Content-Type': 'application/json',
};

/**
 * Consulta los modelos disponibles para la API key configurada.
 * Devuelve [{ id }] — fallback a la lista estática si no hay key o la API falla.
 */
async function listModels() {
  const fallback = () => ALLOWED_MODELS.map((id) => ({ id }));
  if (!DEEPSEEK_API_KEY) return fallback();
  try {
    const { data } = await axios.get(`${DEEPSEEK_API_URL}/models`, {
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      timeout: 10000,
    });
    const ids = (data.data || []).map((m) => m.id).filter(Boolean);
    if (ids.length === 0) return fallback();
    return ids.map((id) => ({ id }));
  } catch (err) {
    console.warn('No se pudieron consultar modelos DeepSeek:', err.response?.status || err.message);
    return fallback();
  }
}



/**
 * Search the knowledge base for relevant context.
 */
async function searchKnowledge(query, botId) {
  const { topK, useReranker, minConfidence } = await getSettings(botId);
  try {
    const { data } = await axios.post(
      `${KNOWLEDGE_SERVICE_URL}/search`,
      { query, top_k: topK, use_reranker: useReranker, min_similarity: minConfidence },
      { headers: { 'Content-Type': 'application/json' }, params: { bot_id: botId } }
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
  const { temperature, maxTokens, model } = await getSettings(botId);
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
    return callDeepSeek(messages, tools, attempt + 1, botId);
  }

  // Handle function calling — multi-round: ejecuta tools y hace follow-up hasta
  // que el modelo responda sin tool_calls (ej. recopila info → luego envía correo)
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    let currentMsg = msg;
    let currentMessages = messages;
    let escalate = null;
    let emailSent = false;

    while (currentMsg.tool_calls && currentMsg.tool_calls.length > 0) {
      console.log(`Function call: ${currentMsg.tool_calls.map(t => t.function.name).join(', ')}`);

      // Execute functions and collect results
      const toolResults = [];
      for (const toolCall of currentMsg.tool_calls) {
        const fn = FUNCTION_MAP[toolCall.function.name];
        if (fn) {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          const result = await fn(args, botId); // await soporta funciones async (ej. enviar_correo_informacion)
          console.log(`  → ${toolCall.function.name}(${JSON.stringify(args)}) = ${JSON.stringify(result).substring(0, 120)}`);
          if (toolCall.function.name === 'enviar_correo_informacion' && result?.ok) emailSent = true;
          if (result?._escalate && !escalate) escalate = result.lead || {};
          toolResults.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            // Si la función devuelve null (sin datos configurados), enviar un JSON válido
            content: JSON.stringify(result ?? { ok: false, error: 'No hay datos configurados para esta función' }),
          });
        }
      }

      // Send results back for the model to continue
      const followUp = [
        ...currentMessages,
        { role: 'assistant', content: null, tool_calls: currentMsg.tool_calls },
        ...toolResults,
      ];

      const { model, maxTokens } = await getSettings(botId);
      const retry = await axios.post(
        'https://api.deepseek.com/chat/completions',
        { model, messages: followUp, temperature: 0.7, max_tokens: Math.max(2500, maxTokens) },
        { headers: DEEPSEEK_HEADERS }
      );

      currentMsg = retry.data.choices[0].message;
      currentMessages = followUp;
    }

    if (escalate) {
      currentMsg._escalate = true;
      currentMsg._escalateData = escalate;
    }
    if (emailSent) currentMsg._emailSent = true;
    return currentMsg;
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
  const { maxNegativeResponses } = await getSettings(botId);
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
  const settings = await getSettings(botId);
  let systemPrompt = settings.systemPrompt?.trim();

  if (!systemPrompt) {
    // Fallback: usar el prompt duro por defecto
    if (relevantChunks.length > 0) {
      const context = relevantChunks.map((c, i) => `[Fuente ${i + 1}]:\n${c.content}`).join('\n\n---\n\n');
      systemPrompt = DEFAULT_SYSTEM_PROMPT.replace('{context}', context);
    } else {
      systemPrompt = DEFAULT_SYSTEM_PROMPT_FALLBACK;
    }
  } else if (systemPrompt.includes('{context}')) {
    // Reemplazar {context} siempre: con los chunks si hay, o un texto neutral si no
    const context = relevantChunks.length > 0
      ? relevantChunks.map((c, i) => `[Fuente ${i + 1}]:\n${c.content}`).join('\n\n---\n\n')
      : '(No hay información adicional disponible en este momento.)';
    systemPrompt = systemPrompt.replace('{context}', context);
  }


  messages.push({ role: 'system', content: systemPrompt });

  // ═══ Dynamic function list: solo las habilitadas aparecen en el prompt ═══
  const enabledTools = await getToolsForBot(botId);
  const enabledNames = enabledTools.map((t) => t.function.name);
  const allNames = TOOLS.map((t) => t.function.name);
  const restricted = !(!settings.enabledFunctions || settings.enabledFunctions.length === 0);
  const disabled = allNames.filter((n) => !enabledNames.includes(n));
  if (restricted && disabled.length > 0) {
    // Reemplazar la sección FUNCIONES del prompt dinámicamente
    const funcNames = {
      listar_caracteristicas: 'Listar características',
      obtener_cronograma: 'Cronograma / Itinerario',
      obtener_fechas_pago: 'Fechas de pago',
      calcular_presupuesto: 'Calcular presupuesto',
      comunicar_asesor: 'Comunicar con asesor',
      enviar_correo_informacion: 'Enviar info por correo',
      iniciar_cierre_venta: 'Cierre de venta',
    };
    const habilitadas = enabledNames.map((n) => `✅ ${funcNames[n] || n}`).join('\n');
    const noHabilitadas = disabled.map((n) => `❌ ${funcNames[n] || n}`).join('\n');
    const dynamicFuncs = `\nFUNCIONES HABILITADAS:\n${habilitadas}\n\nFUNCIONES NO DISPONIBLES:\n${noHabilitadas}\n\n⚠️ Si el cliente pide una función NO DISPONIBLE, dile amablemente que esa acción no está configurada para este bot y ofrécele las que sí lo están.`;
    messages[messages.length - 1].content += dynamicFuncs;
  }

  // ═══ Validation layer: avisar si la base de conocimiento está vacía ═══
  if (relevantChunks.length === 0) {
    messages[messages.length - 1].content +=
      '\n\n⚠️ AVISO IMPORTANTE: La base de conocimiento está VACÍA (no se ha cargado ningún documento).\n' +
      'Responde ÚNICAMENTE usando los resultados de las funciones habilitadas.\n' +
      'Para cualquier consulta que no esté cubierta por las funciones, di:\n' +
      '"No tengo esa información en mi base de conocimiento. ¿Quieres que contacte a un asesor?"\n' +
      'NO improvises ni uses tu entrenamiento general para responder preguntas de conocimiento.';
  }

  // Historial previo como turnos reales de mensajes (contexto para el modelo)
  const { maxHistoryMessages } = await getSettings(botId);
  for (const m of history.slice(-maxHistoryMessages)) {
    messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  }

  messages.push({ role: 'user', content: userMessage });

  // 3. Call DeepSeek with function calling
  let content;
  let escalated = false;
  let emailSent = false;
  try {
    const msg = await callDeepSeek(messages, await getToolsForBot(botId), 1, botId);
    content = (msg.content || '')
      // Limpiar cualquier XML de function-call filtrado en el texto de respuesta
      .replace(/<function_calls>[\s\S]*?<\/function_calls>/gi, '')
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<invoke[\s\S]*?<\/invoke>/gi, '')
      .trim();

    // ═══ HARD validation: si no hay chunks en la BD, el modelo NO puede
    //      responder con información que no venga de una función ═══
    if (relevantChunks.length === 0 && content && !escalated && !emailSent) {
      const looksLikeKnowledge = (
        /\$[\d,]+/.test(content) ||           // menciona precios
        /\d{1,2}\s*(de|th|rd)\s/.test(content) ||  // menciona fechas
        /incluye|incluyen|ofrece|contiene/i.test(content) ||  // describe características
        content.length > 400                     // respuesta larga sin fuente
      );
      if (looksLikeKnowledge) {
        console.log('  🛑 Response blocked: no chunks in DB but model generated knowledge claims');
        content = 'No tengo esa información en mi base de conocimiento. ¿Quieres que contacte a un asesor?';
      }
    }

    // ═══ Cross-reference: si hay chunks, verificar que los datos de la
    //      respuesta existan realmente en el conocimiento ═══
    if (relevantChunks.length > 0 && content && !escalated) {
      const allChunksText = relevantChunks.map(c => c.content).join(' ').toLowerCase();

      // Extraer todo tipo de datos concretos de la respuesta
      const dataPoints = [];

      // Precios: $1,736.26, $200 USD, etc.
      (content.match(/\$[\d,.]+/g) || []).forEach(d => dataPoints.push(d));

      // Números significativos (3+ dígitos, no años sueltos)
      (content.match(/\b\d{3,}\b/g) || []).forEach(d => {
        // Ignorar años (2024-2030) y horas (1000-2400)
        if (!/^(20[2-9]\d|1[0-9]{3}|\d{4})$/.test(d)) dataPoints.push(d);
      });

      // Fechas: "20 de marzo", "March 20", "20/03/2027"
      (content.match(/\d{1,2}\s+(de\s+)?[a-záéíóúñ]+/gi) || []).forEach(d => dataPoints.push(d));
      (content.match(/\d{1,2}[\/.-]\d{1,2}([\/.-]\d{2,4})?/g) || []).forEach(d => dataPoints.push(d));

      // Nombres propios potenciales (palabras con mayúscula que no sean inicio de oración)
      const properNouns = content.match(/\b[A-Z][a-z]{3,}\b/g) || [];
      properNouns.forEach(d => {
        // Solo agregar si parece nombre de lugar/evento/producto (no palabras comunes)
        if (!/^(The|This|And|But|For|With|You|Your|Our|Los|Las|Del|Por|Para|Una|Cada|Más|Son|Hay|Sus|Qué|Cuál|Como|Donde|Cuando|Cuanto|Hola|Gracias)$/i.test(d)) {
          dataPoints.push(d);
        }
      });

      // Normalizar comas (el modelo escribe $2,166.26 pero el PDF tiene $2166.26)
      const normalizedChunks = allChunksText.replace(/,/g, '');
      
      // Verificar cuántos NO están en los chunks
      let missingCount = 0;
      for (const dp of dataPoints) {
        const norm = dp.toLowerCase().replace(/,/g, '');
        if (!normalizedChunks.includes(norm)) missingCount++;
      }

      if (dataPoints.length > 0 && missingCount > 0) {
        console.log(`  🔍 Cross-ref: ${missingCount}/${dataPoints.length} data points not in chunks`);
      }

      // Bloquear si más de 30% de los datos no están en los chunks
      // (tolerancia: los datos pueden aparecer ligeramente formateados distinto)
      if (dataPoints.length >= 2 && missingCount / dataPoints.length > 0.3) {
        console.log(`  🛑 Cross-ref BLOCKED: ${missingCount}/${dataPoints.length} data points not found`);
        content = 'Lo siento, no encontré suficiente información para responder con precisión. ¿Quieres que contacte a un asesor?';
      }
    }
    emailSent = msg._emailSent === true;
    if (msg._escalate) {
      escalated = true;
      const lead = msg._escalateData;
      const reason = [
        'Cierre de venta',
        lead.nombre ? `— ${lead.nombre}` : '',
        lead.telefono ? `📞 ${lead.telefono}` : '',
        lead.email ? `✉️ ${lead.email}` : '',
        lead.num_personas ? `👥 ${lead.num_personas} personas` : '',
        lead.tipo ? `🛏️ ${lead.tipo}` : '',
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

  // Fallback determinista: si el usuario pidió un correo y el modelo NO llamó
  // enviar_correo_informacion (o falló), enviarlo automáticamente con la respuesta.
  // Si no dio su email, el modelo debió pedirlo; si no lo pidió, se lo recordamos.
  const wantsEmail = /correo|email|e-mail|e mail|mail/i.test(userMessage);
  const emailMatch = userMessage.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
  if (!emailSent && wantsEmail) {
    if (emailMatch) {
      const emailResult = await sendClientEmail({
        to: emailMatch[0],
        subject: 'Información solicitada',
        body: content.substring(0, 5000),
        botId,
      });
      if (emailResult.ok) {
        emailSent = true;
        content += `\n\n📧 Listo — también te envié esta información por correo a ${emailMatch[0]}. Revisa spam si no aparece.`;
      } else {
        console.error('Envío de correo automático falló:', emailResult.error);
      }
    } else {
      // El usuario quiere un correo pero no dio su email — si el modelo no lo pidió, recordárselo
      if (content && !/[Cc]orreo|[Ee]mail/.test(content)) {
        content += '\n\n📧 Si quieres que te envíe la información por correo, dime tu dirección de email. 😊';
      }
    }
  }

  // Si el modelo respondió sin fragmentos de la base de conocimiento, activa
  // la escalación por si el usuario confirma (el propio modelo ya sugirió
  // contactar al asesor en el idioma del usuario según su prompt).
  if (!escalated && content && (!relevantChunks || relevantChunks.length === 0)) {
    setPendingEscalation(userId, {
      userId, userName, query: userMessage,
      reason: 'Información no encontrada en la base de conocimiento',
      history: historySnapshot,
    });
  }

  // Save to history (depth y truncado para acotar tokens; profundidad configurable)
  history.push({ role: 'user', text: userMessage.substring(0, 500) });
  history.push({ role: 'assistant', text: content.substring(0, 800) });
  if (history.length > maxHistoryMessages) history.splice(0, history.length - maxHistoryMessages);

  return { answer: content, chunks: relevantChunks, escalated };
}

module.exports = { chatWithDeepSeek, searchKnowledge, listModels, getToolsForBot };
