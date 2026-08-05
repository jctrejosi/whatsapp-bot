import asyncio, asyncpg, os

LOCAL = "postgresql://knowledge:knowledge@localhost:5432/knowledge_db"

async def main():
    conn = await asyncpg.connect(LOCAL)
    rows = await conn.fetch("SELECT id, original_filename, file_path, cloudinary_url, status FROM knowledge_sources")
    for r in rows:
        path = r["file_path"]
        exists = os.path.exists(path) if path else False
        print(f"source: {r['id']}")
        print(f"  filename: {r['original_filename']}")
        print(f"  file_path: {path}")
        print(f"  exists locally: {exists}")
        print(f"  cloudinary_url: {r['cloudinary_url']}")
        print(f"  status: {r['status']}")
    await conn.close()

asyncio.run(main())
