---
name: document-processing
description: >
  Use when the user attaches or asks about PDF, Word/PowerPoint/Excel, archives
  or unknown binaries, or needs more pages, OCR, table extraction, or page
  images beyond what is attached
---

# Document processing

Self-serve upgrade path for office files, PDFs, archives, and unknown binaries
inside the cloud sandbox. Prefer already-attached page images and the
`viewDocumentPages` tool when they are present. Never loop on re-reading empty
extracted text — empty text means a scanned or image-only page; render or ask
for the page image instead.

This sandbox does **not** ship LibreOffice. Whole-page layout rendering is the
document-render sidecar's job. Use Python libraries here for text, tables, and
targeted page images.

## Locate the file

Attachments of the current turn are synced to:

`/mnt/data/uploads/<name>-<fileId>`

Example: `report.pdf` + `file-abc` → `/mnt/data/uploads/report-file-abc.pdf`.
The path is also on the `<file>` tag as `sandboxPath`. Identify the type with
the `file` command before picking a recipe:

```bash
file /mnt/data/uploads/<name>-<fileId>
```

## Install tools

Install inside the sandbox (safe to re-run; already-present packages are reused):

```bash
pip install python-pptx python-docx openpyxl pypdf pdfplumber pymupdf
```

## Recipes

**Text per page / slide**

- PDF: `pypdf` or `pdfplumber` — iterate pages, emit `## Page N` then the text.
- PPTX: `python-pptx` — for each slide, title, body shapes, then notes.
- DOCX: `python-docx` — paragraphs and tables in document order.
- XLSX: `openpyxl` — one section per sheet.

**Embedded images**

List media from OOXML (`ppt/media`, `word/media`, `xl/media`) or PDF XObjects.
Do not dump every image unless the user asked; summarize counts and names first.

**Render a page to PNG**

When attached images / `viewDocumentPages` are missing and you need to *see* a
page (scanned PDF, layout-heavy slide):

```python
import fitz  # pymupdf

doc = fitz.open(path)
page = doc[n]  # 0-based
pix = page.get_pixmap(dpi=110)
pix.save("/mnt/data/page.png")
```

Return the PNG via `exportFile`, or as an inline image if the runtime accepts
one. Cap work to the pages the user asked about.

**Tables → markdown**

`pdfplumber` for PDF tables; `python-docx` / `openpyxl` for Word/Excel. Emit
GitHub-flavored markdown tables. If a table is mostly figures, render the page
instead of guessing cell text.

## Do not

- Re-parse a file whose text layer is empty hoping it will appear.
- Convert the whole deck with LibreOffice (not in this image; sidecar owns that).
- Download the original over HTTP when `sandboxPath` is set.
