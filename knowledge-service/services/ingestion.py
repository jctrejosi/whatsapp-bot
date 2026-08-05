"""Ingestion pipeline: orchestrates extraction → chunking → embedding → storage."""

import json
import os
import uuid
from datetime import datetime, timezone

import asyncpg

from database import get_pool

from .chunking import chunk_text
from .embedding import embed_texts, embedding_enabled
from .extraction import extract_pdf, extract_pdf_bytes


# ─── Step logging ────────────────────────────────────────────────────────────

async def _log_step(conn: asyncpg.Connection, job_id: str, step: str, message: str):
    await conn.execute(
        """
        UPDATE ingestion_jobs
        SET step_log = step_log || $1::jsonb
        WHERE id = $2
        """,
        json.dumps([{"timestamp": datetime.now(timezone.utc).isoformat(), "step": step, "message": message}]),
        job_id,
    )


# ─── Main ingestion function ─────────────────────────────────────────────────

async def run_ingestion(job_id: str) -> None:
    """Execute the full ingestion pipeline for a given job."""
    pool = await get_pool()

    async with pool.acquire() as conn:
        # Load job
        job = await conn.fetchrow("SELECT * FROM ingestion_jobs WHERE id = $1", job_id)
        if not job:
            raise ValueError(f"Job {job_id} not found")

        source_id = job["source_id"]
        source = await conn.fetchrow("SELECT * FROM knowledge_sources WHERE id = $1", source_id)
        if not source:
            raise ValueError(f"Source {source_id} not found")

        try:
            # ── Step 1: Mark job as extracting ──
            await conn.execute(
                "UPDATE ingestion_jobs SET status = 'extracting', started_at = NOW() WHERE id = $1",
                job_id,
            )
            await _log_step(conn, job_id, "extracting", "Starting extraction")

            # ── Step 2: Extract text (from file, URL, or manual) ──
            full_text = ""
            result_pages = []

            if source["source_type"] == "file" and source["file_path"]:
                full_path = source["file_path"]
                result = extract_pdf(full_path)
                full_text = result.full_text
                result_pages = result.pages
            elif source["source_type"] == "url":
                # TODO: implement URL fetching
                raise NotImplementedError("URL ingestion not yet implemented")
            elif source["source_type"] == "manual" and source["raw_text"]:
                full_text = source["raw_text"]
            else:
                raise ValueError(f"No content to extract for source {source_id}")

            await _log_step(conn, job_id, "extracting", f"Extracted {len(full_text)} chars from {len(result_pages)} pages")

            # ── Step 3: Create document record ──
            doc_id = uuid.uuid4()
            await conn.execute(
                """
                INSERT INTO knowledge_documents (id, source_id, title, content, page_count, char_count, metadata)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                """,
                doc_id,
                source_id,
                source["title"],
                full_text,
                len(result_pages) or None,
                len(full_text),
                json.dumps({"source_type": source["source_type"]}),
            )

            await conn.execute(
                "UPDATE ingestion_jobs SET progress = 30 WHERE id = $1", job_id
            )
            await _log_step(conn, job_id, "document_created", f"Document {doc_id} created")

            # ── Step 4: Chunking ──
            await conn.execute(
                "UPDATE ingestion_jobs SET status = 'chunking' WHERE id = $1", job_id
            )

            chunks = chunk_text(full_text, strategy="sections")
            await _log_step(conn, job_id, "chunking", f"Created {len(chunks)} chunks")

            # ── Step 5: Store chunks ──
            chunk_ids = []
            for i, chunk_content in enumerate(chunks):
                cid = uuid.uuid4()
                await conn.execute(
                    """
                    INSERT INTO knowledge_chunks (id, document_id, chunk_index, content, char_count)
                    VALUES ($1, $2, $3, $4, $5)
                    """,
                    cid, doc_id, i, chunk_content, len(chunk_content),
                )
                chunk_ids.append(cid)

            await conn.execute(
                "UPDATE ingestion_jobs SET progress = 60 WHERE id = $1", job_id
            )
            await _log_step(conn, job_id, "chunks_stored", f"Stored {len(chunk_ids)} chunks")

            # ── Step 6: Generate embeddings (opcional según proveedor) ──
            await conn.execute(
                "UPDATE ingestion_jobs SET status = 'embedding' WHERE id = $1", job_id
            )

            if embedding_enabled():
                batch_size = 20
                for batch_start in range(0, len(chunks), batch_size):
                    batch_end = min(batch_start + batch_size, len(chunks))
                    batch_chunks = chunks[batch_start:batch_end]
                    batch_ids = chunk_ids[batch_start:batch_end]

                    vectors = await embed_texts(batch_chunks)

                    for cid, vec in zip(batch_ids, vectors):
                        await conn.execute(
                            """
                            INSERT INTO knowledge_embeddings (chunk_id, embedding, model_name, dimension)
                            VALUES ($1, $2, $3, $4)
                            """,
                            cid,
                            _format_vector(vec),
                            "text-embedding-3-small-512",
                            len(vec),
                        )

                    progress = 60 + int(40 * batch_end / len(chunks))
                    await conn.execute(
                        "UPDATE ingestion_jobs SET progress = $1 WHERE id = $2",
                        progress, job_id,
                    )
                    await _log_step(conn, job_id, "embedding", f"Embedded chunks {batch_start+1}-{batch_end} of {len(chunks)}")
            else:
                # Sin embeddings: los chunks quedan con is_embedded=false y la
                # búsqueda usa el reranker de DeepSeek para el ranking semántico.
                await _log_step(
                    conn, job_id, "embedding",
                    "Embeddings deshabilitados (EMBEDDING_PROVIDER=none) — se usará el reranker",
                )

            # ── Step 7: Mark completed ──
            await conn.execute(
                """
                UPDATE ingestion_jobs
                SET status = 'completed', progress = 100, completed_at = NOW()
                WHERE id = $1
                """,
                job_id,
            )
            await conn.execute(
                "UPDATE knowledge_sources SET status = 'completed' WHERE id = $1",
                source_id,
            )
            await _log_step(conn, job_id, "completed", "Ingestion completed successfully")

        except Exception as exc:
            await conn.execute(
                """
                UPDATE ingestion_jobs
                SET status = 'failed', error_message = $2
                WHERE id = $1
                """,
                job_id,
                str(exc),
            )
            await conn.execute(
                "UPDATE knowledge_sources SET status = 'failed', error_message = $2 WHERE id = $1",
                source_id,
                str(exc),
            )
            await _log_step(conn, job_id, "failed", str(exc))
            raise


def _format_vector(vec: list[float]) -> str:
    """Format a Python float list into a pgvector-compatible string: '[1.0,2.0,...]'."""
    return "[" + ",".join(str(v) for v in vec) + "]"
