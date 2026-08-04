"""Inspect the production DB: extensions, tables, row counts."""
import asyncio

import asyncpg

URL = "postgresql://postgres:uMeugMxnImqRuEufeIgVeDtwBIqTHOYG@altaria.proxy.rlwy.net:23497/railway"


async def main():
    conn = await asyncpg.connect(URL, timeout=30)
    print("server:", await conn.fetchval("SELECT version()"))
    ext = await conn.fetch(
        "SELECT extname, extversion FROM pg_extension ORDER BY extname"
    )
    print("extensions:", [(r["extname"], r["extversion"]) for r in ext])

    tables = await conn.fetch(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='public' ORDER BY table_name"
    )
    print("tables:", [r["table_name"] for r in tables])
    for r in tables:
        name = r["table_name"]
        try:
            cnt = await conn.fetchval(f'SELECT count(*) FROM "{name}"')
            print(f"  {name}: {cnt} rows")
        except Exception as exc:
            print(f"  {name}: ERROR {exc}")
    await conn.close()


asyncio.run(main())
