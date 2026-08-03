"""Reranker service — uses DeepSeek V4 Pro to re-rank retrieved chunks."""

import json
import os

import httpx
from dotenv import load_dotenv

load_dotenv()

DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_CHAT_URL = "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_CHAT_MODEL = "deepseek-chat"

_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            headers={
                "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                "Content-Type": "application/json",
            },
            timeout=30.0,
        )
    return _client


async def rerank(
    query: str,
    chunks: list[dict],
    top_k: int = 3,
) -> list[dict]:
    """
    Use DeepSeek V4 Pro to re-rank retrieved chunks by relevance.

    Args:
        query: The user's question.
        chunks: List of {content, similarity, ...} from initial retrieval.
        top_k: Number of top results to return after reranking.

    Returns:
        The same chunks but with reranked order and a new 'rerank_score'.
    """
    if not chunks:
        return []

    if len(chunks) <= 1:
        return chunks

    # Build prompt: ask DeepSeek to rank chunks by relevance
    chunks_text = ""
    for i, c in enumerate(chunks):
        preview = c["content"][:300].replace("\n", " ").strip()
        chunks_text += f"[{i}] {preview}\n\n"

    prompt = f"""Evalúa cuáles de los siguientes fragmentos responden mejor a la pregunta del usuario.

Pregunta: "{query}"

Fragmentos:
{chunks_text}

Devuelve ÚNICAMENTE un array JSON con los índices de los fragmentos ordenados por relevancia (más relevante primero). Ejemplo: [2, 0, 1, 3]"""

    try:
        client = _get_client()
        resp = await client.post(
            DEEPSEEK_CHAT_URL,
            json={
                "model": DEEPSEEK_CHAT_MODEL,
                "messages": [
                    {
                        "role": "system",
                        "content": "Eres un asistente que evalúa relevancia de documentos. Responde ÚNICAMENTE con un array JSON de índices numéricos, sin texto adicional.",
                    },
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.0,
                "max_tokens": 200,
            },
        )
        resp.raise_for_status()
        body = resp.json()
        answer = body["choices"][0]["message"]["content"].strip()

        # Parse the JSON array from the response
        order = _parse_order(answer, len(chunks))

        # Reorder chunks and add rerank_score
        reranked = []
        for rank, idx in enumerate(order):
            if idx < len(chunks):
                c = dict(chunks[idx])
                c["rerank_score"] = 1.0 - (rank / max(len(order), 1))  # 1.0 = best
                c["rerank_position"] = rank + 1
                reranked.append(c)

        # Return top_k
        return reranked[:top_k]

    except Exception as exc:
        print(f"Reranker fallback — usando orden original: {exc}")
        for i, c in enumerate(chunks):
            c["rerank_score"] = None
            c["rerank_position"] = i + 1
        return chunks[:top_k]


def _parse_order(answer: str, num_chunks: int) -> list[int]:
    """Parse a JSON array of indices from the model response."""
    # Strip markdown code fences if present
    answer = answer.strip()
    for prefix in ["```json", "```"]:
        if answer.startswith(prefix):
            answer = answer[len(prefix):].strip()
    if answer.endswith("```"):
        answer = answer[:-3].strip()

    try:
        order = json.loads(answer)
        if isinstance(order, list) and all(isinstance(i, int) for i in order):
            return order
    except json.JSONDecodeError:
        pass

    # Fallback: extract numbers from the text
    import re
    nums = re.findall(r"\d+", answer)
    return [int(n) for n in nums if int(n) < num_chunks]
