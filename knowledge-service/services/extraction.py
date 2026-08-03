"""PDF text extraction service."""

from io import BytesIO
from typing import NamedTuple

from PyPDF2 import PdfReader


class ExtractionResult(NamedTuple):
    pages: list[dict]          # [{page, text, char_count}, ...]
    full_text: str
    total_pages: int
    total_chars: int
    metadata: dict | None


def extract_pdf(file_path: str) -> ExtractionResult:
    """Extract text from a PDF file on disk."""
    reader = PdfReader(file_path)
    return _extract(reader)


def extract_pdf_bytes(data: bytes) -> ExtractionResult:
    """Extract text from PDF bytes (for uploaded files)."""
    reader = PdfReader(BytesIO(data))
    return _extract(reader)


def _extract(reader: PdfReader) -> ExtractionResult:
    pages = []
    full_text_parts = []

    for i, page in enumerate(reader.pages):
        text = page.extract_text()
        if text:
            text = text.strip()
            pages.append({"page": i + 1, "text": text, "char_count": len(text)})
            full_text_parts.append(text)

    meta = reader.metadata
    metadata = {
        "title": getattr(meta, "title", None),
        "author": getattr(meta, "author", None),
        "creator": getattr(meta, "creator", None),
        "producer": getattr(meta, "producer", None),
    } if meta else None

    return ExtractionResult(
        pages=pages,
        full_text="\n\n".join(full_text_parts),
        total_pages=len(reader.pages),
        total_chars=sum(p["char_count"] for p in pages),
        metadata=metadata,
    )
