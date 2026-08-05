"""Semantic search over knowledge chunks using pgvector."""

import asyncio

import asyncpg

from database import get_pool

from .embedding import embed_text
from .ingestion import _format_vector


async def search_chunks(
    query: str,
    top_k: int = 5,
    min_similarity: float = 0.0,
    bot_id: str | None = None,
) -> list[dict]:
    """
    Search for the most relevant chunks given a text query.
    If bot_id is provided, only chunks belonging to that bot's sources are returned.
    """
    query_vec = await embed_text(query)
    vec_str = _format_vector(query_vec)

    pool = await get_pool()
    async with pool.acquire() as conn:
        if bot_id:
            rows = await conn.fetch(
                """
                SELECT
                    c.id          AS chunk_id,
                    c.content     AS chunk_content,
                    c.chunk_index,
                    d.id          AS document_id,
                    d.title       AS document_title,
                    1 - (e.embedding <=> $1::vector) AS similarity
                FROM knowledge_embeddings e
                JOIN knowledge_chunks    c ON c.id = e.chunk_id
                JOIN knowledge_documents d ON d.id = c.document_id
                JOIN knowledge_sources   s ON s.id = d.source_id
                WHERE s.bot_id = $4
                  AND 1 - (e.embedding <=> $1::vector) >= $2
                ORDER BY e.embedding <=> $1::vector
                LIMIT $3
                """,
                vec_str, min_similarity, top_k, bot_id,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT
                    c.id          AS chunk_id,
                    c.content     AS chunk_content,
                    c.chunk_index,
                    d.id          AS document_id,
                    d.title       AS document_title,
                    1 - (e.embedding <=> $1::vector) AS similarity
                FROM knowledge_embeddings e
                JOIN knowledge_chunks    c ON c.id = e.chunk_id
                JOIN knowledge_documents d ON d.id = c.document_id
                WHERE 1 - (e.embedding <=> $1::vector) >= $2
                ORDER BY e.embedding <=> $1::vector
                LIMIT $3
                """,
                vec_str, min_similarity, top_k,
            )

    return [
        {
            "chunk_id": str(r["chunk_id"]),
            "content": r["chunk_content"],
            "chunk_index": r["chunk_index"],
            "document_id": str(r["document_id"]),
            "document_title": r["document_title"],
            "similarity": round(r["similarity"], 4),
        }
        for r in rows
    ]
