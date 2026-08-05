"""Query local DB: bots + knowledge data."""
import asyncio

import asyncpg

URL = "postgresql://knowledge:knowledge@localhost:5432/knowledge_db"


async def main():
    conn = await asyncpg.connect(URL, timeout=10)

    print("=== BOTS ===")
    rows = await conn.fetch("SELECT id, name, created_at FROM bots ORDER BY created_at")
    for r in rows:
        print(f"  {r['id']} | {r['name']!r} | created {r['created_at']}")

    if not rows:
        print("  (no bots)")
        await conn.close()
        return

    print("\n=== DATA PER BOT ===")
    for r in rows:
        bot_id = r["id"]
        name = r["name"]
        src = await conn.fetchval("SELECT count(*) FROM knowledge_sources WHERE bot_id = $1", bot_id)
        src_done = await conn.fetchval(
            "SELECT count(*) FROM knowledge_sources WHERE bot_id = $1 AND status = 'completed'", bot_id,
        )
        docs = await conn.fetchval(
            "SELECT count(*) FROM knowledge_documents d JOIN knowledge_sources s ON s.id = d.source_id WHERE s.bot_id = $1", bot_id,
        )
        chunks = await conn.fetchval(
            "SELECT count(*) FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id JOIN knowledge_sources s ON s.id = d.source_id WHERE s.bot_id = $1", bot_id,
        )
        emb = await conn.fetchval(
            "SELECT count(*) FROM knowledge_embeddings e JOIN knowledge_chunks c ON c.id = e.chunk_id JOIN knowledge_documents d ON d.id = c.document_id JOIN knowledge_sources s ON s.id = d.source_id WHERE s.bot_id = $1", bot_id,
        )
        title = await conn.fetchval(
            "SELECT title FROM knowledge_sources WHERE bot_id = $1 LIMIT 1", bot_id,
        )
        print(f"  {name!r}: sources={src} (done={src_done}) docs={docs} chunks={chunks} emb={emb}")
        if title:
            print(f"    source: {title!r}")

    await conn.close()


asyncio.run(main())
