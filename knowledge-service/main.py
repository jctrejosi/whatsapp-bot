"""Knowledge Service — FastAPI application.

Endpoints:
  POST /ingest         — Upload PDF → full ingestion pipeline
  GET  /sources        — List knowledge sources
  GET  /sources/{id}   — Source detail with chunks
  POST /search         — Semantic search (RAG retrieval)
  POST /conversations  — Log conversation
  GET  /health         — Health check
"""

import json
import os
import uuid
import tempfile
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

from database import get_pool, close_pool, run_migrations
from services.embedding import close_client
from services.extraction import extract_pdf_bytes
from services.ingestion import run_ingestion
from services.search import search_chunks

load_dotenv()


# ─── Lifespan ────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        await run_migrations()
    except Exception as exc:
        print(f"⚠️  Migrations skipped (DB not available): {exc}")
    yield
    await close_pool()
    await close_client()


app = FastAPI(
    title="Knowledge Service",
    description="RAG knowledge base — PostgreSQL + pgvector + DeepSeek embeddings",
    version="1.0.0",
    lifespan=lifespan,
)


# ─── Schemas ─────────────────────────────────────────────────────────────────

class SourceResponse(BaseModel):
    id: str
    source_type: str
    title: str
    description: Optional[str]
    status: str
    error_message: Optional[str]
    created_at: str
    updated_at: str


class SearchRequest(BaseModel):
    query: str
    top_k: int = 5
    min_similarity: float = 0.0
    use_reranker: bool = False  # Use DeepSeek V4 Pro to re-rank results


class SearchResult(BaseModel):
    chunk_id: str
    content: str
    chunk_index: int
    document_id: str
    document_title: str
    similarity: float | None
    rerank_score: float | None = None
    rerank_position: int | None = None


class SearchResponse(BaseModel):
    query: str
    results: list[SearchResult]


class ConversationRequest(BaseModel):
    user_id: str
    user_name: Optional[str] = ""
    message: str
    response: str
    chunks_used: list[str] = []


class ChatRequest(BaseModel):
    query: str
    user_id: str = "admin"
    user_name: str = "Admin"


class ChatResponse(BaseModel):
    query: str
    answer: str
    chunks_used: list[SearchResult] = []


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.post("/ingest", status_code=201)
async def ingest_pdf(file: UploadFile = File(...)):
    """
    Upload a PDF file and trigger the full ingestion pipeline:
    extract → chunk → embed → store in pgvector.
    The file is processed in memory — nothing is saved to disk.
    """
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Solo se aceptan archivos PDF")

    contents = await file.read()

    # Extract metadata from PDF bytes (in memory)
    extract_result = extract_pdf_bytes(contents)

    # Save bytes to a temp file just for the ingestion pipeline
    fd, tmp_path = tempfile.mkstemp(suffix=".pdf")
    os.write(fd, contents)
    os.close(fd)

    pool = await get_pool()

    async with pool.acquire() as conn:
        source_id = uuid.uuid4()
        await conn.execute(
            """
            INSERT INTO knowledge_sources
                (id, source_type, title, description,
                 original_filename, file_path, file_type, file_size_bytes,
                 status, metadata)
            VALUES ($1, 'file', $2, $3, $4, $5, $6, $7, 'pending', $8)
            """,
            source_id,
            extract_result.metadata.get("title") or file.filename,
            f"PDF — {extract_result.total_pages} páginas, {extract_result.total_chars} caracteres",
            file.filename,
            tmp_path,
            file.content_type or "application/pdf",
            len(contents),
            json.dumps({"pdf_metadata": extract_result.metadata} if extract_result.metadata else {}),
        )

    # Create ingestion job
    job_id = uuid.uuid4()
    await conn.execute(
        "INSERT INTO ingestion_jobs (id, source_id) VALUES ($1, $2)",
        job_id, source_id,
    )

    # Run ingestion pipeline (don't await — it runs in background via FastAPI BackgroundTasks)
    import asyncio as _asyncio
    _asyncio.create_task(_safe_ingest(job_id))

    return {
        "source_id": str(source_id),
        "job_id": str(job_id),
        "filename": file.filename,
        "status": "processing",
        "message": "Ingestion started. Check GET /sources/{source_id} for status.",
    }


async def _safe_ingest(job_id: str):
    """Wrapper to catch errors and clean up temp files after ingestion."""
    pool = await get_pool()
    tmp_path = None
    try:
        # Look up the temp file path before ingestion
        job = await pool.fetchrow(
            "SELECT s.file_path FROM ingestion_jobs j JOIN knowledge_sources s ON s.id = j.source_id WHERE j.id = $1",
            job_id,
        )
        tmp_path = job["file_path"] if job else None

        await run_ingestion(job_id)
    except Exception as exc:
        print(f"Ingestion job {job_id} failed: {exc}")
    finally:
        # Clean up temp file and clear the path from the source record
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
                print(f"Temp file cleaned: {tmp_path}")
            except OSError:
                pass


@app.get("/sources")
async def list_sources(status: Optional[str] = None):
    """List all knowledge sources, optionally filtered by status."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        if status:
            rows = await conn.fetch(
                "SELECT * FROM knowledge_sources WHERE status = $1 ORDER BY created_at DESC",
                status,
            )
        else:
            rows = await conn.fetch(
                "SELECT * FROM knowledge_sources ORDER BY created_at DESC"
            )

    return [
        {
            "id": str(r["id"]),
            "source_type": r["source_type"],
            "title": r["title"],
            "description": r["description"],
            "status": r["status"],
            "error_message": r["error_message"],
            "original_filename": r["original_filename"],
            "file_type": r["file_type"],
            "file_size_bytes": r["file_size_bytes"],
            "created_at": r["created_at"].isoformat(),
            "updated_at": r["updated_at"].isoformat(),
        }
        for r in rows
    ]


@app.get("/sources/{source_id}")
async def get_source(source_id: str):
    """Get a source, its documents, chunks, and ingestion job status."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        source = await conn.fetchrow(
            "SELECT * FROM knowledge_sources WHERE id = $1", source_id
        )
        if not source:
            raise HTTPException(404, "Source not found")

        documents = await conn.fetch(
            "SELECT * FROM knowledge_documents WHERE source_id = $1", source_id
        )

        docs_out = []
        for doc in documents:
            chunks = await conn.fetch(
                """
                SELECT c.id, c.chunk_index, c.content, c.char_count,
                       e.embedding IS NOT NULL AS has_embedding
                FROM knowledge_chunks c
                LEFT JOIN knowledge_embeddings e ON e.chunk_id = c.id
                WHERE c.document_id = $1
                ORDER BY c.chunk_index
                """,
                doc["id"],
            )
            docs_out.append({
                "id": str(doc["id"]),
                "title": doc["title"],
                "page_count": doc["page_count"],
                "char_count": doc["char_count"],
                "chunks": [
                    {
                        "id": str(c["id"]),
                        "index": c["chunk_index"],
                        "content_preview": c["content"][:200],
                        "char_count": c["char_count"],
                        "has_embedding": c["has_embedding"],
                    }
                    for c in chunks
                ],
            })

        jobs = await conn.fetch(
            """
            SELECT * FROM ingestion_jobs
            WHERE source_id = $1
            ORDER BY created_at DESC
            LIMIT 1
            """,
            source_id,
        )

        return {
            "source": {
                "id": str(source["id"]),
                "source_type": source["source_type"],
                "title": source["title"],
                "description": source["description"],
                "status": source["status"],
                "error_message": source["error_message"],
                "original_filename": source["original_filename"],
                "file_type": source["file_type"],
                "file_size_bytes": source["file_size_bytes"],
                "metadata": source["metadata"],
                "created_at": source["created_at"].isoformat(),
                "updated_at": source["updated_at"].isoformat(),
            },
            "documents": docs_out,
            "last_job": {
                "id": str(jobs[0]["id"]),
                "status": jobs[0]["status"],
                "progress": jobs[0]["progress"],
                "error_message": jobs[0]["error_message"],
                "log": jobs[0]["step_log"],
                "started_at": jobs[0]["started_at"].isoformat() if jobs[0]["started_at"] else None,
                "completed_at": jobs[0]["completed_at"].isoformat() if jobs[0]["completed_at"] else None,
            } if jobs else None,
        }


@app.post("/search")
async def search(req: SearchRequest) -> SearchResponse:
    """Semantic search over the knowledge base with optional DeepSeek reranking."""
    results = await search_chunks(
        query=req.query,
        top_k=req.top_k * (3 if req.use_reranker else 1),  # fetch more for reranker
        min_similarity=req.min_similarity,
    )

    if req.use_reranker and len(results) > 1:
        from services.reranker import rerank
        results = await rerank(req.query, results, top_k=req.top_k)

    return SearchResponse(query=req.query, results=[SearchResult(**r) for r in results])


# ─── Chat helper ───────────────────────────────────────────────────────────

async def _call_deepseek_chat(system_prompt: str, user_message: str) -> str:
    """Call DeepSeek V4 Flash chat API."""
    import httpx
    client = httpx.AsyncClient(
        headers={
            "Authorization": f"Bearer {os.getenv('DEEPSEEK_API_KEY')}",
            "Content-Type": "application/json",
        },
        timeout=45.0,
    )
    resp = await client.post(
        "https://api.deepseek.com/v1/chat/completions",
        json={
            "model": "deepseek-v4-flash",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            "temperature": 0.7,
            "max_tokens": 800,
        },
    )
    resp.raise_for_status()
    body = resp.json()
    content = body["choices"][0]["message"]["content"]
    await client.aclose()

    if not content or not content.strip():
        # Retry with more tokens
        client2 = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {os.getenv('DEEPSEEK_API_KEY')}",
                "Content-Type": "application/json",
            },
            timeout=45.0,
        )
        resp2 = await client2.post(
            "https://api.deepseek.com/v1/chat/completions",
            json={
                "model": "deepseek-v4-flash",
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                "temperature": 0.7,
                "max_tokens": 1500,
            },
        )
        resp2.raise_for_status()
        body2 = resp2.json()
        content = body2["choices"][0]["message"]["content"] or "Lo siento, no pude procesar tu mensaje."
        await client2.aclose()

    return content


@app.post("/chat")
async def chat(req: ChatRequest) -> ChatResponse:
    """Chat with the RAG-powered bot. Searches knowledge base + calls DeepSeek."""
    # 1. Retrieve relevant chunks
    results = await search_chunks(
        query=req.query,
        top_k=9,
    )

    # 2. Re-rank
    if len(results) > 1:
        from services.reranker import rerank
        results = await rerank(req.query, results, top_k=3)

    # 3. Build prompt
    if results:
        context = "\n\n---\n\n".join(
            f"[Fuente {i+1}]:\n{r['content']}" for i, r in enumerate(results)
        )
        system_prompt = (
            "Eres Ana, asesora de Angela's Vacations LLC, una agencia boutique con 20 a\u00f1os de experiencia. "
            "Est\u00e1s ayudando a familias interesadas en el crucero de Quincea\u00f1eras a bordo del MSC World America "
            "(20-27 marzo 2027).\n\n"
            "ESTILO DE RESPUESTA:\n"
            "- Responde en espa\u00f1ol, con calidez y entusiasmo, como si estuvieras en WhatsApp.\n"
            "- S\u00e9 natural, cercana y emp\u00e1tica. Usa emojis ocasionalmente.\n"
            "- NUNCA menciones \"fuentes\", \"contexto\", \"base de conocimiento\" ni t\u00e9rminos t\u00e9cnicos.\n"
            "- NUNCA digas \"seg\u00fan la informaci\u00f3n proporcionada\" o frases similares.\n"
            "- Responde como una asesora humana que conoce bien el producto.\n\n"
            "LO QUE SABES (datos del evento):\n"
            f"{context}\n\n"
            "REGLAS:\n"
            "- Si te preguntan algo que NO est\u00e1 en los datos de arriba, di que no tienes ese detalle "
            "pero ofrece informaci\u00f3n relacionada que S\u00cd conozcas.\n"
            "- NO inventes precios, fechas ni condiciones que no est\u00e9n arriba.\n"
            "- Si te preguntan algo ajeno al evento, responde amablemente que solo puedes ayudar con el crucero."
        )
    else:
        system_prompt = (
            "Eres Ana, asesora de Angela's Vacations LLC. "
            "Responde en espa\u00f1ol, con calidez y naturalidad.\n\n"
            "En este momento no tienes acceso a la informaci\u00f3n del evento. "
            "Dile al cliente que el sistema est\u00e1 iniciando y que por favor intente de nuevo en unos segundos. "
            "S\u00e9 amable y pide disculpas brevemente."
        )

    # 4. Call DeepSeek
    answer = await _call_deepseek_chat(system_prompt, req.query)

    # 5. Log conversation (optional)
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO conversations (id, user_id, user_name, message, response, chunks_used)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            uuid.uuid4(), req.user_id, req.user_name, req.query, answer,
            [uuid.UUID(r["chunk_id"]) for r in results],
        )

    return ChatResponse(
        query=req.query,
        answer=answer,
        chunks_used=[SearchResult(**r) for r in results],
    )


@app.post("/conversations", status_code=201)
async def log_conversation(req: ConversationRequest):
    """Log a conversation (user message + AI response + chunks used)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        cid = uuid.uuid4()
        await conn.execute(
            """
            INSERT INTO conversations (id, user_id, user_name, message, response, chunks_used)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            cid, req.user_id, req.user_name, req.message, req.response, req.chunks_used,
        )
    return {"id": str(cid), "status": "logged"}


@app.get("/health")
async def health():
    """Health check — also verifies DB connectivity."""
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute("SELECT 1")
        db_status = "connected"
    except Exception:
        db_status = "disconnected"

    return {
        "status": "ok" if db_status == "connected" else "degraded",
        "database": db_status,
        "service": "knowledge-service",
    }


# ─── Run ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
