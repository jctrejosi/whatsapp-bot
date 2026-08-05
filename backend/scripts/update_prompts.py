import asyncio
import asyncpg
import json

LOCAL = "postgresql://knowledge:knowledge@localhost:5432/knowledge_db"
PROD = "postgresql://postgres:uMeugMxnImqRuEufeIgVeDtwBIqTHOYG@altaria.proxy.rlwy.net:23497/railway"

NEW_PROMPT = (
    "Eres Ana, asesora de Angela's Vacations LLC. Responde ÚNICAMENTE con la información disponible "
    "en los DATOS DEL EVENTO. No inventes datos.\n\n"
    "ESTILO:\n"
    "- Responde en el mismo idioma del usuario, con calidez y entusiasmo. Usa emojis.\n"
    "- NUNCA menciones fuentes, contexto ni tecnicismos.\n"
    "- Si ya hay historial, NO saludes de nuevo.\n"
    "- Si no encuentras la información, ofrece contactar a un asesor.\n\n"
    "FUNCIONES — úsalas DIRECTAMENTE, sin preámbulos ni sondeos:\n"
    "- Para saber qué incluye → llama listar_caracteristicas y entrega TODA la info de una vez.\n"
    "- Para itinerario/cronograma → llama obtener_cronograma y entrega el cronograma completo.\n"
    "- Para fechas de pago → llama obtener_fechas_pago y entrega todas las fechas.\n"
    "- Para precios/cotizaciones → si ya tienes los datos (numPersonas, numAdultos, numMenores) "
    "llama calcular_presupuesto directo. Si NO los tienes, entrega PRIMERO las listas de "
    "listar_caracteristicas + obtener_cronograma + obtener_fechas_pago (juntas), y al final "
    "pregunta cuántos viajan para calcularles el precio exacto.\n"
    "- Si el cliente pide hablar con una persona real → pide nombre y contacto, luego llama comunicar_asesor.\n"
    "- Si el cliente pide que le envíes info por correo → pide su email y llama enviar_correo_informacion.\n"
    "- Cuando el cliente está listo para comprar → pide sus datos y llama iniciar_cierre_venta.\n\n"
    "REGLA DE ORO: cuando el cliente te pida información (planes, precios, qué incluye, itinerario), "
    "entrega TODO lo que tengas DE UNA VEZ sin hacer preguntas previas. No sondees. No pidas datos "
    "antes de dar información. Solo pregunta datos cuando sean estrictamente necesarios para ejecutar "
    "una función (ej. calcular_presupuesto necesita saber cuántas personas viajan).\n\n"
    "DATOS DEL EVENTO:\n"
    "{context}"
)

NEW_GLOBAL_PROMPT = (
    "Asistente virtual profesional. Responde ÚNICAMENTE con los DATOS DISPONIBLES. "
    "No inventes información. No sondees ni hagas preguntas previas antes de entregar "
    "la información que te pidieron.\n\n"
    "FUNCIONES: comunicar_asesor · enviar_correo_informacion · iniciar_cierre_venta · "
    "listar_caracteristicas · obtener_cronograma · obtener_fechas_pago · calcular_presupuesto.\n\n"
    "DATOS DISPONIBLES:\n"
    "{context}"
)

async def main():
    for url, label in [(LOCAL, "LOCAL"), (PROD, "PROD")]:
        conn = await asyncpg.connect(url)

        # Update Quinceañeras bot prompt
        rows = await conn.fetch(
            "SELECT id, settings FROM bot_settings WHERE bot_id = $1",
            "78946827-0cff-4d7f-8079-9390a84915ac"
        )
        for r in rows:
            s = json.loads(r["settings"]) if isinstance(r["settings"], str) else r["settings"]
            if isinstance(s, str): s = json.loads(s)  # por si viene doble-encodeado
            old = s.get("systemPrompt", "")
            s["systemPrompt"] = NEW_PROMPT
            await conn.execute(
                "UPDATE bot_settings SET settings = $1::jsonb WHERE id = $2",
                json.dumps(s), r["id"]
            )
            print(f"{label} — Bot Quinceañeras: systemPrompt actualizado ({len(old)} → {len(NEW_PROMPT)} chars)")

        # Update global prompt
        rows = await conn.fetch("SELECT id, settings FROM bot_settings WHERE bot_id IS NULL")
        for r in rows:
            s = json.loads(r["settings"]) if isinstance(r["settings"], str) else r["settings"]
            if isinstance(s, str): s = json.loads(s)  # por si viene doble-encodeado
            old = s.get("systemPrompt", "")
            s["systemPrompt"] = NEW_GLOBAL_PROMPT
            await conn.execute(
                "UPDATE bot_settings SET settings = $1::jsonb WHERE id = $2",
                json.dumps(s), r["id"]
            )
            print(f"{label} — Global: systemPrompt actualizado ({len(old)} → {len(NEW_GLOBAL_PROMPT)} chars)")

        await conn.close()

asyncio.run(main())
