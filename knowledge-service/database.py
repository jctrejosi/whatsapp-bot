"""PostgreSQL connection pool with asyncpg."""

import os
from contextlib import asynccontextmanager

import asyncpg
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/knowledge_db")

_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    """Return the global connection pool, creating it if necessary."""
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)
    return _pool


async def close_pool() -> None:
    """Close the connection pool gracefully."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


@asynccontextmanager
async def get_connection():
    """Context manager that yields a connection from the pool."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        yield conn


async def run_migrations() -> None:
    """Run SQL migration files in order."""
    import glob

    migrations_dir = os.path.join(os.path.dirname(__file__), "migrations")
    files = sorted(glob.glob(os.path.join(migrations_dir, "*.sql")))

    pool = await get_pool()
    async with pool.acquire() as conn:
        for path in files:
            with open(path) as f:
                sql = f.read()
            await conn.execute(sql)
            print(f"✓ Migración ejecutada: {os.path.basename(path)}")
