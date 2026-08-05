import asyncio, asyncpg, json

LOCAL = "postgresql://knowledge:knowledge@localhost:5432/knowledge_db"
PROD = "postgresql://postgres:uMeugMxnImqRuEufeIgVeDtwBIqTHOYG@altaria.proxy.rlwy.net:23497/railway"

async def main():
    local = await asyncpg.connect(LOCAL)
    prod = await asyncpg.connect(PROD)

    # Get local settings for Quinceañeras bot
    rows = await local.fetch(
        "SELECT id, settings FROM bot_settings WHERE bot_id = '78946827-0cff-4d7f-8079-9390a84915ac'"
    )
    for r in rows:
        s = json.loads(r["settings"]) if isinstance(r["settings"], str) else r["settings"]
        if isinstance(s, str): s = json.loads(s)
        
        # Upsert into prod
        s_json = json.dumps(s)
        existing = await prod.fetchrow(
            "SELECT id FROM bot_settings WHERE bot_id = '78946827-0cff-4d7f-8079-9390a84915ac'"
        )
        if existing:
            await prod.execute(
                "UPDATE bot_settings SET settings = $1::jsonb WHERE bot_id = '78946827-0cff-4d7f-8079-9390a84915ac'",
                s_json
            )
            print(f"PROD — settings de Quinceañeras actualizados")
        else:
            await prod.execute(
                "INSERT INTO bot_settings (bot_id, settings) VALUES ('78946827-0cff-4d7f-8079-9390a84915ac', $1::jsonb)",
                s_json
            )
            print(f"PROD — settings de Quinceañeras insertados")

        print(f"  senderEmail: {s.get('senderEmail')}")
        print(f"  resendApiKey: {s.get('resendApiKey', '')[:20]}...")
        print(f"  systemPrompt: {len(s.get('systemPrompt', ''))} chars")

    # Also sync global settings
    rows = await local.fetch("SELECT id, settings FROM bot_settings WHERE bot_id IS NULL")
    for r in rows:
        s = json.loads(r["settings"]) if isinstance(r["settings"], str) else r["settings"]
        if isinstance(s, str): s = json.loads(s)
        s_json = json.dumps(s)
        existing = await prod.fetchrow("SELECT id FROM bot_settings WHERE bot_id IS NULL")
        if existing:
            await prod.execute("UPDATE bot_settings SET settings = $1::jsonb WHERE bot_id IS NULL", s_json)
            print("PROD — global settings actualizados")
        else:
            await prod.execute("INSERT INTO bot_settings (bot_id, settings) VALUES (NULL, $1::jsonb)", s_json)
            print("PROD — global settings insertados")

    await local.close()
    await prod.close()

asyncio.run(main())
