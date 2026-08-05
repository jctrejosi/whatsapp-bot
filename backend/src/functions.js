/**
 * Business logic functions callable by the AI model.
 * Each function reads business data from the bot's per-bot settings
 * (planPricing, planIncludes, etc.), making them fully configurable.
 * No hardcoded fallbacks — returns null when data isn't configured.
 */

const { sendClientEmail } = require('./escalation');
const { getSettings } = require('./settings');

/**
 * Busca el precio de un tipo de cabina con matching tolerante:
 * el modelo puede pasar "Deluxe Balcony" mientras la clave es "Balcón Deluxe (BR2)".
 */
function findPricing(precios, tipo) {
  if (!precios) return null;
  if (!tipo) return Object.values(precios)[0] || null;

  // 1) Coincidencia exacta
  if (precios[tipo]) return precios[tipo];

  // 2) Coincidencia sin distinguir mayúsculas ni tildes
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const t = norm(tipo);
  for (const [key, value] of Object.entries(precios)) {
    if (norm(key) === t) return value;
  }

  // 3) Matching por palabras clave (inglés/español)
  for (const [key, value] of Object.entries(precios)) {
    const k = norm(key);
    const hasBalcon = t.includes('balcon') || t.includes('balcony');
    const hasInterior = t.includes('interior') || t.includes('inside');
    const hasVista = t.includes('vista') || t.includes('ocean') || t.includes('mar') || t.includes('sea') || t.includes('view');
    if (hasBalcon && (k.includes('balcon') || k.includes('balcony'))) return value;
    if (hasInterior && k.includes('interior')) return value;
    if (hasVista && (k.includes('vista') || k.includes('ocean') || k.includes('mar'))) return value;
  }

  // 4) Contiene parcial en cualquier dirección
  for (const [key, value] of Object.entries(precios)) {
    const k = norm(key);
    if (k.includes(t) || t.includes(k)) return value;
  }

  return null;
}

/**
 * Calculate a custom plan with pricing breakdown.
 * Uses planPricing from bot settings. If not configured, returns null.
 */
async function calcularPlan({ numPersonas, numAdultos, numMenores, tipo }, botId) {
  const settings = await getSettings(botId);
  const precios = settings.planPricing;
  if (!precios) return null; // sin datos → no se puede calcular

  // usar el tipo indicado (con matching tolerante), o el primero disponible
  const p = findPricing(precios, tipo);
  if (!p) return null;
  let total = 0;
  let cabinas = [];
  let pendientes = { adultos: numAdultos, menores: numMenores };
  let cabinaNum = 1;

  while (pendientes.adultos > 0 || pendientes.menores > 0) {
    const a = Math.min(pendientes.adultos, 2);
    const m = Math.min(pendientes.menores, 4 - a);
    const totalPersonas = a + m;
    if (totalPersonas === 0) break;

    const costoAdultos = a === 1 ? p.guest1_2 : (a === 2 ? p.guest1_2 * 2 : 0);
    const costoMenores = m * p.menor17;
    const costoAdulto3y4 = Math.max(0, totalPersonas - 2) > 0 ? (Math.min(pendientes.adultos + pendientes.menores - 2, pendientes.adultos - a)) * p.guest3_4 : 0;

    // Simplified: first 2 guests at guest1_2 rate, rest at guest3_4 or menor17
    let costo = 0;
    let detalle = [];
    const personas = [];
    for (let i = 0; i < a; i++) personas.push('adulto');
    for (let i = 0; i < m; i++) personas.push('menor');

    personas.forEach((tipo, idx) => {
      if (tipo === 'adulto') {
        const precio = idx < 2 ? p.guest1_2 : p.guest3_4;
        costo += precio;
        detalle.push(`adulto (huésped ${idx + 1}): $${precio.toFixed(2)}`);
      } else {
        costo += p.menor17;
        detalle.push(`menor <17 (huésped ${idx + 1}): $${p.menor17.toFixed(2)}`);
      }
    });

    cabinas.push({ cabina: cabinaNum, personas: totalPersonas, detalle, costo: Math.round(costo * 100) / 100 });
    total += costo;
    pendientes.adultos -= a;
    pendientes.menores -= m;
    cabinaNum++;
  }

  const tipoNombre = Object.keys(precios).find(k => precios[k] === p) || 'seleccionado';

  return {
    tipo: tipoNombre,
    cubiertas: p.cubiertas || p.ubicacion || '',
    totalPersonas: numPersonas,
    totalCabinas: cabinas.length,
    cabinas,
    total: Math.round(total * 100) / 100,
    nota: 'Precios calculados según la configuración del bot.',
  };
}

/**
 * Get deposit and payment schedule.
 */
async function obtenerFechasPago(args, botId) {
  const settings = await getSettings(botId);
  return settings.planPayments || null;
}

/**
 * Get what's included in the package.
 */
async function obtenerQueIncluye(args, botId) {
  const settings = await getSettings(botId);
  return settings.planIncludes || null;
}

/**
 * Get the itinerary / schedule.
 */
async function obtenerItinerario(args, botId) {
  const settings = await getSettings(botId);
  return settings.planItinerary || null;
}

/**
 * Sales closing — registers the lead and triggers escalation to a human advisor.
 * The `_escalate` flag is detected by chatWithDeepSeek to send the email.
 */
async function iniciarCierreVenta({ nombre, telefono, email, num_personas, tipo, notas, motivo }, botId) {
  return {
    ok: true,
    lead: {
      nombre: nombre || '',
      telefono: telefono || '',
      email: email || '',
      num_personas: num_personas || null,
      tipo: tipo || '',
      notas: notas || '',
      motivo: motivo || 'Interesado en el producto/servicio',
    },
    _escalate: true, // signal for chatWithDeepSeek to send escalation email
  };
}

/**
 * Send requested information by email to the client via Resend.
 * Args: { email, informacion, asunto }
 */
async function enviarCorreo({ email, informacion, asunto }, botId) {
  const to = (email || '').trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, mensaje: 'No tengo un correo válido. Pídele al cliente su dirección de correo electrónico.' };
  }
  const result = await sendClientEmail({
    to,
    subject: asunto || 'Información solicitada — Plataforma de Bots',
    body: informacion || 'Aquí tienes la información que solicitaste.',
    botId,
  });
  if (result.ok) {
    return { ok: true, mensaje: `Información enviada correctamente a ${to}. Revisa la bandeja de spam si no lo ves en unos minutos.` };
  }
  return { ok: false, error: result.error, mensaje: `No se pudo enviar el correo: ${result.error || 'error desconocido'}. Indícale al cliente que el envío falló.` };
}

/**
 * Notify the advisor team that the client wants to speak with a person.
 */
async function notificarAsesor({ nombre, telefono, email, consulta, motivo }, botId) {
  const { sendEscalationEmail } = require('./escalation');
  const displayName = nombre || 'Cliente';
  const contact = telefono || email || 'No proporcionado';
  try {
    const result = await sendEscalationEmail({
      userId: telefono || email || 'anonimo',
      userName: displayName,
      query: consulta || motivo || 'Solicitud de contacto con asesor',
      reason: motivo || 'El cliente desea hablar con un asesor',
      type: 'advisor',
      botId,
    });
    if (result.ok) {
      return { ok: true, mensaje: `Aviso enviado al equipo. Un asesor se pondrá en contacto contigo pronto.` };
    }
    return { ok: false, error: result.error, mensaje: `No se pudo notificar al equipo: ${result.error || 'error desconocido'}` };
  } catch (e) {
    return { ok: false, error: e.message, mensaje: 'Error al intentar contactar al equipo.' };
  }
}

// ─── Function definitions for DeepSeek tool calling ──────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'comunicar_asesor',
      description: 'El cliente quiere hablar con una persona real (asesor, agente, equipo de ventas). Usa esta función cuando el cliente DIGA EXPLÍCITAMENTE que quiere hablar con alguien, ser contactado, o recibir atención personalizada. IMPORTANTE: pide al cliente su nombre y teléfono o correo ANTES de llamar esta función. Si ya te los dio, procede.',
      parameters: {
        type: 'object',
        properties: {
          nombre:   { type: 'string', description: 'Nombre del cliente.' },
          telefono: { type: 'string', description: 'Teléfono de contacto.' },
          email:    { type: 'string', description: 'Correo electrónico.' },
          consulta: { type: 'string', description: 'Lo que el cliente quiere consultar con el asesor.' },
          motivo:   { type: 'string', description: 'Razón breve de la solicitud.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'enviar_correo_informacion',
      description: 'Envía por correo electrónico la información que el cliente solicitó. Usa esta función cuando el cliente pida que le manden algo por email. IMPORTANTE: incluye SIEMPRE el parámetro "informacion" con TODO el contenido relevante que se haya discutido (precios, itinerario, características, etc.). También incluye "asunto" descriptivo. Si el cliente no ha dado su correo, pídelo primero.',
      parameters: {
        type: 'object',
        properties: {
          email:    { type: 'string', description: 'Correo electrónico del cliente.' },
          informacion: { type: 'string', description: 'TODA la información que el cliente solicitó (precios, itinerario, características, fechas, etc.).' },
          asunto:   { type: 'string', description: 'Asunto breve y descriptivo del correo.' },
        },
        required: ['email', 'informacion'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'iniciar_cierre_venta',
      description: 'Registra la reserva y notifica al equipo de ventas. IMPORTANTE: usa los datos que el cliente YA proporcionó durante la conversación (nombre, teléfono, correo, número de personas, tipo de cabina). NO vuelvas a pedir datos ya mencionados — solo confírmalos con el cliente antes de llamar esta función. Si falta algún dato esencial, pide SOLO el dato faltante, no todos.',
      parameters: {
        type: 'object',
        properties: {
          nombre:       { type: 'string', description: 'Nombre completo del cliente.' },
          telefono:     { type: 'string', description: 'Teléfono de contacto.' },
          email:        { type: 'string', description: 'Correo electrónico.' },
          num_personas: { type: 'integer', description: 'Número total de personas.' },
          tipo:  { type: 'string', description: 'Tipo de opción preferida por el cliente.' },
          notas:        { type: 'string', description: 'Notas adicionales.' },
          motivo:       { type: 'string', description: 'Resumen breve de la solicitud del cliente.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'listar_caracteristicas',
      description: 'Devuelve la lista de lo que incluye el producto, servicio o paquete. Usar cuando el cliente pregunta qué incluye, qué trae, o qué ofrece.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obtener_cronograma',
      description: 'Devuelve el cronograma completo (día por día, o paso a paso) del evento, viaje o servicio. Usar cuando el cliente pregunta por el itinerario, horario, o agenda.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obtener_fechas_pago',
      description: 'Devuelve las fechas de depósitos, pagos programados y política de cancelación del producto o servicio.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calcular_presupuesto',
      description: 'Calcula el costo total y la distribución entre opciones según número de personas y tipo seleccionado. Usar cuando el cliente pide precios, cotizaciones o presupuestos para un grupo.',
      parameters: {
        type: 'object',
        properties: {
          numPersonas:  { type: 'integer', description: 'Número total de personas del grupo' },
          numAdultos:   { type: 'integer', description: 'Número de adultos' },
          numMenores:   { type: 'integer', description: 'Número de menores' },
          tipo:   { type: 'string', description: 'Tipo de opción seleccionada (según el catálogo del negocio).' },
        },
        required: ['numPersonas', 'numAdultos', 'numMenores'],
      },
    },
  },
];

const FUNCTION_MAP = {
  comunicar_asesor: notificarAsesor,
  enviar_correo_informacion: enviarCorreo,
  iniciar_cierre_venta: iniciarCierreVenta,
  listar_caracteristicas: obtenerQueIncluye,
  obtener_cronograma: obtenerItinerario,
  obtener_fechas_pago: obtenerFechasPago,
  calcular_presupuesto: calcularPlan,
};

// ─── Catálogo de funciones (para configuración por bot) ───────────────────

const FUNCTION_CATALOG = [
  {
    name: 'comunicar_asesor',
    label: '📞 Comunicar con un asesor',
    description: 'Notifica al equipo cuando el cliente pide hablar con una persona real (no es cierre de venta).',
  },
  {
    name: 'enviar_correo_informacion',
    label: '📧 Enviar información por correo',
    description: 'Envía al cliente la información que solicite a su correo electrónico.',
  },
  {
    name: 'iniciar_cierre_venta',
    label: '🤝 Cierre de venta',
    description: 'Registra los datos del cliente listo para comprar y notifica al equipo de ventas.',
  },
  {
    name: 'listar_caracteristicas',
    label: '📋 Listar lo que incluye',
    description: 'Devuelve la lista de lo que incluye el producto, servicio o paquete (configurable por bot).',
  },
  {
    name: 'obtener_cronograma',
    label: '🗓️ Cronograma / Itinerario',
    description: 'Devuelve el cronograma del evento o servicio, día por día o paso a paso (configurable por bot).',
  },
  {
    name: 'obtener_fechas_pago',
    label: '📅 Fechas de pago',
    description: 'Devuelve los depósitos, pagos y política de cancelación (configurable por bot).',
  },
  {
    name: 'calcular_presupuesto',
    label: '💰 Calcular presupuesto',
    description: 'Calcula el costo y distribución de opciones según personas y tipo (configurable por bot).',
  },
];

module.exports = { TOOLS, FUNCTION_MAP, FUNCTION_CATALOG };
