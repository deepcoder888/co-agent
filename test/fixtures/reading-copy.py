"""Small PDF fixtures and XML sanitation checks for the v0.45 development tool."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from xml.etree import ElementTree as ET
from zipfile import ZipFile, ZIP_STORED

from pypdf import PdfReader, PdfWriter
from pypdf.generic import ByteStringObject, DecodedStreamObject, DictionaryObject, NameObject

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("reading_copy", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
root = Path(sys.argv[2])
root.mkdir(parents=True, exist_ok=True)

text, removed = module.clean_xml("a\x00\x01\x0b\x0c\ud800\ufffe\uffff\t\n\r中文😀<&")
assert removed == 7 and text == "a\t\n\r中文😀<&"
page = module.page_xhtml(1, "第一行<&\n第二行\n\n下一段", "zh")
ET.fromstring(page)
assert "第一行&lt;&amp;<br/>第二行" in page and page.count("<p>") == 2
assert "<p>" not in module.page_xhtml(2, " \n\t", "en")

writer = PdfWriter()
first = writer.add_blank_page(width=300, height=400)
font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"),
                         NameObject("/BaseFont"): NameObject("/Helvetica")})
first[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): font})})
content = DecodedStreamObject()
content.set_data(b"BT /F1 12 Tf 20 350 Td (First <line> & text) Tj 0 -16 Td (Second line) Tj ET")
first[NameObject("/Contents")] = writer._add_object(content)
writer.add_blank_page(width=300, height=400)
with (root / "plain.pdf").open("wb") as stream:
    writer.write(stream)
parent = writer.add_outline_item("Parent <&>", 0)
writer.add_outline_item("Child", 1, parent=parent)
bad = writer.add_outline_item("bad", 1)
bad.get_object()[NameObject("/Title")] = ByteStringObject(b"\xfe\xff\x00")
writer.add_outline_item("Promoted child", 1, parent=bad)
writer.add_outline_item("", 1)
with (root / "bookmarks.pdf").open("wb") as stream:
    writer.write(stream)

for name in ("plain", "bookmarks"):
    source = root / f"{name}.pdf"
    directory = root / name
    result = module.make_reading_copy(source, directory, "Fixture <&> 中文", "zh")
    assert result["page_count"] == 2
    assert result["skipped_bookmarks"] == (2 if name == "bookmarks" else 0)
    provenance = json.loads((directory / "reading-copy-provenance.json").read_text(encoding="utf-8"))
    assert provenance["source_sha256"] == hashlib.sha256(source.read_bytes()).hexdigest()
    reader = PdfReader(source)
    for n, record in enumerate(provenance["pages"]):
        clean, removed = module.clean_xml(reader.pages[n].extract_text() or "")
        assert record == {"original_page": n + 1, "entry": module.page_entry(n + 1),
                          "text_sha256": hashlib.sha256(clean.encode("utf-8")).hexdigest(),
                          "chars": len(clean), "removed_control_chars": removed}
    with ZipFile(directory / "reading-copy.epub") as epub:
        assert epub.namelist() == ["mimetype", "META-INF/container.xml", "book.opf", "nav.xhtml",
                                  "page-000001.xhtml", "page-000002.xhtml"]
        assert epub.getinfo("mimetype").compress_type == ZIP_STORED
        assert epub.read("mimetype") == b"application/epub+zip"
        for name in epub.namelist()[1:]:
            ET.fromstring(epub.read(name))
        opf = ET.fromstring(epub.read("book.opf"))
        ns = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
        assert opf.find("opf:metadata/dc:title", ns).text == "Fixture <&> 中文"
        assert opf.find("opf:metadata/dc:language", ns).text == "zh"
        assert opf.find("opf:metadata/dc:identifier", ns).text == provenance["source_sha256"]

print("PDF fixtures, XML sanitation, provenance, EPUB order and metadata passed")
