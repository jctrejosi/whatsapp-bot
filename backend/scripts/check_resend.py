import asyncio, asyncpg, json

LOCAL = "postgresql://knowledge:knowledge@localhost:5432/knowledge_db"
PROD = "postgresql://postgres:uMeugMxnImqRuEufeIgVeDtwBIqTHOYG@altaria.proxy.rlwy.net:23497/railway"

async def main():
    for url, label in [(LOCAL, "LOCAL"), (PROD, "PROD")]:
        conn = await asyncpg.connect(url)
        rows = await conn.fetch("SELECT bot_id, settings FROM bot_settings WHERE bot_id IS NOT NULL")
        for r in rows:
            s = json.loads(r["settings"]) if isinstance(r["settings"], str) else r["settings"]
            if isinstance(s, str): s = json.loads(s)
            print(f"\n{label} — bot {r['bot_id']}")
            print(f"  senderEmail:      {s.get('senderEmail')}")
            print(f"  resendApiKey:     {s.get('resendApiKey', '')[:15]}...")
            print(f"  escalationEmails: {s.get('escalationEmails')}")
        await conn.close()

asyncio.run(main())
