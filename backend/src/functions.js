/**
 * Business logic functions callable by the AI model.
 */

const { sendClientEmail } = require('./escalation');

/**
 * Calculate a custom plan with pricing breakdown.
 */
function calcularPlan({ numPersonas, numAdultos, numMenores, tipoCabina = 'interior' }) {
  // Pricing table from PDF
  const precios = {
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
function obtenerFechasPago() {
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
function obtenerQueIncluye() {
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
function obtenerItinerario() {
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
function iniciarCierreVenta({ nombre, telefono, email, num_personas, tipo_cabina, notas, motivo }) {
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
    return { ok: true, mensaje: `Información enviada correctamente a ${to}.` };
  }
  return { ok: false, error: result.error, mensaje: `No se pudo enviar el correo: ${result.error || 'error desconocido'}. Indícale al cliente que el envío falló.` };
}

// ─── Function definitions for DeepSeek tool calling ──────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'enviar_correo_informacion',
      description: 'Envía por correo electrónico (Resend) la información que el cliente solicitó. Debe llamarse cuando el cliente pide que le envíen precios, itinerarios, qué incluye el paquete, o cualquier información por email. IMPORTANTE: antes de llamarla, el cliente debe darte su correo electrónico; si no lo tienes, pídelo primero.',
      parameters: {
        type: 'object',
        properties: {
          email:    { type: 'string', description: 'Correo electrónico del cliente al que se enviará la información.' },
          informacion: { type: 'string', description: 'Contenido de la información solicitada (precios, itinerario, etc.). Usa los DATOS DEL EVENTO disponibles.' },
          asunto:   { type: 'string', description: 'Asunto breve del correo. Ej: "Precios de cabinas — Quinceañera MSC World America".' },
        },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calcular_plan',
      description: 'Calcula el costo total y distribución de cabinas para un grupo. Debe llamarse cuando el cliente pregunta por precios, planes o recomendaciones según número de personas.',
      parameters: {
        type: 'object',
        properties: {
          numPersonas:  { type: 'integer', description: 'Número total de personas' },
          numAdultos:   { type: 'integer', description: 'Número de adultos' },
          numMenores:   { type: 'integer', description: 'Número de menores de 17 años' },
          tipoCabina:   { type: 'string',  enum: ['interior', 'oceanView', 'balcony'], description: 'Tipo de cabina preferido. Si no se especifica, usar interior por defecto.' },
        },
        required: ['numPersonas', 'numAdultos', 'numMenores'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obtener_fechas_pago',
      description: 'Obtiene las fechas de depósitos, pago final y política de cancelación.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obtener_que_incluye',
      description: 'Obtiene la lista de todo lo que incluye el paquete de Quinceañera.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'obtener_itinerario',
      description: 'Obtiene el itinerario completo día por día del crucero.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'iniciar_cierre_venta',
      description: 'Usa esta función cuando el cliente está listo para comprar o reservar. IMPORTANTE: antes de llamarla, pídele al cliente sus datos de contacto (nombre y teléfono o correo). Si ya te los dio, procede. También pregunta cuántas personas viajarán y qué tipo de cabina prefiere.',
      parameters: {
        type: 'object',
        properties: {
          nombre:       { type: 'string', description: 'Nombre completo del cliente.' },
          telefono:     { type: 'string', description: 'Teléfono de contacto.' },
          email:        { type: 'string', description: 'Correo electrónico.' },
          num_personas: { type: 'integer', description: 'Número total de personas.' },
          tipo_cabina:  { type: 'string', enum: ['interior', 'oceanView', 'balcony'], description: 'Tipo de cabina.' },
          notas:        { type: 'string', description: 'Notas adicionales.' },
          motivo:       { type: 'string', description: 'Resumen breve de la solicitud del cliente.' },
        },
      },
    },
  },
];

const FUNCTION_MAP = {
  enviar_correo_informacion: enviarCorreo,
  calcular_plan: calcularPlan,
  obtener_fechas_pago: obtenerFechasPago,
  obtener_que_incluye: obtenerQueIncluye,
  obtener_itinerario: obtenerItinerario,
  iniciar_cierre_venta: iniciarCierreVenta,
};

// ─── Catálogo de funciones (para configuración por bot) ───────────────────

const FUNCTION_CATALOG = [
  {
    name: 'enviar_correo_informacion',
    label: '📧 Enviar información por correo',
    description: 'Envía al cliente la información que solicite (precios, itinerario, etc.) a su correo electrónico vía Resend.',
  },
  {
    name: 'calcular_plan',
    label: '💰 Calcular plan de precios',
    description: 'Calcula el costo total y distribución de cabinas para un grupo según número de personas y tipo de cabina.',
  },
  {
    name: 'obtener_fechas_pago',
    label: '📅 Fechas de pago',
    description: 'Devuelve los depósitos, pago final y política de cancelación del crucero.',
  },
  {
    name: 'obtener_que_incluye',
    label: '🎁 Qué incluye el paquete',
    description: 'Lista todo lo que incluye el paquete de Quinceañera (limusina, camisetas, pastel, vals, etc.).',
  },
  {
    name: 'obtener_itinerario',
    label: '🗓️ Itinerario',
    description: 'Itinerario completo día por día del crucero (20-27 marzo 2027).',
  },
  {
    name: 'iniciar_cierre_venta',
    label: '🤝 Cierre de venta',
    description: 'Registra los datos del cliente listo para comprar y notifica al asesor por correo.',
  },
];

module.exports = { TOOLS, FUNCTION_MAP, FUNCTION_CATALOG };
