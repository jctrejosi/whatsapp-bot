"""Multi-format text extraction service.

Supports: PDF, DOCX, PPTX, XLSX, XLS, ODT, ODS, ODP, RTF,
          CSV, TXT, MD, HTML, JSON, XML, YAML, and code files (.py, .js, .ts, .java, .cpp, etc.)
"""

import csv
import io
import os
import re
import zipfile
import xml.etree.ElementTree as ET
from typing import NamedTuple


class ExtractionResult(NamedTuple):
    """Result of extracting text from a file."""
    pages: list[dict]          # [{page, text, char_count}, ...]
    full_text: str
    total_pages: int
    total_chars: int
    metadata: dict | None


# ─── File type helpers ───────────────────────────────────────────────────────────

# Extensions that are plain-text and can be read directly
PLAIN_TEXT_EXTENSIONS = {
    '.txt', '.md', '.rst', '.log',
    '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.cpp', '.c', '.h', '.hpp',
    '.rb', '.go', '.rs', '.swift', '.kt', '.scala', '.php', '.lua', '.r',
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
    '.html', '.htm', '.css', '.scss', '.less',
    '.svg', '.xml', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
    '.url', '.tex', '.sql', '.graphql',
}

# Structured plain-text that should be read field-by-field
STRUCTURED_TEXT_EXTENSIONS = {'.csv', '.tsv'}

# Modern Office formats (ZIP + XML)
DOCX_EXTENSIONS = {'.docx'}
PPTX_EXTENSIONS = {'.pptx'}
XLSX_EXTENSIONS = {'.xlsx'}
ODF_EXTENSIONS = {'.odt', '.ods', '.odp'}  # OpenDocument (LibreOffice)

# Legacy binary Office formats — try plain text (rarely works, but won't crash)
LEGACY_BINARY_EXTENSIONS = {'.doc', '.ppt', '.xls'}

# RTF
RTF_EXTENSIONS = {'.rtf'}


def extract_file_bytes(data: bytes, filename: str) -> ExtractionResult:
    """Extract text from uploaded file bytes, auto-detecting the format."""
    ext = os.path.splitext(filename)[1].lower()

    if ext == '.pdf':
        return _extract_pdf_bytes(data)

    if ext in DOCX_EXTENSIONS:
        return _extract_docx(data)

    if ext in PPTX_EXTENSIONS:
        return _extract_pptx(data)

    if ext in XLSX_EXTENSIONS:
        return _extract_xlsx(data)

    if ext == '.xls':
        return _extract_xls(data)

    if ext in ODF_EXTENSIONS:
        return _extract_odf(data)

    if ext in RTF_EXTENSIONS:
        return _extract_rtf(data)

    if ext in STRUCTURED_TEXT_EXTENSIONS:
        return _extract_csv_text(data, filename)

    if ext in LEGACY_BINARY_EXTENSIONS:
        return _extract_plain_text(data, filename, note='formato binario legado — texto crudo')

    # All other text-based formats (code, data, web, etc.)
    return _extract_plain_text(data, filename)


# ─── PDF (PyPDF2) ──────────────────────────────────────────────────────────────

def _extract_pdf_bytes(data: bytes) -> ExtractionResult:
    from PyPDF2 import PdfReader
    reader = PdfReader(io.BytesIO(data))
    pages_out = []
    parts = []

    for i, page in enumerate(reader.pages):
        text = (page.extract_text() or '').strip()
        if text:
            pages_out.append({'page': i + 1, 'text': text, 'char_count': len(text)})
            parts.append(text)

    meta = reader.metadata
    metadata = {
        'title': getattr(meta, 'title', None),
        'author': getattr(meta, 'author', None),
        'creator': getattr(meta, 'creator', None),
        'producer': getattr(meta, 'producer', None),
    } if meta else None

    full_text = '\n\n'.join(parts)
    return ExtractionResult(
        pages=pages_out,
        full_text=full_text,
        total_pages=len(reader.pages),
        total_chars=len(full_text),
        metadata=metadata,
    )


# ─── DOCX (python-docx) ────────────────────────────────────────────────────────

def _extract_docx(data: bytes) -> ExtractionResult:
    from docx import Document
    doc = Document(io.BytesIO(data))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    full_text = '\n\n'.join(paragraphs)
    return ExtractionResult(
        pages=[{'page': 1, 'text': full_text, 'char_count': len(full_text)}],
        full_text=full_text,
        total_pages=1,
        total_chars=len(full_text),
        metadata=None,
    )


# ─── PPTX (python-pptx) ────────────────────────────────────────────────────────

def _extract_pptx(data: bytes) -> ExtractionResult:
    from pptx import Presentation
    prs = Presentation(io.BytesIO(data))
    slides = []
    for i, slide in enumerate(prs.slides):
        texts = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                for paragraph in shape.text_frame.paragraphs:
                    t = paragraph.text.strip()
                    if t:
                        texts.append(t)
        txt = '\n'.join(texts)
        if txt.strip():
            slides.append({'page': i + 1, 'text': txt, 'char_count': len(txt)})
    full_text = '\n\n---\n\n'.join(s.get('text', '') for s in slides)
    return ExtractionResult(
        pages=slides,
        full_text=full_text,
        total_pages=len(slides),
        total_chars=len(full_text),
        metadata=None,
    )


# ─── XLSX (openpyxl) ───────────────────────────────────────────────────────────

def _extract_xlsx(data: bytes) -> ExtractionResult:
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    sheets = []
    for sheet_name in wb.sheetnames:
        ws = wb[sheet_name]
        rows_text = []
        for row in ws.iter_rows(values_only=True):
            row_text = ' | '.join(str(c) if c is not None else '' for c in row).strip(' |')
            if row_text:
                rows_text.append(row_text)
        if rows_text:
            sheets.append(f'--- Hoja: {sheet_name} ---\n' + '\n'.join(rows_text))
    full_text = '\n\n'.join(sheets)
    return ExtractionResult(
        pages=[{'page': 1, 'text': full_text, 'char_count': len(full_text)}],
        full_text=full_text,
        total_pages=1,
        total_chars=len(full_text),
        metadata=None,
    )


# ─── XLS (xlrd) — legacy binary ────────────────────────────────────────────────

def _extract_xls(data: bytes) -> ExtractionResult:
    try:
        import xlrd
        wb = xlrd.open_workbook(file_contents=data)
        sheets = []
        for sheet in wb.sheets():
            rows_text = []
            for row_idx in range(sheet.nrows):
                row_text = ' | '.join(
                    str(sheet.cell_value(row_idx, col_idx)) for col_idx in range(sheet.ncols)
                ).strip(' |')
                if row_text:
                    rows_text.append(row_text)
            if rows_text:
                sheets.append(f'--- Hoja: {sheet.name} ---\n' + '\n'.join(rows_text))
        full_text = '\n\n'.join(sheets) or _extract_plain_text(data, '.xls', 'sin contenido estructurado').full_text
    except Exception:
        return _extract_plain_text(data, '.xls', 'no se pudo parsear como XLS binario')
    return ExtractionResult(
        pages=[{'page': 1, 'text': full_text, 'char_count': len(full_text)}],
        full_text=full_text,
        total_pages=1,
        total_chars=len(full_text),
        metadata=None,
    )


# ─── ODF (LibreOffice: ODT, ODS, ODP) — ZIP + XML ──────────────────────────────

def _extract_odf(data: bytes) -> ExtractionResult:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            if 'content.xml' not in zf.namelist():
                return _extract_plain_text(data, '.odf', 'no es un ODF válido')
            content = zf.read('content.xml').decode('utf-8', errors='replace')
            # Strip XML tags to get plain text
            text = re.sub(r'<[^>]+>', ' ', content)
            text = re.sub(r'\s+', ' ', text).strip()
    except Exception:
        return _extract_plain_text(data, '.odf', 'no se pudo extraer de ODF')
    return ExtractionResult(
        pages=[{'page': 1, 'text': text, 'char_count': len(text)}],
        full_text=text,
        total_pages=1,
        total_chars=len(text),
        metadata=None,
    )


# ─── RTF ───────────────────────────────────────────────────────────────────────

def _extract_rtf(data: bytes) -> ExtractionResult:
    # Simple RTF tag stripper — removes RTF control words and groups
    text = data.decode('utf-8', errors='replace')
    # Remove group braces and control words
    text = re.sub(r'\\[a-z]+\d*\s?', ' ', text, flags=re.IGNORECASE)
    text = re.sub(r'[\\{}]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if not text:
        return _extract_plain_text(data, '.rtf', 'RTF vacío o muy complejo')
    return ExtractionResult(
        pages=[{'page': 1, 'text': text, 'char_count': len(text)}],
        full_text=text,
        total_pages=1,
        total_chars=len(text),
        metadata=None,
    )


# ─── CSV / TSV ─────────────────────────────────────────────────────────────────

def _extract_csv_text(data: bytes, filename: str) -> ExtractionResult:
    ext = os.path.splitext(filename)[1].lower()
    delimiter = '\t' if ext == '.tsv' else ','
    text = data.decode('utf-8', errors='replace')
    rows = []
    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    for row in reader:
        rows.append(' | '.join(row).strip())
    full_text = '\n'.join(rows) if rows else text
    return ExtractionResult(
        pages=[{'page': 1, 'text': full_text, 'char_count': len(full_text)}],
        full_text=full_text,
        total_pages=1,
        total_chars=len(full_text),
        metadata=None,
    )


# ─── Plain text (code, markdown, HTML, JSON, YAML, etc.) ────────────────────────

def _extract_plain_text(data: bytes, filename: str = '', note: str = '') -> ExtractionResult:
    try:
        text = data.decode('utf-8', errors='replace')
    except Exception:
        text = data.decode('latin-1', errors='replace')
    text = text.strip()
    ext = os.path.splitext(filename)[1].lower()

    # HTML: strip tags to get readable content
    if ext in ('.html', '.htm'):
        text = _strip_html(text)

    if note:
        text = f'[{note}]\n\n{text}'

    return ExtractionResult(
        pages=[{'page': 1, 'text': text, 'char_count': len(text)}],
        full_text=text,
        total_pages=1,
        total_chars=len(text),
        metadata=None,
    )


def _strip_html(html_text: str) -> str:
    """Remove HTML tags and return plain text."""
    # Remove scripts and styles
    html_text = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', html_text, flags=re.DOTALL | re.IGNORECASE)
    html_text = re.sub(r'<[^>]+>', ' ', html_text)
    html_text = re.sub(r'&[a-z]+;', ' ', html_text)  # entities
    html_text = re.sub(r'\s+', ' ', html_text).strip()
    return html_text


# ─── Backward-compat aliases ───────────────────────────────────────────────────

def extract_pdf(file_path: str) -> ExtractionResult:
    """Extract text from a PDF file on disk (legacy alias)."""
    with open(file_path, 'rb') as f:
        return _extract_pdf_bytes(f.read())


def extract_pdf_bytes(data: bytes) -> ExtractionResult:
    """Extract text from PDF bytes (legacy alias)."""
    return _extract_pdf_bytes(data)
