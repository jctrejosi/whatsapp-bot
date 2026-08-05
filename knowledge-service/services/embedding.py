"""Embedding service — pluggable provider.

Seleccionado por la variable de entorno EMBEDDING_PROVIDER:

  - "openai"  → OpenAI text-embedding-3-small API (multilingüe, requiere OPENAI_API_KEY).
  - cualquier otro valor / no definido → modo "none": SIN embeddings.
    En ese modo la búsqueda devuelve todos los chunks del bot y el reranker
    de DeepSeek (multilingüe) se encarga del ranking semántico. No necesita
    descargas, ni modelos pesados, ni keys adicionales.
"""

import os

import httpx
from dotenv import load_dotenv

load_dotenv()

VECTOR_DIM = 512  # text-embedding-3-small soporta 256–1536 vía "dimensions"

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_EMBEDDING_URL = "https://api.openai.com/v1/embeddings"
OPENAI_EMBEDDING_MODEL = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")

EMBEDDING_PROVIDER = os.getenv("EMBEDDING_PROVIDER", "none").strip().lower()

_client: httpx.AsyncClient | None = None


def embedding_enabled() -> bool:
    """True cuando hay un proveedor de embeddings real configurado."""
    return EMBEDDING_PROVIDER == "openai" and bool(OPENAI_API_KEY)


def embedding_model_name() -> str:
    """Nombre del modelo de embeddings usado (para registrarlo en la DB)."""
    return f"{OPENAI_EMBEDDING_MODEL}-{VECTOR_DIM}"


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {OPENAI_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )
    return _client


async def embed_texts(texts: list[str]) -> list[list[float]] | None:
    """
    Genera embeddings para un batch de textos.

    Returns:
        Lista de vectores si hay proveedor configurado.
        None si EMBEDDING_PROVIDER está en modo "none" (los llamadores deben
        omitir el paso de embedding).
    """
    if not embedding_enabled():
        return None

    if not texts:
        return []

    client = _get_client()
    resp = await client.post(
        OPENAI_EMBEDDING_URL,
        json={
            "model": OPENAI_EMBEDDING_MODEL,
            "input": texts,
            "dimensions": VECTOR_DIM,
        },
    )
    resp.raise_for_status()
    body = resp.json()

    # OpenAI puede devolver los embeddings desordenados; ordenar por index
    data = sorted(body["data"], key=lambda d: d["index"])
    return [d["embedding"] for d in data]


async def embed_text(text: str) -> list[float] | None:
    """Genera un embedding. None si embeddings deshabilitados."""
    results = await embed_texts([text])
    return results[0] if results else None


async def close_client() -> None:
    """Cierra el HTTP client (no-op en modo none)."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
