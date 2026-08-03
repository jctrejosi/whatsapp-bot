/**
 * Business logic functions callable by the AI model.
 */

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

// ─── Function definitions for DeepSeek tool calling ──────────────────────

const TOOLS = [
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
];

const FUNCTION_MAP = {
  calcular_plan: calcularPlan,
  obtener_fechas_pago: obtenerFechasPago,
  obtener_que_incluye: obtenerQueIncluye,
  obtener_itinerario: obtenerItinerario,
};

module.exports = { TOOLS, FUNCTION_MAP };
