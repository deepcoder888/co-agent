"""A-book v2: bounded EPUB views and recoverable, scoped checkpoints. Stdlib only."""
from __future__ import annotations

import argparse
import contextlib
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import sys
import unicodedata
from urllib.parse import unquote, urlsplit
import uuid
import xml.etree.ElementTree as ET
import zipfile

VERSION = "abook-epub-nfc-codepoints-v2.0"
PACKAGE_FILES = {"source-manifest.json", "coverage-ledger.json", "chapter-map.md",
                 "concept-map.md", "first-principles.md", "retrieval-bank.md",
                 "action-map.md", "README.md"}
COMPONENTS = {"structure": 15, "chapters": 20, "concepts": 20,
              "mechanisms": 20, "boundaries": 15, "actions": 10}
CAPTURE = {"CAPTURE_RECONSTRUCTION", "CAPTURE_ANSWERS"}
MAX_CHARS, MAX_BYTES = 6000, 24000


class Rejected(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    return digest(Path(path).read_bytes()) if Path(path).is_file() else None


def canonical(value):
    return Path(value).expanduser().resolve()


def within(path, root):
    return path == root or root in path.parents


def atomic(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("xb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


@contextlib.contextmanager
def locked(work):
    work.mkdir(parents=True, exist_ok=True)
    with (work / "runtime.lock").open("a+b") as stream:
        stream.seek(0, 2)
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise Rejected("another runtime command owns this run") from exc
        try:
            yield
        finally:
            stream.seek(0)
            if os.name == "nt":
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream, fcntl.LOCK_UN)


class TextParser(HTMLParser):
    BLOCKS = {"p", "div", "section", "article", "li", "br", "h1", "h2", "h3", "h4", "tr", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        tag = tag.split(":")[-1]
        if tag in {"head", "script", "style"}:
            self.hidden += 1
        if not self.hidden and tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        tag = tag.split(":")[-1]
        if tag in {"head", "script", "style"}:
            self.hidden = max(0, self.hidden - 1)
        if not self.hidden and tag in self.BLOCKS:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)

    def text(self):
        import re
        value = unicodedata.normalize("NFC", "".join(self.parts).replace("\r\n", "\n").replace("\r", "\n"))
        value = re.sub(r"[^\S\n]+", " ", value)
        return re.sub(r"\n[ \n]*", "\n", value).strip()


class Epub:
    def __init__(self, source):
        self.source = canonical(source)
        require(self.source.suffix.lower() == ".epub", "EPUB helper requires .epub; use the named format adapter")
        self.raw = self.source.read_bytes()
        self.sha256 = digest(self.raw)
        import io
        self.zip = zipfile.ZipFile(io.BytesIO(self.raw))
        self.names = self.zip.namelist()
        require(len(self.names) == len(set(self.names)), "duplicate ZIP entry")
        require("META-INF/encryption.xml" not in self.names, "encrypted EPUB requires source review")
        self.cache = {}
        container = ET.fromstring(self.get("META-INF/container.xml"))
        roots = [e.attrib.get("full-path") for e in container.iter() if e.tag.split("}")[-1] == "rootfile"]
        require(len(roots) == 1 and roots[0], "ambiguous OPF rootfile")
        self.opf = roots[0]
        opf = ET.fromstring(self.get(self.opf))
        self.items, self.linear, self.nav = {}, [], []
        self.title = ""
        for e in opf.iter():
            tag = e.tag.split("}")[-1]
            if tag == "title" and not self.title:
                self.title = e.text or ""
            if tag == "item":
                entry = self.href(self.opf, e.attrib["href"])
                self.items[e.attrib["id"]] = entry
                if "nav" in e.attrib.get("properties", "").split() or e.attrib.get("media-type") == "application/x-dtbncx+xml":
                    self.nav.append(entry)
        for e in opf.iter():
            if e.tag.split("}")[-1] == "itemref" and e.attrib.get("linear", "yes") != "no":
                require(e.attrib["idref"] in self.items, "spine id missing from manifest")
                self.linear.append(self.items[e.attrib["idref"]])
        require(self.linear and len(self.linear) == len(set(self.linear)), "empty or duplicate linear spine")
        self.navigation_targets = []
        for nav in self.nav:
            doc = ET.fromstring(self.get(nav))
            for e in doc.iter():
                link = e.attrib.get("href") or e.attrib.get("src")
                if link and not urlsplit(link).scheme:
                    target = self.href(nav, link)
                    if target and target not in self.navigation_targets:
                        self.navigation_targets.append(target)

    @staticmethod
    def href(parent, value):
        parsed = urlsplit(value)
        require(not parsed.scheme and not parsed.netloc, "external source entry")
        path = posixpath.normpath(posixpath.join(posixpath.dirname(parent), unquote(parsed.path)))
        require(not path.startswith("../") and not path.startswith("/") and "\\" not in path, "unsafe ZIP entry")
        return path

    def get(self, entry):
        require(isinstance(entry, str) and entry in self.names and not PurePosixPath(entry).is_absolute()
                and ".." not in PurePosixPath(entry).parts and "\\" not in entry, "invalid source entry")
        info = self.zip.getinfo(entry)
        require(info.file_size <= 64 * 1024 * 1024, "entry exceeds 64 MiB extraction limit")
        require(not info.flag_bits & 1, "encrypted ZIP entry")
        return self.zip.read(entry)

    def text(self, entry):
        if entry not in self.cache:
            raw = self.get(entry)
            parser = TextParser()
            parser.feed(raw.decode("utf-8-sig", errors="strict"))
            parser.close()
            self.cache[entry] = parser.text()
        return self.cache[entry]

    def section(self, entries):
        require(entries and len(entries) == len(set(entries)), "empty or repeated section entries")
        pieces, mapping, offset = [], [], 0
        for i, entry in enumerate(entries):
            if i:
                pieces.append("\n")
                offset += 1
            text = self.text(entry)
            mapping.append({"entry": entry, "start": offset, "end": offset + len(text), "sha256": digest(text.encode("utf-8"))})
            pieces.append(text)
            offset += len(text)
        return "".join(pieces), mapping



class Document:
    """Text-bearing non-EPUB adapters; page/OCR completeness still needs source review."""
    def __init__(self, source):
        self.source = canonical(source)
        self.raw = self.source.read_bytes()
        self.sha256 = digest(self.raw)
        self.title = self.source.stem
        self.navigation_targets = []
        self.parts = {}
        suffix = self.source.suffix.lower()
        if suffix in {".txt", ".md", ".html", ".htm"}:
            value = self.raw.decode("utf-8-sig", errors="strict")
            if suffix in {".html", ".htm"}:
                parser = TextParser(); parser.feed(value); parser.close(); value = parser.text()
            self.parts["document"] = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))
        elif suffix == ".docx":
            import io
            archive = zipfile.ZipFile(io.BytesIO(self.raw))
            for name in ("word/document.xml", "word/footnotes.xml", "word/endnotes.xml"):
                if name in archive.namelist():
                    root = ET.fromstring(archive.read(name))
                    paragraphs = []
                    for node in root.iter():
                        if node.tag.split("}")[-1] == "p":
                            paragraphs.append("".join(x.text or "" for x in node.iter() if x.tag.split("}")[-1] == "t"))
                    self.parts[name] = unicodedata.normalize("NFC", "\n".join(paragraphs))
            require("word/document.xml" in self.parts, "DOCX main document missing")
        elif suffix == ".pdf":
            try:
                import pypdf
            except ImportError as exc:
                raise Rejected("text PDF requires pypdf in the selected Python; inspect the PDF skill runtime") from exc
            import io
            reader = pypdf.PdfReader(io.BytesIO(self.raw))
            require(not reader.is_encrypted, "encrypted PDF")
            for i, page in enumerate(reader.pages, 1):
                value = page.extract_text() or ""
                require(value.strip(), "PDF page lacks text; complete the named OCR adapter before claiming coverage: page " + str(i))
                self.parts[f"page:{i}"] = unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))
        else:
            raise Rejected("unsupported source format")
        self.linear = list(self.parts)

    def text(self, entry):
        require(entry in self.parts, "unknown document/page entry")
        return self.parts[entry]

    section = Epub.section


def open_source(source):
    return Epub(source) if canonical(source).suffix.lower() == ".epub" else Document(source)


def envelope(book, entries, start, end):
    text, mapping = book.section(entries)
    require(isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(text), "invalid normalized section range")
    require(end - start <= MAX_CHARS, "lookup exceeds 6000 code points")
    spans = [{"entry": x["entry"], "start": max(start, x["start"]) - x["start"],
              "end": min(end, x["end"]) - x["start"]} for x in mapping if max(start, x["start"]) < min(end, x["end"])]
    locator = {"entries": entries, "start": start, "end": end, "extractor": VERSION, "source_sha256": book.sha256}
    body = text[start:end]
    value = {"locator": locator, "entry_spans": spans, "text": body, "text_sha256": digest(body.encode("utf-8")), "total_chars": len(text)}
    value["receipt"] = digest(encoded({k: v for k, v in value.items() if k != "receipt"}))
    return value


def bounded_unit(book, entries, offset, max_chars=MAX_CHARS):
    text, _ = book.section(entries)
    require(isinstance(max_chars, int) and 1 <= max_chars <= MAX_CHARS, "max_chars out of range")
    size = min(max_chars, len(text) - offset)
    require(size > 0, "section already read or empty")
    while size:
        value = envelope(book, entries, offset, offset + size)
        if len(encoded(value)) <= MAX_BYTES:
            return value
        size //= 2
    raise Rejected("metadata exceeds output budget")


def identity_check(state, work):
    require(state.get("schema_version") == 2, "unsupported state schema; explicit legacy import required")
    require(state["identity"]["work_dir"] == str(work), "work identity mismatch")
    require(state["identity"]["extractor"] == VERSION, "extractor version mismatch")
    require(state["identity"]["runtime_sha256"] == file_hash(__file__), "runtime changed; reviewed migration required")
    for key in ("source", "package_dir", "agent_path", "work_dir"):
        require(str(canonical(state["identity"][key])) == state["identity"][key], "canonical path identity changed")
    require(file_hash(state["identity"]["source"]) == state["identity"]["source_sha256"], "source changed")
    if state.get("questions"):
        require(digest(encoded(state["questions"])) == state["question_hash"], "frozen question specification changed")
    mastery = state.get("mastery", {})
    if mastery.get("capture_sha256"):
        require(digest(encoded({"reconstruction": mastery["reconstruction"], "answers": mastery["answers"]})) == mastery["capture_sha256"], "frozen capture changed")
    require(len(state["reading_order"]) == len(set(state["reading_order"])) and set(state["reading_order"]) == set(state["reading"]), "reading order corrupt")
    for section in state["reading"].values():
        offset = 0
        for checkpoint in section["checkpoints"]:
            loc = checkpoint["locator"]
            require(loc["start"] == offset and offset < loc["end"] <= section["length"], "reading checkpoint gap/overlap")
            require(loc["entries"] == section["entries"] and loc["source_sha256"] == state["identity"]["source_sha256"] and loc["extractor"] == VERSION, "checkpoint locator identity mismatch")
            offset = loc["end"]
        require(offset == section["offset"], "reading offset differs from committed coverage")
        if section["status"] == "READ":
            require(offset == section["length"], "incomplete section marked READ")


def allowed_target(state, target):
    path = canonical(target)
    ident = state["identity"]
    package = canonical(ident["package_dir"])
    require((path.parent == package and path.name in PACKAGE_FILES) or path == canonical(ident["agent_path"]), "target outside exact output scope")
    if state.get("sealed"):
        require(path == canonical(ident["agent_path"]), "sealed package is immutable")
    return path


def crash(request, state, point):
    if request.get("fault") == point:
        require(state.get("test_fixture") is True, "fault injection allowed only in test fixtures")
        os._exit(86)


def replay(work, state, request):
    journal_path = work / "journal.json"
    if not journal_path.exists():
        return state
    journal = json.loads(journal_path.read_text("utf-8"))
    require(journal["run_id"] == state["run_id"] and journal["identity"] == state["identity"], "journal identity mismatch")
    require(digest(encoded(journal["state"])) == journal["state_after"], "journal state candidate corrupt")
    current = file_hash(work / "state.json")
    require(current in (journal["state_before"], journal["state_after"]), "state modified outside transaction")
    for item in journal["files"]:
        path = allowed_target(state, item["target"])
        data = item["content"].encode("utf-8")
        require(digest(data) == item["after"], "journal file candidate corrupt")
        require(file_hash(path) in (item["before"], item["after"]), "output modified outside transaction")
    # All targets are preflighted before the first replacement.
    for i, item in enumerate(journal["files"]):
        path = canonical(item["target"])
        if file_hash(path) != item["after"]:
            atomic(path, item["content"].encode("utf-8"))
        crash(request, state, f"after_file_{i}")
    if file_hash(work / "state.json") != journal["state_after"]:
        atomic(work / "state.json", encoded(journal["state"]))
    crash(request, state, "after_state")
    journal_path.unlink()
    return journal["state"]


def transaction(work, old, new, request, files=()):
    require(request.get("expected_revision") == old["revision"], "stale or missing expected_revision")
    new["revision"] = old["revision"] + 1
    candidates = []
    seen = set()
    for item in files:
        path = allowed_target(old, item["target"])
        require(str(path) not in seen, "duplicate transaction target")
        seen.add(str(path))
        require(file_hash(path) == item.get("before_sha256"), "before hash mismatch")
        require(("content" in item) != ("append" in item), "provide content or append, exactly one")
        if "append" in item:
            require(isinstance(item["append"], str) and 0 < len(item["append"]) <= MAX_CHARS, "append block must be 1-6000 characters")
            content = (path.read_text("utf-8") if path.exists() else "") + item["append"]
        else:
            content = item["content"]
            require(isinstance(content, str), "file content must be text")
        candidates.append({"target": str(path), "before": item.get("before_sha256"), "after": digest(content.encode("utf-8")), "content": content})
    journal = {"run_id": old["run_id"], "identity": old["identity"], "state_before": digest(encoded(old)), "state_after": digest(encoded(new)), "state": new, "files": candidates}
    atomic(work / "journal.json", encoded(journal))
    crash(request, old, "after_journal")
    return replay(work, old, request)


def summary(state):
    return {"run_id": state["run_id"], "identity": state["identity"], "revision": state["revision"], "stage": state["stage"],
            "read_count": sum(v["status"] == "READ" for v in state["reading"].values()),
            "substantive_total": sum(v["substantive"] for v in state["reading"].values()),
            "reading": {k: {"offset": v["offset"], "length": v["length"], "status": v["status"]} for k, v in [(k, state["reading"][k]) for k in state["reading_order"] if state["reading"][k]["substantive"] and state["reading"][k]["status"] != "READ"][:4]},
            "committed_units": len(state["units"]), "mastery": {k: state.get("mastery", {}).get(k) for k in ("attempt", "phase", "score", "correct")}}


def copy_state(state):
    return json.loads(encoded(state))


def same_unit(state, unit_id, payload):
    old = state["units"].get(unit_id)
    if old:
        require(old["sha256"] == digest(encoded(payload)), "changed replay of immutable unit")
        return True
    return False


def save_unit(state, unit_id, payload):
    require(isinstance(unit_id, str) and 1 <= len(unit_id) <= 200, "invalid unit ID")
    state["units"][unit_id] = {"sha256": digest(encoded(payload)), "payload": payload}


def init(request, work):
    require(not (work / "state.json").exists() and not (work / "journal.json").exists(), "existing run")
    package, agent, source = (canonical(request[k]) for k in ("package_dir", "agent_path", "source"))
    require(not package.exists() and not agent.exists(), "new output targets must be absent")
    require(agent.suffix == ".toml" and not within(package, work) and not within(work, package)
            and not within(agent, package) and not within(agent, work)
            and not within(source, package) and not within(source, work), "overlapping source/output/work paths")
    book = open_source(source)
    sections = request["sections"]
    flat = [e for s in sections for e in s["entries"]]
    require([e for e in flat if e in book.linear] == book.linear, "linear spine order/coverage mismatch")
    require(len(flat) == len(set(flat)), "entry assigned to multiple sections")
    reading = {}
    for section in sections:
        key = section["id"]
        require(key not in reading and isinstance(key, str), "duplicate/invalid section ID")
        text, mapping = book.section(section["entries"])
        substantive = section.get("substantive", True)
        require(isinstance(substantive, bool), "substantive must be Boolean")
        require(not substantive or bool(text), "empty substantive section")
        reading[key] = {"title": section["title"], "entries": section["entries"], "substantive": substantive,
                        "length": len(text), "offset": 0, "mapping": mapping, "sha256": digest(text.encode("utf-8")),
                        "status": "PENDING" if substantive else "EXCLUDED", "checkpoints": []}
    state = {"schema_version": 2, "run_id": request.get("run_id", str(uuid.uuid4())), "revision": 0, "stage": "PREPARE_READ",
             "identity": {"source": str(source), "source_sha256": book.sha256, "edition": request["edition"], "package_dir": str(package),
                          "agent_path": str(agent), "work_dir": str(work), "extractor": VERSION, "runtime_sha256": file_hash(__file__)},
             "test_fixture": request.get("test_fixture") is True, "reading_order": [x["id"] for x in sections], "reading": reading, "units": {}, "sealed": None, "mastery": {}}
    atomic(work / "state.json", encoded(state))
    return summary(state)


def main_request(request):
    op = request["op"]
    if op == "inventory":
        book = open_source(request["source"])
        offset, limit = request.get("offset", 0), request.get("limit", 10)
        require(isinstance(offset, int) and offset >= 0 and isinstance(limit, int) and 1 <= limit <= 20, "invalid inventory page")
        entries = book.linear[offset:offset + limit]
        return {"source_sha256": book.sha256, "title": book.title, "extractor": VERSION, "linear": entries,
                "linear_total": len(book.linear), "navigation_total": len(book.navigation_targets),
                "navigation_targets": book.navigation_targets[offset:offset + limit], "next_offset": offset + limit,
                "entries": [{"entry": e, "length": len(book.text(e)), "sha256": digest(book.text(e).encode("utf-8"))} for e in entries]}
    if op == "lookup":
        if request.get("work_dir"):
            work_state = json.loads((canonical(request["work_dir"]) / "state.json").read_text("utf-8"))
            identity_check(work_state, canonical(request["work_dir"]))
            require(work_state.get("mastery", {}).get("phase") not in CAPTURE, "lookup closed during capture")
        book, loc = open_source(request["source"]), request["locator"]
        require(loc["extractor"] == VERSION and loc["source_sha256"] == book.sha256, "locator source/extractor mismatch")
        result = envelope(book, loc["entries"], loc["start"], loc["end"])
        require(len(encoded(result)) <= MAX_BYTES, "lookup output too large; split the requested range")
        return result
    work = canonical(request["work_dir"])
    if op != "init":
        require((work / "state.json").is_file(), "missing runtime state")
    with locked(work):
        if op == "init":
            return init(request, work)
        state = json.loads((work / "state.json").read_text("utf-8"))
        identity_check(state, work)
        # Only explicit recovery mutates a pending transaction. Inspection stays read-only.
        if op == "recover":
            return summary(replay(work, state, request))
        require(not (work / "journal.json").exists(), "pending transaction; run recover first")
        if op == "status":
            return summary(state)
        new = copy_state(state)
        if op == "reading_view":
            require(state.get("mastery", {}).get("phase") not in CAPTURE, "reading evidence closed during capture")
            section = state["reading"][request["section_id"]]
            start = request.get("start", 0)
            value = encoded(section).decode("utf-8")
            require(isinstance(start, int) and 0 <= start <= len(value), "invalid evidence offset")
            return {"section_id": request["section_id"], "text": value[start:start + MAX_CHARS], "next_offset": min(start + MAX_CHARS, len(value)), "total_chars": len(value)}
        if op == "read_unit":
            require(state["stage"] == "PREPARE_READ" and not state.get("questions"), "reading pass is closed")
            pending = next((k for k in state["reading_order"] if state["reading"][k]["substantive"] and state["reading"][k]["status"] != "READ"), None)
            require(request["section_id"] == pending, "read out of source order")
            section = state["reading"][pending]
            current_text, _ = open_source(state["identity"]["source"]).section(section["entries"])
            require(digest(current_text.encode("utf-8")) == section["sha256"], "normalized extraction changed")
            return bounded_unit(open_source(state["identity"]["source"]), section["entries"], section["offset"], request.get("max_chars", MAX_CHARS))
        if op == "commit_reading":
            require(not state.get("questions"), "reading pass is closed")
            section_id = request["section_id"]
            section = new["reading"][section_id]
            unit_id = "reading:" + request["receipt"]
            payload = {"section_id": section_id, "receipt": request["receipt"], "evidence": request["evidence"]}
            if same_unit(state, unit_id, payload):
                return {"status": "already-committed", "revision": state["revision"]}
            pending = next((k for k in state["reading_order"] if state["reading"][k]["substantive"] and state["reading"][k]["status"] != "READ"), None)
            require(section_id == pending, "commit out of source order")
            value = bounded_unit(open_source(state["identity"]["source"]), section["entries"], section["offset"], request.get("max_chars", MAX_CHARS))
            require(request["receipt"] == value["receipt"], "missing/wrong terminal receipt")
            require(isinstance(request["evidence"], dict) and 0 < len(encoded(request["evidence"])) <= 12000, "evidence must be a bounded object")
            section["checkpoints"].append({"locator": value["locator"], "receipt": value["receipt"], "text_sha256": value["text_sha256"], "evidence": request["evidence"]})
            section["offset"] = value["locator"]["end"]
            section["status"] = "READ" if section["offset"] == section["length"] else "IN_PROGRESS"
            save_unit(new, unit_id, payload)
        elif op == "freeze_questions":
            require(not state.get("questions"), "questions already frozen")
            require(all(v["status"] in {"READ", "EXCLUDED"} for v in state["reading"].values()), "reading incomplete")
            qs, outline, plan = request["questions"], request["reconstruction_units"], request["score_plan"]
            require([q["id"] for q in qs] == [f"Q{i:02}" for i in range(1, 21)], "exactly ordered Q01-Q20 required")
            for q in qs:
                require(set(q) == {"id", "prompt", "expected_elements", "evidence_class", "locator", "section_ids", "affected_maps"}, "question schema mismatch")
                require(isinstance(q["prompt"], str) and 0 < len(q["prompt"]) <= 1500, "question prompt too large")
                require(q["expected_elements"] and q["section_ids"] and all(k in state["reading"] for k in q["section_ids"]), "question evidence incomplete")
                loc = q["locator"]
                require(loc["extractor"] == VERSION and loc["source_sha256"] == state["identity"]["source_sha256"], "question locator identity mismatch")
                require(loc["entries"] == [e for key in q["section_ids"] for e in state["reading"][key]["entries"]], "question locator must use its recorded section entry order")
                envelope(open_source(state["identity"]["source"]), loc["entries"], loc["start"], loc["end"])
            for item in outline:
                require(set(item) == {"id", "title"} and isinstance(item["title"], str) and len(item["title"]) <= 200, "outline schema/title size")
            ids = [x["id"] for x in outline]
            require(len(ids) == len(set(ids)) and {k for k, v in state["reading"].items() if v["substantive"]}.issubset(set(ids)) and "synthesis" in ids, "outline must cover section IDs plus synthesis")
            require(len({x["id"] for x in plan}) == len(plan), "duplicate scoring slice")
            totals = {k: 0 for k in COMPONENTS}
            for item in plan:
                require(item["component"] in totals and isinstance(item["max_points"], (int, float)) and item["max_points"] > 0, "invalid scoring slice")
                totals[item["component"]] += item["max_points"]
            require(totals == COMPONENTS, "scoring plan must total six fixed rubric components")
            new["questions"], new["outline"], new["score_plan"] = qs, outline, plan
            new["question_hash"] = digest(encoded(qs))
            new["mastery"] = {"attempt": 1, "started": False, "phase": "CAPTURE_RECONSTRUCTION", "reconstruction": {}, "answers": {}, "scores": {}, "verdicts": {}}
            new["stage"] = "MASTERY"
        elif op in {"capture_view", "captured_view", "evidence_view"}:
            m = state["mastery"]
            require(m, "mastery not initialized")
            if op == "capture_view":
                require(m["phase"] in CAPTURE, "capture is locked")
                offset, limit = request.get("offset", 0), request.get("limit", 4)
                require(isinstance(offset, int) and offset >= 0 and isinstance(limit, int) and 1 <= limit <= 4, "invalid capture page")
                result = {"questions": [{"id": q["id"], "prompt": q["prompt"]} for q in state["questions"][offset:offset + limit]],
                          "pending_outline": [x for x in state["outline"] if x["id"] not in m["reconstruction"]][:4], "phase": m["phase"]}
            elif op == "captured_view":
                key = request["id"]
                text = m["reconstruction"].get(key, m["answers"].get(key, ""))
                start = request.get("start", 0)
                result = {"id": key, "text": text[start:start + MAX_CHARS]}
            else:
                require(m["phase"] not in CAPTURE, "evidence closed until all capture is frozen")
                result = next(q for q in state["questions"] if q["id"] == request["id"])
            require(len(encoded(result)) <= MAX_BYTES, "view exceeds output budget; narrow request")
            return result
        elif op in {"checkpoint", "commit_files"}:
            category = request.get("category", "files")
            payload = {"category": category, "data": request.get("payload", request.get("files"))}
            unit_id = request["unit_id"]
            if op == "checkpoint" and category in {"reconstruction", "answers", "score", "verification"}:
                unit_id = "attempt-" + str(state["mastery"].get("attempt")) + ":" + unit_id
            if same_unit(state, unit_id, payload):
                return {"status": "already-committed", "revision": state["revision"]}
            if op == "checkpoint":
                require(len(encoded(payload)) <= MAX_BYTES, "checkpoint exceeds bounded unit size")
                m, data = new["mastery"], request["payload"]
                if category == "reconstruction":
                    require(m.get("phase") == "CAPTURE_RECONSTRUCTION" and data["id"] in [x["id"] for x in new["outline"]], "invalid reconstruction phase/id")
                    require(data["id"] not in m["reconstruction"], "reconstruction immutable")
                    require(isinstance(data["text"], str) and 0 < len(data["text"]) <= MAX_CHARS, "invalid reconstruction block")
                    m["reconstruction"][data["id"]] = data["text"]
                    m["started"] = True
                    if len(m["reconstruction"]) == len(new["outline"]):
                        m["phase"] = "CAPTURE_ANSWERS"
                elif category == "answers":
                    require(m.get("phase") == "CAPTURE_ANSWERS" and 1 <= len(data["answers"]) <= 4, "answer capture phase/size")
                    for qid, answer in data["answers"].items():
                        require(qid in [q["id"] for q in new["questions"]] and qid not in m["answers"] and isinstance(answer, str) and answer, "answer ID/immutability failure")
                    m["answers"].update(data["answers"])
                    m["started"] = True
                elif category == "score":
                    require(m.get("phase") == "SCORE", "not scoring")
                    item = next((x for x in new["score_plan"] if x["id"] == data["id"]), None)
                    require(item and data["id"] not in m["scores"] and isinstance(data["points"], (int, float)) and 0 <= data["points"] <= item["max_points"] and data["reason"], "invalid/duplicate score")
                    m["scores"][data["id"]] = data
                elif category == "verification":
                    require(m.get("phase") == "SCORE" and data["question_id"] in m["answers"] and data["question_id"] not in m["verdicts"], "verification phase/id/duplicate")
                    q = next(q for q in new["questions"] if q["id"] == data["question_id"])
                    require(type(data["correct"]) is bool and data["reason"] and data["locator"] == q["locator"], "verification evidence/locator missing")
                    book = open_source(new["identity"]["source"])
                    loc = data["locator"]
                    value = envelope(book, loc["entries"], loc["start"], loc["end"])
                    require(data["lookup_sha256"] == value["text_sha256"], "verification source window digest mismatch")
                    m["verdicts"][data["question_id"]] = data
                else:
                    require(category in {"derived", "validation"} and m.get("phase") not in CAPTURE, "checkpoint category/phase forbidden")
                save_unit(new, unit_id, payload)
            else:
                require(state.get("mastery", {}).get("phase") not in CAPTURE, "capture may not modify evidence files")
                if any(canonical(x["target"]) == canonical(state["identity"]["agent_path"]) for x in request["files"]):
                    require(state.get("sealed"), "Agent requires sealed passing package")
                save_unit(new, unit_id, payload)
                new = transaction(work, state, new, request, request["files"])
                return {"status": "committed", "revision": new["revision"]}
        elif op == "begin_scoring":
            m = new["mastery"]
            require(m.get("phase") == "CAPTURE_ANSWERS" and len(m["answers"]) == 20 and len(m["reconstruction"]) == len(new["outline"]), "capture incomplete")
            m["capture_sha256"] = digest(encoded({"reconstruction": m["reconstruction"], "answers": m["answers"]}))
            m["phase"] = "SCORE"
        elif op == "decide":
            m = new["mastery"]
            require(m.get("phase") == "SCORE" and len(m["scores"]) == len(new["score_plan"]) and len(m["verdicts"]) == 20, "scoring/verification incomplete")
            m["score"] = sum(x["points"] for x in m["scores"].values())
            m["correct"] = sum(x["correct"] for x in m["verdicts"].values())
            m["phase"] = "PASSED" if m["score"] >= 90 and m["correct"] >= 18 else "FAILED"
            m["failed_ids"] = [k for k, x in m["verdicts"].items() if not x["correct"]]
            m["failed_score_ids"] = [x["id"] for x in new["score_plan"] if m["scores"][x["id"]]["points"] < x["max_points"]]
        elif op == "begin_remediation":
            m = new["mastery"]
            require(m.get("phase") == "FAILED" and m["attempt"] == 1 and request.get("authorization") and not canonical(new["identity"]["agent_path"]).exists(), "remediation not authorized/eligible")
            require(not new.get("attempt_1"), "remediation already started")
            new["attempt_1"] = copy_state(m)
            new["remediation_authorization"] = request["authorization"]
            m["phase"] = "REMEDIATE"
        elif op == "start_attempt_2":
            m = new["mastery"]
            require(m.get("phase") == "REMEDIATE" and m["attempt"] == 1, "no second remediation/third attempt")
            record = new["units"].get("remediation-complete", {}).get("payload", {})
            data = record.get("data", {})
            require(record.get("category") == "validation" and set(data.get("failed_ids", [])) == set(m["failed_ids"])
                    and set(data.get("failed_score_ids", [])) == set(m["failed_score_ids"]) and data.get("passed") is True, "remediation coverage not committed")
            new["mastery"] = {"attempt": 2, "started": False, "phase": "CAPTURE_RECONSTRUCTION", "reconstruction": {}, "answers": {}, "scores": {}, "verdicts": {}}
        elif op == "view_file":
            require(new.get("mastery", {}).get("phase") not in CAPTURE, "file evidence closed during capture")
            path = canonical(request["path"])
            require(path.parent == canonical(new["identity"]["package_dir"]) and path.name in PACKAGE_FILES, "view outside package")
            text = path.read_text("utf-8")
            start = request.get("start", 0)
            require(isinstance(start, int) and 0 <= start <= len(text), "invalid file offset")
            return {"text": text[start:start + MAX_CHARS], "next_offset": min(start + MAX_CHARS, len(text)), "total_chars": len(text)}
        elif op == "seal":
            require(new["mastery"].get("phase") == "PASSED" and not new["sealed"], "mastery pass required before first seal")
            package = canonical(new["identity"]["package_dir"])
            require({p.name for p in package.iterdir()} == PACKAGE_FILES and all((package / p).is_file() for p in PACKAGE_FILES), "exact eight-file package required")
            manifest = json.loads((package / "source-manifest.json").read_text("utf-8"))
            require(manifest.get("source_sha256") == new["identity"]["source_sha256"], "manifest source mismatch")
            for name in PACKAGE_FILES - {"source-manifest.json"}:
                require(manifest.get("file_sha256", {}).get(name) == file_hash(package / name), "manifest file hash mismatch: " + name)
            new["sealed"] = {name: file_hash(package / name) for name in sorted(PACKAGE_FILES)}
            new["stage"] = "CREATE_AGENT"
        elif op == "complete":
            require(new.get("sealed") and canonical(new["identity"]["agent_path"]).is_file(), "sealed package and Agent required")
            for name in ("toml", "doctor", "parent-canary"):
                record = new["units"].get(name, {}).get("payload", {})
                data = record.get("data", {})
                require(record.get("category") == "validation" and data.get("passed") is True, "missing passing " + name)
                if name == "doctor":
                    require(data.get("exit_code") == 0 and data.get("config_load") == "ok", "Doctor did not pass")
                if name == "parent-canary":
                    require(data.get("runtime_identity_verified") is True and data.get("evidence"), "unverified runtime identity/canary")
            for name, sha in new["sealed"].items():
                require(file_hash(canonical(new["identity"]["package_dir"]) / name) == sha, "sealed package changed")
            new["stage"] = "COMPLETE"
        else:
            raise Rejected("unknown operation: " + op)
        new = transaction(work, state, new, request)
        return {"status": "committed", "revision": new["revision"], "stage": new["stage"], "mastery_phase": new.get("mastery", {}).get("phase")}


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", required=True, help="UTF-8 JSON request path, or - for stdin")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        raw = sys.stdin.buffer.read() if args.request == "-" else Path(args.request).read_bytes()
        request = json.loads(raw.decode("utf-8-sig"))
        value = main_request(request)
        # Keep receipt last in delivered output; canonical hashing remains independent of key order.
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (Rejected, KeyError, ValueError, OSError, zipfile.BadZipFile, ET.ParseError, StopIteration) as exc:
        print(json.dumps({"status": "validation-failed", "error": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(cli())
