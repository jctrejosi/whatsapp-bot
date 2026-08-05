import asyncio
import asyncpg
import json

LOCAL = "postgresql://knowledge:knowledge@localhost:5432/knowledge_db"
PROD = "postgresql://postgres:uMeugMxnImqRuEufeIgVeDtwBIqTHOYG@altaria.proxy.rlwy.net:23497/railway"

async def main():
    for url, label in [(LOCAL, "LOCAL"), (PROD, "PROD")]:
        conn = await asyncpg.connect(url)
        rows = await conn.fetch("SELECT bot_id, settings FROM bot_settings ORDER BY bot_id NULLS LAST")
        print(f"\n=== {label} ===")
        for r in rows:
            bot_id = str(r["bot_id"]) if r["bot_id"] else "GLOBAL"
            s = json.loads(r["settings"]) if isinstance(r["settings"], str) else r["settings"]
            prompt = s.get("systemPrompt", "")
            print(f"\n--- {bot_id} ---")
            print(f"  systemPrompt ({len(prompt)} chars):")
            print(f"  {prompt}")
        await conn.close()

asyncio.run(main())
