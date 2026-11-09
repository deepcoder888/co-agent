"""A-book v3: scoped source reading, grounded QA and recoverable checkpoints."""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
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

VERSION = "abook-source-nfc-codepoints-v3.0"
PROFILE = "GROUNDED_QA_V3"
PACKAGE_FILES = {"source-manifest.json", "coverage-ledger.json", "chapter-map.md",
                 "concept-map.md", "first-principles.md", "retrieval-bank.md",
                 "action-map.md", "README.md"}
EXCLUSION_KINDS = {"endorsement", "review", "promotion", "acknowledgments",
                   "bibliography", "navigation", "publication_metadata"}
QUESTION_KINDS = {"definition", "dependency", "mechanism", "boundary", "action"}
NLPM_SKILLS = {"writing-agents", "rules", "conventions", "conventions-codex", "scoring"}
MARKDOWN_FILES = PACKAGE_FILES - {"source-manifest.json", "coverage-ledger.json"}
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
    require(state.get("schema_version") == 3 and state.get("assessment_profile") == PROFILE,
            "v3 requires a new GROUNDED_QA_V3 run; preserve legacy state/runtime")
    require(state["identity"]["work_dir"] == str(work), "work identity mismatch")
    require(state["identity"]["extractor"] == VERSION, "extractor version mismatch")
    require(state["identity"]["runtime_sha256"] == file_hash(__file__), "runtime changed; reviewed migration required")
    for key in ("source", "package_dir", "agent_path", "work_dir"):
        require(str(canonical(state["identity"][key])) == state["identity"][key], "canonical path identity changed")
    require(file_hash(state["identity"]["source"]) == state["identity"]["source_sha256"], "source changed")
    if state.get("questions"):
        require(digest(encoded(state["questions"])) == state["question_hash"], "frozen question specification changed")
    assessment = state.get("assessment", {})
    if assessment.get("answers_sha256"):
        require(digest(encoded(assessment["answers"])) == assessment["answers_sha256"], "frozen answers changed")
    if state.get("round_1"):
        require(digest(encoded(state["round_1"])) == state["round_1_sha256"], "first round changed")
    if state.get("evidence_hashes") and assessment.get("phase") != "REPAIR":
        for name, sha in state["evidence_hashes"].items():
            require(file_hash(canonical(state["identity"]["package_dir"]) / name) == sha,
                    "QA evidence map changed outside repair: " + name)
    if state.get("sealed"):
        for name, sha in state["sealed"].items():
            require(file_hash(canonical(state["identity"]["package_dir"]) / name) == sha, "sealed package changed: " + name)
    require(len(state["reading_order"]) == len(set(state["reading_order"])) and set(state["reading_order"]) == set(state["reading"]), "reading order corrupt")
    for section in state["reading"].values():
        require(digest(encoded(section["exclusions"])) == section["exclusions_sha256"], "excluded ranges changed")
        offset = skip_excluded(section, 0)
        for checkpoint in section["checkpoints"]:
            loc = checkpoint["locator"]
            require(loc["start"] == offset and offset < loc["end"] <= section["length"], "reading checkpoint gap/overlap")
            require(included_window(section, loc["start"], loc["end"]), "reading overlaps excluded content")
            require(loc["entries"] == section["entries"] and loc["source_sha256"] == state["identity"]["source_sha256"] and loc["extractor"] == VERSION, "checkpoint locator identity mismatch")
            offset = skip_excluded(section, loc["end"])
        require(offset == section["offset"], "reading offset differs from committed coverage")
        if section["status"] == "READ":
            require(section["substantive"] and offset == section["length"], "incomplete section marked READ")


def skip_excluded(section, offset):
    for span in section["exclusions"]:
        if span["start"] <= offset < span["end"]:
            offset = span["end"]
    return offset


def included_window(section, start, end):
    return (section["substantive"] and type(start) is int and type(end) is int
            and 0 <= start < end <= section["length"]
            and not any(start < x["end"] and end > x["start"] for x in section["exclusions"]))


def reading_unit(state, section, max_chars=MAX_CHARS):
    require(type(max_chars) is int and 1 <= max_chars <= MAX_CHARS, "max_chars out of range")
    end = next((x["start"] for x in section["exclusions"] if x["start"] > section["offset"]), section["length"])
    book = open_source(state["identity"]["source"])
    text, _ = book.section(section["entries"])
    require(digest(text.encode("utf-8")) == section["sha256"], "normalized extraction changed")
    return bounded_unit(book, section["entries"], section["offset"], min(max_chars, end - section["offset"]))


def substantive_ids(state):
    return [k for k in state["reading_order"] if state["reading"][k]["substantive"]]


def coverage(state):
    sections = state["reading"].values()
    excluded = sum(x["end"] - x["start"] for s in sections for x in s["exclusions"])
    included = sum(s["length"] for s in sections) - excluded
    read = sum(c["locator"]["end"] - c["locator"]["start"] for s in sections for c in s["checkpoints"])
    return {"scope": "author-substantive-content", "included_chars": included,
            "excluded_chars": excluded, "read_chars": read,
            "included_percent": round(100 * read / included, 4) if included else 0}


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
    a = state.get("assessment", {})
    elapsed = max(0, (datetime.now(timezone.utc) - datetime.fromisoformat(state["started_at"])).total_seconds() / 60)
    return {"run_id": state["run_id"], "identity": state["identity"], "revision": state["revision"],
            "stage": state["stage"], "coverage": coverage(state), "substantive_total": len(substantive_ids(state)),
            "reading": {k: {"offset": v["offset"], "length": v["length"], "status": v["status"]}
                        for k, v in [(k, state["reading"][k]) for k in state["reading_order"]
                                     if state["reading"][k]["substantive"] and state["reading"][k]["status"] != "READ"][:4]},
            "budget": {"target_minutes": 240, "elapsed_minutes": round(elapsed, 2), "target_exceeded": elapsed > 240},
            "committed_units": len(state["units"]), "assessment_profile": PROFILE,
            "assessment": {k: a.get(k) for k in ("round", "phase", "correct", "critical_count", "failed_ids", "required_ids")},
            "closed_book_mastery": "NOT_PERFORMED"}


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
    model = request.get("agent_model", "gpt-5.6-sol")
    effort = request.get("agent_reasoning_effort", "xhigh")
    require(isinstance(model, str) and model.strip() and isinstance(effort, str) and effort.strip(), "invalid generated model override")
    if (model, effort) != ("gpt-5.6-sol", "xhigh"):
        require(isinstance(request.get("model_override_authorization"), str) and request["model_override_authorization"].strip(), "explicit model override authorization required")
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
        kind = section.get("kind", "content")
        exclusions = section.get("exclusions", [])
        require(isinstance(exclusions, list), "exclusions must be a list")
        if not substantive:
            require(kind in EXCLUSION_KINDS and isinstance(section.get("reason"), str) and section["reason"].strip(),
                    "excluded section requires a permitted kind and reason")
            require(not exclusions, "whole excluded section cannot also declare partial ranges")
            exclusions = [{"start": 0, "end": len(text), "kind": kind, "reason": section["reason"]}] if text else []
        else:
            require(kind == "content", "included section kind must be content")
        spans, end = [], 0
        for span in exclusions:
            require(set(span) == {"start", "end", "kind", "reason"}, "exclusion schema mismatch")
            require(type(span["start"]) is int and type(span["end"]) is int
                    and end <= span["start"] < span["end"] <= len(text), "excluded ranges overlap/order/bounds")
            require(span["kind"] in EXCLUSION_KINDS and isinstance(span["reason"], str) and span["reason"].strip(),
                    "invalid exclusion kind/reason")
            spans.append({**span, "text_sha256": digest(text[span["start"]:span["end"]].encode("utf-8"))})
            end = span["end"]
        included = len(text) - sum(x["end"] - x["start"] for x in spans)
        require(not substantive or included > 0, "included section must retain substantive text")
        reading[key] = {"title": section["title"], "entries": section["entries"], "substantive": substantive,
                        "kind": kind, "reason": section.get("reason", ""), "exclusions": spans,
                        "exclusions_sha256": digest(encoded(spans)),
                        "length": len(text), "offset": 0, "mapping": mapping, "sha256": digest(text.encode("utf-8")),
                        "status": "PENDING" if substantive else "EXCLUDED", "checkpoints": []}
        reading[key]["offset"] = skip_excluded(reading[key], 0)
    require(any(s["substantive"] for s in reading.values()), "at least one substantive section required")
    state = {"schema_version": 3, "assessment_profile": PROFILE, "started_at": datetime.now(timezone.utc).isoformat(), "run_id": request.get("run_id", str(uuid.uuid4())), "revision": 0, "stage": "PREPARE_READ",
             "identity": {"source": str(source), "source_sha256": book.sha256, "edition": request["edition"], "package_dir": str(package),
                          "agent_path": str(agent), "work_dir": str(work), "agent_model": model, "agent_reasoning_effort": effort, "model_override_authorization": request.get("model_override_authorization", ""), "extractor": VERSION, "runtime_sha256": file_hash(__file__)},
             "test_fixture": request.get("test_fixture") is True, "reading_order": [x["id"] for x in sections], "reading": reading, "units": {}, "sealed": None, "assessment": {}}
    atomic(work / "state.json", encoded(state))
    return summary(state)



def evidence_window(state, item):
    require(set(item) == {"section_id", "locator"}, "evidence schema mismatch")
    section = state["reading"].get(item["section_id"])
    require(section and section["status"] == "READ", "question evidence must be read substantive content")
    loc = item["locator"]
    require(set(loc) == {"entries", "start", "end", "extractor", "source_sha256"}, "locator schema mismatch")
    require(loc["entries"] == section["entries"] and loc["extractor"] == VERSION
            and loc["source_sha256"] == state["identity"]["source_sha256"], "evidence identity mismatch")
    require(included_window(section, loc["start"], loc["end"]), "evidence overlaps excluded or unread content")
    value = envelope(open_source(state["identity"]["source"]), loc["entries"], loc["start"], loc["end"])
    require(len(encoded(value)) <= MAX_BYTES, "evidence envelope too large; narrow frozen window")
    return value


def validate_answer(state, question, answer):
    require(isinstance(answer, dict) and set(answer) == {"text", "lookups"}, "answer schema mismatch")
    require(isinstance(answer["text"], str) and 0 < len(answer["text"]) <= 3000, "answer text size")
    require(isinstance(answer["lookups"], list) and len(answer["lookups"]) == len(question["evidence"]), "all frozen windows require lookups")
    for expected, lookup in zip(question["evidence"], answer["lookups"]):
        require(set(lookup) == {"section_id", "locator", "text_sha256", "receipt"}, "lookup record schema")
        require({k: lookup[k] for k in ("section_id", "locator")} == expected, "answer lookup differs from frozen window")
        value = evidence_window(state, expected)
        require(lookup["text_sha256"] == value["text_sha256"] and lookup["receipt"] == value["receipt"], "answer source receipt mismatch")


def validation_record(state, name):
    record = state["units"].get(name, {}).get("payload", {})
    data = record.get("data", {})
    require(record.get("category") == "validation" and data.get("passed") is True, "missing passing " + name)
    return data


def audit_package(state):
    require(state.get("assessment", {}).get("phase") == "PASSED_GROUNDED", "grounded QA pass required")
    data = validation_record(state, "package-audit")
    require(data.get("substantive_section_ids") == substantive_ids(state), "chapter coverage audit mismatch")
    concepts = data.get("concepts", [])
    require(isinstance(concepts, list) and len(concepts) == 3 and all(isinstance(x, str) and x.strip() for x in concepts)
            and len(set(concepts)) == 3, "three distinct audited concepts required")
    require(all(data.get(k) is True for k in ("chapter_locators_checked", "figures_checked",
                                            "conditions_checked", "exclusions_checked")), "package audit incomplete")
    package = canonical(state["identity"]["package_dir"])
    require(all((package / name).is_file() and (package / name).read_text("utf-8").strip() for name in MARKDOWN_FILES),
            "six nonempty Markdown maps required")
    chars = sum(len((package / name).read_text("utf-8")) for name in MARKDOWN_FILES)
    require(chars <= 20000 or bool(data.get("prose_overrun_reason", "").strip()), "explain prose budget overrun")
    require(all(s["status"] in {"READ", "EXCLUDED"} for s in state["reading"].values()), "included coverage incomplete")
    return chars


def ledger_projection(state):
    a = state["assessment"]
    return {"schema_version": 3, "run_id": state["run_id"], "source_sha256": state["identity"]["source_sha256"],
            "assessment_profile": PROFILE, "closed_book_mastery": "NOT_PERFORMED",
            "coverage": coverage(state), "reading_order": state["reading_order"],
            "reading": {k: {**{field: s[field] for field in ("title", "entries", "substantive", "kind", "reason",
                                                           "exclusions", "length", "offset", "status")},
                            "checkpoints": [{f: c[f] for f in ("locator", "receipt", "text_sha256")} for c in s["checkpoints"]]}
                        for k, s in state["reading"].items()},
            "assessment": {"phase": a["phase"], "round": a["round"], "correct": a["correct"],
                           "critical_count": a["critical_count"], "failed_ids": a["failed_ids"],
                           "question_hash": state["question_hash"]}}


def check_agent_draft(state, content):
    import tomllib
    gate = validation_record(state, "nlpm")
    require(type(gate.get("score")) in (int, float) and 90 <= gate["score"] <= 100
            and set(gate.get("skills", [])) == NLPM_SKILLS, "NLPM score/skills incomplete")
    require(gate.get("draft_sha256") == digest(content.encode("utf-8")), "NLPM draft hash mismatch")
    parsed = tomllib.loads(content)
    require(parsed.get("model") == state["identity"]["agent_model"]
            and parsed.get("model_reasoning_effort") == state["identity"]["agent_reasoning_effort"], "generated model fields mismatch")
    require(parsed.get("sandbox_mode") == "read-only" and parsed.get("approval_policy") == "never"
            and parsed.get("web_search") == "live", "generated Agent permission contract")
    require(all(isinstance(parsed.get(k), str) and parsed[k].strip() for k in ("name", "description", "developer_instructions")),
            "generated Agent required fields")
    require("model_provider" not in parsed and "tools" not in parsed, "unsupported/forbidden generated Agent field")
    return parsed


def main_request(request):
    op = request["op"]
    if op == "inventory":
        book = open_source(request["source"])
        offset, limit = request.get("offset", 0), request.get("limit", 10)
        require(type(offset) is int and offset >= 0 and type(limit) is int and 1 <= limit <= 20, "invalid inventory page")
        entries = book.linear[offset:offset + limit]
        return {"source_sha256": book.sha256, "title": book.title, "extractor": VERSION, "linear": entries,
                "linear_total": len(book.linear), "navigation_total": len(book.navigation_targets),
                "navigation_targets": book.navigation_targets[offset:offset + limit], "next_offset": offset + limit,
                "entries": [{"entry": e, "length": len(book.text(e)), "sha256": digest(book.text(e).encode("utf-8"))} for e in entries]}
    if op == "lookup":
        if request.get("work_dir"):
            work = canonical(request["work_dir"])
            work_state = json.loads((work / "state.json").read_text("utf-8"))
            identity_check(work_state, work)
            require(canonical(request["source"]) == canonical(work_state["identity"]["source"]), "lookup source differs from run")
        book, loc = open_source(request["source"]), request["locator"]
        require(loc["extractor"] == VERSION and loc["source_sha256"] == book.sha256, "locator source/extractor mismatch")
        result = envelope(book, loc["entries"], loc["start"], loc["end"])
        require(len(encoded(result)) <= MAX_BYTES, "lookup output too large; split range")
        return result
    work = canonical(request["work_dir"])
    if op != "init":
        require((work / "state.json").is_file(), "missing runtime state")
    with locked(work):
        if op == "init":
            return init(request, work)
        state = json.loads((work / "state.json").read_text("utf-8"))
        identity_check(state, work)
        if op == "recover":
            return summary(replay(work, state, request))
        require(not (work / "journal.json").exists(), "pending transaction; run recover first")
        if op == "status":
            return summary(state)
        new = copy_state(state)
        if op == "reading_view":
            section = state["reading"][request["section_id"]]
            start = request.get("start", 0)
            value = encoded(section).decode("utf-8")
            require(type(start) is int and 0 <= start <= len(value), "invalid evidence offset")
            return {"section_id": request["section_id"], "text": value[start:start + MAX_CHARS],
                    "next_offset": min(start + MAX_CHARS, len(value)), "total_chars": len(value)}
        if op == "read_unit":
            require(state["stage"] == "PREPARE_READ" and not state.get("questions"), "reading pass closed")
            pending = next((k for k in substantive_ids(state) if state["reading"][k]["status"] != "READ"), None)
            require(request["section_id"] == pending, "read out of source order")
            return reading_unit(state, state["reading"][pending], request.get("max_chars", MAX_CHARS))
        if op == "commit_reading":
            require(not state.get("questions"), "reading pass closed")
            sid = request["section_id"]
            section = new["reading"][sid]
            unit_id = "reading:" + request["receipt"]
            payload = {"section_id": sid, "receipt": request["receipt"], "evidence": request["evidence"]}
            if same_unit(state, unit_id, payload):
                return {"status": "already-committed", "revision": state["revision"]}
            pending = next((k for k in substantive_ids(state) if state["reading"][k]["status"] != "READ"), None)
            require(sid == pending, "commit out of source order")
            value = reading_unit(state, section, request.get("max_chars", MAX_CHARS))
            require(request["receipt"] == value["receipt"], "missing/wrong terminal receipt")
            require(isinstance(request["evidence"], dict) and 0 < len(encoded(request["evidence"])) <= 12000, "bounded evidence object required")
            section["checkpoints"].append({"locator": value["locator"], "receipt": value["receipt"],
                                          "text_sha256": value["text_sha256"], "evidence": request["evidence"]})
            section["offset"] = skip_excluded(section, value["locator"]["end"])
            section["status"] = "READ" if section["offset"] == section["length"] else "IN_PROGRESS"
            save_unit(new, unit_id, payload)
        elif op == "freeze_questions":
            require(not state.get("questions") and all(v["status"] in {"READ", "EXCLUDED"} for v in state["reading"].values()), "questions frozen or reading incomplete")
            qs = request["questions"]
            require(isinstance(qs, list) and [q["id"] for q in qs] == [f"Q{i:02}" for i in range(1, 21)], "exactly ordered Q01-Q20 required")
            used = set()
            for q in qs:
                require(set(q) == {"id", "prompt", "kind", "expected_elements", "evidence_class", "evidence", "affected_maps"}, "question schema mismatch")
                require(isinstance(q["prompt"], str) and 0 < len(q["prompt"]) <= 1500, "question prompt size")
                require(q["kind"] in QUESTION_KINDS and q["evidence_class"] in {"BOOK", "INTERPRETATION", "INFERENCE", "CRITIQUE"}, "question kind/class")
                require(isinstance(q["expected_elements"], list) and 1 <= len(q["expected_elements"]) <= 6
                        and all(isinstance(x, str) and 0 < len(x) <= 500 for x in q["expected_elements"]), "essential answer criteria required")
                require(isinstance(q["affected_maps"], list) and q["affected_maps"] and set(q["affected_maps"]) <= MARKDOWN_FILES, "affected maps invalid")
                require(isinstance(q["evidence"], list) and 1 <= len(q["evidence"]) <= 4, "one to four evidence windows required")
                require(len({digest(encoded(e)) for e in q["evidence"]}) == len(q["evidence"]), "duplicate evidence window")
                for item in q["evidence"]:
                    evidence_window(state, item)
                    used.add(item["section_id"])
                require(len(encoded(q)) <= MAX_BYTES, "question specification exceeds view budget")
            require({q["kind"] for q in qs} == QUESTION_KINDS, "all five question kinds required")
            ids = substantive_ids(state)
            groups = [ids] if len(ids) < 3 else [ids[i * len(ids) // 3:(i + 1) * len(ids) // 3] for i in range(3)]
            require(all(set(g) & used for g in groups) and (len(ids) >= 3 or set(ids) <= used), "question evidence must span source thirds")
            package = canonical(state["identity"]["package_dir"])
            require(all((package / name).is_file() and (package / name).read_text("utf-8").strip() for name in MARKDOWN_FILES),
                    "finish six evidence maps before freezing questions")
            new["evidence_hashes"] = {name: file_hash(package / name) for name in MARKDOWN_FILES}
            new["questions"], new["question_hash"] = qs, digest(encoded(qs))
            new["assessment"] = {"round": 1, "phase": "ANSWERING", "required_ids": [q["id"] for q in qs], "answers": {}, "verdicts": {}}
            new["stage"] = "GROUNDED_QA"
        elif op in {"question_view", "answer_view", "evidence_view"}:
            a = state["assessment"]
            require(a, "assessment not initialized")
            if op == "question_view":
                offset, limit = request.get("offset", 0), request.get("limit", 4)
                require(type(offset) is int and offset >= 0 and type(limit) is int and 1 <= limit <= 4, "invalid question page")
                selected = [q for q in state["questions"] if q["id"] in a["required_ids"]]
                result = {"questions": [{k: q[k] for k in ("id", "prompt", "kind", "evidence", "evidence_class")} for q in selected[offset:offset + limit]],
                          "pending_ids": [k for k in a["required_ids"] if k not in a["answers"]], "phase": a["phase"]}
            elif op == "answer_view":
                answer = a["answers"][request["id"]]
                start = request.get("start", 0)
                value = encoded(answer).decode("utf-8")
                require(type(start) is int and 0 <= start <= len(value), "invalid answer offset")
                result = {"id": request["id"], "text": value[start:start + MAX_CHARS], "total_chars": len(value)}
            else:
                require(a["phase"] in {"VERIFYING", "PASSED_GROUNDED", "FAILED", "REPAIR"}, "criteria closed until answers frozen")
                result = next(q for q in state["questions"] if q["id"] == request["id"])
            require(len(encoded(result)) <= MAX_BYTES, "view exceeds budget; narrow request")
            return result
        elif op in {"checkpoint", "commit_files"}:
            category = request.get("category", "files")
            payload = {"category": category, "data": request.get("payload", request.get("files"))}
            unit_id = request["unit_id"]
            if op == "checkpoint" and category in {"answers", "verification"}:
                unit_id = "round-" + str(state["assessment"].get("round")) + ":" + unit_id
            if same_unit(state, unit_id, payload):
                return {"status": "already-committed", "revision": state["revision"]}
            if op == "checkpoint":
                require(len(encoded(payload)) <= MAX_BYTES, "checkpoint exceeds bounded size")
                a, data = new["assessment"], request["payload"]
                require(isinstance(data, dict), "checkpoint payload must be an object")
                if category == "answers":
                    require(a.get("phase") == "ANSWERING" and isinstance(data.get("answers"), dict) and 1 <= len(data["answers"]) <= 4, "answer phase/batch size")
                    for qid, answer in data["answers"].items():
                        require(qid in a["required_ids"] and qid not in a["answers"], "answer ID frozen/not selected")
                        q = next(q for q in new["questions"] if q["id"] == qid)
                        validate_answer(state, q, answer)
                    a["answers"].update(data["answers"])
                elif category == "verification":
                    require(a.get("phase") == "VERIFYING" and isinstance(data.get("verdicts"), list) and 1 <= len(data["verdicts"]) <= 4, "verification phase/batch size")
                    for verdict in data["verdicts"]:
                        require(set(verdict) == {"question_id", "correct", "critical", "reason", "missing_elements"}, "verdict schema")
                        qid = verdict["question_id"]
                        require(qid in a["required_ids"] and qid in a["answers"] and qid not in a["verdicts"], "verdict ID/frozen/duplicate")
                        require(type(verdict["correct"]) is bool and type(verdict["critical"]) is bool
                                and not (verdict["correct"] and verdict["critical"]), "verdict booleans/critical inconsistent")
                        require(isinstance(verdict["reason"], str) and verdict["reason"].strip()
                                and isinstance(verdict["missing_elements"], list)
                                and all(isinstance(x, str) for x in verdict["missing_elements"]), "verdict evidence missing")
                        require(not verdict["correct"] or not verdict["missing_elements"], "correct verdict cannot omit required elements")
                        q = next(q for q in new["questions"] if q["id"] == qid)
                        validate_answer(state, q, a["answers"][qid])
                        a["verdicts"][qid] = verdict
                else:
                    require(category in {"derived", "validation"}, "unsupported v3 checkpoint category")
                save_unit(new, unit_id, payload)
            else:
                phase = state.get("assessment", {}).get("phase")
                require(phase not in {"ANSWERING", "VERIFYING", "FAILED"}, "evidence files frozen; begin one repair after failure")
                require(isinstance(request["files"], list) and request["files"], "nonempty file transaction required")
                agent_path = canonical(state["identity"]["agent_path"])
                for item in request["files"]:
                    path = allowed_target(state, item["target"])
                    if path == agent_path:
                        require(state.get("sealed"), "Agent requires sealed passing package")
                        require("content" in item and "append" not in item, "Agent must be a complete reviewed draft")
                        check_agent_draft(state, item["content"])
                        require(file_hash(path) in (None, digest(item["content"].encode("utf-8"))), "Agent name-conflict")
                    elif phase == "REPAIR":
                        affected = {f for q in state["questions"] if q["id"] in state["assessment"]["failed_ids"] for f in q["affected_maps"]}
                        require(path.name in affected, "repair may edit only failed questions' affected maps")
                    elif phase == "PASSED_GROUNDED":
                        require(path.name not in MARKDOWN_FILES, "passed evidence maps stay frozen; only metadata may be finalized")
                save_unit(new, unit_id, payload)
                new = transaction(work, state, new, request, request["files"])
                return {"status": "committed", "revision": new["revision"]}
        elif op == "begin_verification":
            a = new["assessment"]
            require(a.get("phase") == "ANSWERING" and len(a["answers"]) == 20, "answers incomplete")
            a["answers_sha256"] = digest(encoded(a["answers"]))
            a["phase"] = "VERIFYING"
        elif op == "decide":
            a = new["assessment"]
            require(a.get("phase") == "VERIFYING" and len(a["answers"]) == 20 and len(a["verdicts"]) == 20, "answer/verification incomplete")
            a["correct"] = sum(v["correct"] for v in a["verdicts"].values())
            a["critical_count"] = sum(v["critical"] for v in a["verdicts"].values())
            a["failed_ids"] = [k for k, v in a["verdicts"].items() if not v["correct"]]
            passed = a["correct"] >= 18 and a["critical_count"] == 0
            if a["round"] == 2:
                passed = passed and all(a["verdicts"][k]["correct"] for k in a["required_ids"])
            a["phase"] = "PASSED_GROUNDED" if passed else "FAILED"
        elif op == "begin_repair":
            a = new["assessment"]
            require(a.get("phase") == "FAILED" and a["round"] == 1 and not new.get("round_1")
                    and not new.get("sealed") and not canonical(new["identity"]["agent_path"]).exists(), "one local repair only")
            new["round_1"] = copy_state(a)
            new["round_1_sha256"] = digest(encoded(a))
            passed = [k for k, v in a["verdicts"].items() if v["correct"]]
            sampled = sorted(passed, key=lambda k: digest((state["question_hash"] + k).encode("utf-8")))[:3]
            a["retest_ids"] = sorted(set(a["failed_ids"] + sampled))
            a["phase"] = "REPAIR"
            new["repair_map_hashes"] = {f: file_hash(canonical(state["identity"]["package_dir"]) / f) for f in MARKDOWN_FILES}
        elif op == "start_retest":
            a = new["assessment"]
            require(a.get("phase") == "REPAIR" and a["round"] == 1, "no third round")
            data = validation_record(state, "repair-complete")
            require(sorted(data.get("failed_ids", [])) == sorted(a["failed_ids"]), "repair failed-ID coverage mismatch")
            repairs = data.get("repairs", [])
            require(isinstance(repairs, list) and sorted(r.get("question_id", "") for r in repairs) == sorted(a["failed_ids"]), "repair records incomplete/duplicate")
            for r in repairs:
                require(r.get("action") in {"answer_only", "maps_corrected"} and isinstance(r.get("reason"), str) and r["reason"].strip()
                        and isinstance(r.get("map_files"), list), "repair action/reason/map files missing")
                q = next(q for q in new["questions"] if q["id"] == r["question_id"])
                require(set(r["map_files"]) <= set(q["affected_maps"]), "repair map outside failed question")
                if r["action"] == "maps_corrected":
                    require(r["map_files"] and all(file_hash(canonical(state["identity"]["package_dir"]) / f) != state["repair_map_hashes"][f]
                                                   for f in r["map_files"]), "claimed map repair has no change")
                else:
                    require(not r["map_files"], "answer-only repair cannot claim map changes")
            selected = a["retest_ids"]
            package = canonical(state["identity"]["package_dir"])
            affected = {f for q in state["questions"] if q["id"] in a["failed_ids"] for f in q["affected_maps"]}
            declared = {f for r in repairs for f in r["map_files"]}
            changed = {f for f in MARKDOWN_FILES if file_hash(package / f) != state["repair_map_hashes"][f]}
            require(changed <= affected and changed == declared, "repair map changes differ from declared scoped repairs")
            require(all((package / f).is_file() and (package / f).read_text("utf-8").strip() for f in MARKDOWN_FILES), "repair removed an evidence map")
            new["evidence_hashes"] = {f: file_hash(package / f) for f in MARKDOWN_FILES}
            new["assessment"] = {"round": 2, "phase": "ANSWERING", "required_ids": selected,
                                 "answers": {k: v for k, v in a["answers"].items() if k not in selected},
                                 "verdicts": {k: v for k, v in a["verdicts"].items() if k not in selected}}
        elif op == "view_file":
            path = canonical(request["path"])
            require(path.parent == canonical(new["identity"]["package_dir"]) and path.name in PACKAGE_FILES, "view outside package")
            text = path.read_text("utf-8")
            start = request.get("start", 0)
            require(type(start) is int and 0 <= start <= len(text), "invalid file offset")
            return {"text": text[start:start + MAX_CHARS], "next_offset": min(start + MAX_CHARS, len(text)), "total_chars": len(text)}
        elif op == "prepare_manifest":
            require(not state.get("sealed"), "sealed package immutable")
            chars = audit_package(state)
            package = canonical(state["identity"]["package_dir"])
            ledger = encoded(ledger_projection(state)).decode("utf-8")
            hashes = {f: file_hash(package / f) for f in MARKDOWN_FILES}
            hashes["coverage-ledger.json"] = digest(ledger.encode("utf-8"))
            manifest = {"schema_version": 3, **state["identity"], "run_id": state["run_id"], "assessment_profile": PROFILE,
                        "closed_book_mastery": "NOT_PERFORMED", "acceptance": "PASSED_GROUNDED",
                        "prose_chars": chars, "file_sha256": hashes}
            files = [{"target": str(package / name), "before_sha256": file_hash(package / name), "content": content}
                     for name, content in (("coverage-ledger.json", ledger), ("source-manifest.json", encoded(manifest).decode("utf-8")))]
            if same_unit(state, request["unit_id"], {"category": "metadata", "ledger_sha256": hashes["coverage-ledger.json"], "map_hashes": {f: hashes[f] for f in MARKDOWN_FILES}}):
                return {"status": "already-committed", "revision": state["revision"]}
            save_unit(new, request["unit_id"], {"category": "metadata", "ledger_sha256": hashes["coverage-ledger.json"], "map_hashes": {f: hashes[f] for f in MARKDOWN_FILES}})
            new = transaction(work, state, new, request, files)
            return {"status": "committed", "revision": new["revision"], "prose_chars": chars}
        elif op == "seal":
            require(not state.get("sealed"), "package already sealed")
            audit_package(state)
            package = canonical(state["identity"]["package_dir"])
            require({p.name for p in package.iterdir()} == PACKAGE_FILES and all((package / p).is_file() for p in PACKAGE_FILES), "exact eight-file package required")
            manifest = json.loads((package / "source-manifest.json").read_text("utf-8"))
            require(all(manifest.get(k) == v for k, v in state["identity"].items())
                    and manifest.get("assessment_profile") == PROFILE and manifest.get("acceptance") == "PASSED_GROUNDED"
                    and manifest.get("closed_book_mastery") == "NOT_PERFORMED", "manifest identity/acceptance mismatch")
            require(json.loads((package / "coverage-ledger.json").read_text("utf-8")) == ledger_projection(state), "ledger differs from authoritative coverage/assessment")
            for name in PACKAGE_FILES - {"source-manifest.json"}:
                require(manifest.get("file_sha256", {}).get(name) == file_hash(package / name), "manifest file hash mismatch: " + name)
            new["sealed"] = {name: file_hash(package / name) for name in sorted(PACKAGE_FILES)}
            new["stage"] = "CREATE_AGENT"
        elif op == "complete":
            agent = canonical(state["identity"]["agent_path"])
            require(state.get("sealed") and agent.is_file(), "sealed package and Agent required")
            parsed = check_agent_draft(state, agent.read_text("utf-8"))
            for name in ("toml", "doctor", "parent-canary"):
                data = validation_record(state, name)
                if name == "toml":
                    require(data.get("model") == parsed["model"] and data.get("model_reasoning_effort") == parsed["model_reasoning_effort"]
                            and data.get("agent_sha256") == file_hash(agent), "TOML validation not bound to installed Agent")
                elif name == "doctor":
                    require(data.get("exit_code") == 0 and data.get("config_load") == "ok" and data.get("evidence"), "Doctor did not pass")
                else:
                    require(data.get("runtime_identity_verified") is True and data.get("agent_sha256") == file_hash(agent)
                            and data.get("evidence"), "unverified runtime identity/canary")
            for name, sha in state["sealed"].items():
                require(file_hash(canonical(state["identity"]["package_dir"]) / name) == sha, "sealed package changed")
            new["stage"] = "COMPLETE"
        else:
            raise Rejected("unknown operation: " + op)
        new = transaction(work, state, new, request)
        return {"status": "committed", "revision": new["revision"], "stage": new["stage"], "assessment_phase": new.get("assessment", {}).get("phase")}



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
    except (Rejected, KeyError, ValueError, TypeError, AttributeError, OSError, zipfile.BadZipFile, ET.ParseError, StopIteration) as exc:
        print(json.dumps({"status": "validation-failed", "error": str(exc)}, ensure_ascii=False))
        return 2


if __name__ == "__main__":
    raise SystemExit(cli())
