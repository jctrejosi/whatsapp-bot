/**
 * Business logic functions callable by the AI model.
 * Each function reads business data from the bot's settings (planPricing, planIncludes, etc.)
 * making them configurable per bot. Hardcoded values are fallback defaults (Quinceañeras cruise).
 */

const { sendClientEmail } = require('./escalation');
const { getSettings } = require('./settings');

/**
 * Calculate a custom plan with pricing breakdown.
 * Uses planPricing from bot settings, or hardcoded cruise defaults.
 */
async function calcularPlan({ numPersonas, numAdultos, numMenores, tipoCabina = 'interior' }, botId) {
  const settings = await getSettings(botId);
  const precios = settings.planPricing || {
    interior: { guest1_2: 1736.26, guest3_4: 1406.26, menor17: 955.26, cubiertas: '15-21' },
    oceanView: { guest1_2: 2006.26, guest3_4: 1566.26, menor17: 1065.26, cubiertas: '10-11' },
    balcony:   { guest1_2: 2166.26, guest3_4: 1666.26, menor17: 1135.26, cubiertas: '11-12' },
  };

  const p = precios[tipoCabina] || precios.interior;
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

  const nombres = { interior: 'Deluxe Interior (IR2)', oceanView: 'Infinity Ocean View (VL1)', balcony: 'Deluxe Balcony (BR2)' };

  return {
    tipoCabina: nombres[tipoCabina] || tipoCabina,
    cubiertas: p.cubiertas,
    totalPersonas: numPersonas,
    totalCabinas: cabinas.length,
    cabinas,
    total: Math.round(total * 100) / 100,
    nota: 'Precios todo incluido: crucero, impuestos, bebidas, wifi y evento Quinceañeras.',
  };
}

/**
 * Get deposit and payment schedule.
 */
async function obtenerFechasPago(args, botId) {
  const settings = await getSettings(botId);
  if (settings.planPayments) return settings.planPayments;
  return {
    primerDeposito: { monto: 200, moneda: 'USD', fecha: 'Inmediato al reservar' },
    segundoDeposito: { monto: 400, moneda: 'USD', fecha: '10 de septiembre de 2026' },
    pagoFinal: { fecha: '15 de diciembre de 2026' },
    cancelacion: 'Depósito de $100 USD no reembolsable si se cancela antes de la fecha de pago final. No reembolsable después.',
  };
}

/**
 * Get what's included in the package.
 */
async function obtenerQueIncluye(args, botId) {
  const settings = await getSettings(botId);
  if (settings.planIncludes) return settings.planIncludes;
  return [
    'Transporte en Party Limo al puerto de Miami (Quinceañera + 1 invitado)',
    'Camiseta para la Quinceañera',
    'Camisetas para familiares y amigos',
    'Regalo para la Quinceañera',
    'Tratamiento deluxe en cabina la noche de llegada',
    'Fiesta de bienvenida el primer día con bebidas incluidas',
    'Salón exclusivo con DJ y barra libre',
    'Sesión de fotos grupal de 1 hora con archivos digitales',
    'Pastel de 3 pisos en la cena principal',
    'Vals con los padres',
    'Desayuno en cabina la mañana después de la ceremonia',
    'Actividades y entretenimiento durante el crucero',
  ];
}

/**
 * Get the cruise itinerary.
 */
async function obtenerItinerario(args, botId) {
  const settings = await getSettings(botId);
  if (settings.planItinerary) return settings.planItinerary;
  return {
    dias: [
      { dia: 1, fecha: '20 mar 2027', lugar: 'Miami, Florida', evento: 'Embarque 6:00 PM — Fiesta de bienvenida' },
      { dia: 2, fecha: '21 mar 2027', lugar: 'Navegación', evento: 'Ensayo de vals — Noche temática MSC' },
      { dia: 3, fecha: '22 mar 2027', lugar: 'Puerto Plata, Rep. Dominicana', evento: 'Llegada 9:00 AM' },
      { dia: 4, fecha: '23 mar 2027', lugar: 'San Juan, Puerto Rico', evento: 'Llegada 9:00 AM' },
      { dia: 5, fecha: '24 mar 2027', lugar: 'Navegación', evento: 'Desayuno en cabina para la Quinceañera' },
      { dia: 6, fecha: '25 mar 2027', lugar: 'Navegación', evento: 'Peinado, maquillaje, Gala Quinceañera con DJ, vals, fotos' },
      { dia: 7, fecha: '26 mar 2027', lugar: 'Ocean Cay, Bahamas', evento: 'Llegada 8:00 AM — Fiesta de despedida' },
      { dia: 8, fecha: '27 mar 2027', lugar: 'Miami, Florida', evento: 'Desembarque 7:00 AM' },
    ],
  };
}

/**
 * Sales closing — registers the lead and triggers escalation to a human advisor.
 * The `_escalate` flag is detected by chatWithDeepSeek to send the email.
 */
async function iniciarCierreVenta({ nombre, telefono, email, num_personas, tipo_cabina, notas, motivo }, botId) {
  return {
    ok: true,
    lead: {
      nombre: nombre || '',
      telefono: telefono || '',
      email: email || '',
      num_personas: num_personas || null,
      tipo_cabina: tipo_cabina || '',
      notas: notas || '',
      motivo: motivo || 'Interesado en el crucero de Quinceañeras',
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
    subject: asunto || 'Información solicitada — Quinceañera Cruise Bot',
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
      description: 'Usa esta función cuando el cliente está listo para comprar o reservar. IMPORTANTE: antes de llamarla, pídele al cliente sus datos de contacto (nombre y teléfono o correo). También pregunta cuántas personas serán y qué opción prefiere.',
      parameters: {
        type: 'object',
        properties: {
          nombre:       { type: 'string', description: 'Nombre completo del cliente.' },
          telefono:     { type: 'string', description: 'Teléfono de contacto.' },
          email:        { type: 'string', description: 'Correo electrónico.' },
          num_personas: { type: 'integer', description: 'Número total de personas.' },
          tipo_cabina:  { type: 'string', description: 'Tipo de opción preferida por el cliente.' },
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
          tipoCabina:   { type: 'string', description: 'Tipo de opción seleccionada (según el catálogo del negocio).' },
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
