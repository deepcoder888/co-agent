# Source Adapter Contract

## Dispatch order

1. Acquire only authorized local bytes or a lawful public response.
2. Determine container type from magic bytes, MIME type, and extension.
3. Select the container adapter.

Retrieval location never overrides container type. A PDF or EPUB obtained from
a public URL uses the PDF or EPUB adapter. `web-text-extractor` handles HTML
and plain-text responses only.

## Adapter matrix

| Source | Reader and completeness gate | Failure status |
|---|---|---|
| Text PDF | Load `pdf:pdf`; enumerate the PDF page inventory and reconcile extracted text with every declared page. | `PARTIAL` for named page failures; `BLOCKED` when the container or page inventory cannot be read. |
| Scanned PDF | Load `pdf:pdf` and render every page. Use `tesseract` only when the executable resolves, the book language pack exists, and a one-page probe passes. OCR every page. | Mark failed scanned pages `UNREADABLE`; use `BLOCKED` when no substantive page can be read, otherwise `PARTIAL`. Do not install OCR implicitly. |
| DOCX | Load `documents:documents` and its read/review task. Enumerate OOXML body content, headings, tables, footnotes, endnotes, section breaks, and rendered pages. Inspect every page and substantive part; the complete-book contract overrides spot-check guidance. | `PARTIAL` for named missing parts; `BLOCKED` when the package inventory cannot open. |
| EPUB | Inspect `META-INF/container.xml`, the OPF manifest and spine, and nav/NCX. Process every linear spine item and reconcile it with navigation. | `PARTIAL` for named unreadable items; `BLOCKED` for DRM/encryption, missing rootfile/OPF, or unreadable spine inventory. |
| TXT or Markdown | Read in byte-bounded chunks. Record byte size and line count; confirm both first and final chunks. | `PARTIAL` for truncation; `BLOCKED` when decoding cannot be established. |
| HTML | Load `$web-text-extractor`; compare extracted headings and chapter links with the source DOM. Require a complete index for multi-file or multi-page books. | `PARTIAL` for named missing pages; `BLOCKED` when no book structure can be enumerated. |
| Unsupported or encrypted container | Record the missing reader or access barrier. | `BLOCKED`. |
