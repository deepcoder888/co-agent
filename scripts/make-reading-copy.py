"""Extract a PDF's text layer into a page-addressable EPUB 3. Development tool only.

Requires the locally installed pypdf; installs nothing. Neither output is replaced.
This is a text reading aid: figures, tables' visual layout and OCR are not reproduced.
"""

import argparse
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
import time
from xml.sax.saxutils import escape
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile

import pypdf
from pypdf import PdfReader


INVALID_XML = re.compile(r"[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")
OUTPUT_NAMES = ("reading-copy.epub", "reading-copy-provenance.json")


def clean_xml(text):
    """Return XML 1.0 text and the exact number of removed code points."""
    return INVALID_XML.subn("", text)


def page_entry(number):
    return f"page-{number:06d}.xhtml"


def xhtml(title, body, lang):
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" '
            f'xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="{lang}" lang="{lang}">'
            f'<head><title>{escape(title)}</title></head><body>{body}</body></html>')


def page_xhtml(number, text, lang):
    heading = f"PDF 第 {number} 页" if lang == "zh" else f"PDF Page {number}"
    # epub.mjs collapses literal whitespace but preserves <br/> as a Markdown newline.
    # Blank lines delimit paragraphs; wrapped lines stay together without a paragraph per line.
    paragraphs = re.split(r"\n[ \t]*\n+", text.replace("\r\n", "\n").replace("\r", "\n").strip())
    body = f"<h2>{heading}</h2>" + "".join(
        "<p>" + "<br/>".join(escape(line) for line in paragraph.split("\n")) + "</p>"
        for paragraph in paragraphs if paragraph.strip()
    )
    return xhtml(heading, body, lang)


def bookmark_tree(reader, outline, page_count):
    """Keep nested destinations; promote children when an unusable parent is skipped."""
    nodes, skipped = [], 0
    i = 0
    while i < len(outline):
        item = outline[i]
        i += 1
        if isinstance(item, list):
            children, count = bookmark_tree(reader, item, page_count)
            nodes.extend(children)
            skipped += count
            continue
        children = []
        if i < len(outline) and isinstance(outline[i], list):
            children, count = bookmark_tree(reader, outline[i], page_count)
            skipped += count
            i += 1
        # pypdf can stringify undecodable ByteStringObject titles. Inspect the original
        # node rather than accepting that garbled display string (four in Senvo's PDF).
        raw_title = item.node.get("/Title")
        title = clean_xml(raw_title)[0].strip() if isinstance(raw_title, str) else ""
        page = reader.get_destination_page_number(item)
        if not title or "\ufffd" in title or page is None or not 0 <= page < page_count:
            skipped += 1
            nodes.extend(children)
        else:
            nodes.append({"title": title, "page": page + 1, "children": children})
    return nodes, skipped


def nav_list(nodes):
    return "<ol>" + "".join(
        f'<li><a href="{page_entry(node["page"])}">{escape(node["title"])}</a>'
        + (nav_list(node["children"]) if node["children"] else "") + "</li>"
        for node in nodes
    ) + "</ol>"


def count_nodes(nodes):
    return sum(1 + count_nodes(node["children"]) for node in nodes)


def check_absent(paths):
    # lexists also refuses dangling links; neither an existing directory nor a link is overwritten.
    for target in paths:
        if os.path.lexists(target):
            raise FileExistsError(f"Refusing to overwrite existing output: {target}")


def make_reading_copy(pdf, out_dir, title, lang):
    started = time.perf_counter()
    targets = [out_dir / name for name in OUTPUT_NAMES]
    check_absent(targets)  # Before reading the PDF, creating the directory or writing anything.
    title, _ = clean_xml(title)
    if not title.strip():
        raise ValueError("Title must contain XML-compatible text")
    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    with pdf.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
        source.seek(0)
        reader = PdfReader(source)
        page_count = len(reader.pages)
        if not page_count:
            raise ValueError("PDF has no pages")
        outline = reader.outline
        nodes, skipped = bookmark_tree(reader, outline, page_count)
        if not outline:
            nodes = [{"title": f"第 {n} 页" if lang == "zh" else f"Page {n}", "page": n, "children": []}
                     for n in range(1, page_count + 1)]
        provenance = {
            "source_pdf": str(pdf.resolve()), "source_sha256": digest, "page_count": page_count,
            "generated_at": generated_at, "pypdf_version": pypdf.__version__, "method": "pypdf-extraction",
            "toc_items": count_nodes(nodes), "skipped_bookmarks": skipped, "pages": [],
        }
        manifest = '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' + "".join(
            f'<item id="p{n}" href="{page_entry(n)}" media-type="application/xhtml+xml"/>' for n in range(1, page_count + 1))
        spine = "".join(f'<itemref idref="p{n}"/>' for n in range(1, page_count + 1))
        opf = ('<?xml version="1.0" encoding="UTF-8"?>'
               '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="source">'
               '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
               f'<dc:title>{escape(title)}</dc:title><dc:language>{lang}</dc:language>'
               f'<dc:identifier id="source">{digest}</dc:identifier>'
               f'<meta property="dcterms:modified">{generated_at}</meta></metadata>'
               f'<manifest>{manifest}</manifest><spine>{spine}</spine></package>')
        output = BytesIO()
        with ZipFile(output, "w", compression=ZIP_DEFLATED) as epub:
            epub.writestr("mimetype", "application/epub+zip", compress_type=ZIP_STORED)
            epub.writestr("META-INF/container.xml", '<?xml version="1.0" encoding="UTF-8"?>'
                          '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                          '<rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/>'
                          '</rootfiles></container>')
            epub.writestr("book.opf", opf)
            epub.writestr("nav.xhtml", xhtml(title, '<nav epub:type="toc">' + nav_list(nodes) + '</nav>', lang))
            for number, page in enumerate(reader.pages, 1):
                text, removed = clean_xml(page.extract_text() or "")
                entry = page_entry(number)
                epub.writestr(entry, page_xhtml(number, text, lang))
                provenance["pages"].append({
                    "original_page": number, "entry": entry,
                    "text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                    "chars": len(text), "removed_control_chars": removed,
                })
    provenance["removed_control_chars"] = sum(p["removed_control_chars"] for p in provenance["pages"])
    # Finish extraction in memory before reserving both outputs with exclusive creation.
    # A failure creating/writing either file removes only files created by this invocation.
    check_absent(targets)
    out_dir.mkdir(parents=True, exist_ok=True)
    streams, created = [], []
    try:
        for target in targets:
            streams.append(target.open("xb"))
            created.append(target)
        streams[0].write(output.getvalue())
        streams[1].write((json.dumps(provenance, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        for stream in streams:
            stream.close()
    except BaseException:
        for stream in streams:
            stream.close()
        for target in created:
            target.unlink()
        raise
    return {"page_count": page_count, "toc_items": provenance["toc_items"], "skipped_bookmarks": skipped,
            "removed_control_chars": provenance["removed_control_chars"],
            "epub_bytes": targets[0].stat().st_size, "provenance_bytes": targets[1].stat().st_size,
            "elapsed_seconds": round(time.perf_counter() - started, 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--title", required=True)
    parser.add_argument("--lang", required=True, choices=("en", "zh"))
    args = parser.parse_args()
    try:
        result = make_reading_copy(args.pdf, args.out_dir, args.title, args.lang)
    except Exception as error:
        print(f"Reading copy failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
