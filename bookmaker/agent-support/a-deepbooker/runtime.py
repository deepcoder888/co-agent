"""A-deepbooker v1: source checks, PDF copies, reading bridge and delivery gates.

Uses the immutable A-book v3 runtime. Model-authored reviews remain judgments;
the helper validates their bindings, not their truth or full-book understanding.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import hashlib
from html import escape
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent
# Public copy: the Deepbooker home folder (plugins, word/, .deepbooker-work/) comes from DEEPBOOKER_HOME.
READING = Path(os.environ.get('DEEPBOOKER_HOME') or Path.home() / 'Documents' / 'Deepbooker')
BASE = ROOT.parent / 'a-book' / 'abook_runtime_v3.py'
spec = importlib.util.spec_from_file_location('adeep_abook_v3', BASE)
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)
require, canonical, file_hash, encoded, digest = rt.require, rt.canonical, rt.file_hash, rt.encoded, rt.digest
SECTION_KINDS = {'FRONT_MATTER', 'PREFACE', 'INTRODUCTION', 'CHAPTER', 'CONCLUSION', 'APPENDIX', 'NOTES', 'OTHER'}
CLAIM_TYPES = {'FORMAL_PROOF', 'EMPIRICAL_INFERENCE', 'CONCEPTUAL_FRAMEWORK', 'HISTORICAL_INTERPRETATION', 'RHETORIC', 'VALUE_JUDGMENT'}
CHECKS = {'state', 'coverage', 'chapters', 'xros', 'analysis', 'concepts', 'transfer', 'readmes', 'word_structure', 'word_visual'}
REFERENCES = ['runtime-and-authorization.md', 'source-adapters.md', 'analysis-and-report.md', 'evidence-and-xros.md', 'transfer-applications.md']


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def verify_audit_repair(state):
    record = state.get('audit_repair')
    if not record:
        return
    require(digest(encoded(record)) == state.get('audit_repair_sha256'), 'audit repair history changed')
    require(record['extension_sha256'] == file_hash(record['extension_path']), 'audit repair extension changed; review required')
    original = record['original_questions']
    require(digest(encoded(original)) == record['original_question_hash'], 'original question history changed')
    require(digest(encoded(state['round_1'])) == record['original_assessment_sha256'], 'original assessment history changed')
    require([q['id'] for q in original] == [q['id'] for q in state['questions']], 'audit repair changed question IDs')
    additions = {i['question_id']: i['additional_evidence'] for i in record['issues']}
    for old, current in zip(original, state['questions']):
        expected = rt.copy_state(old)
        expected['evidence'] += additions.get(old['id'], [])
        require(current == expected, 'audit repair changed criteria or undeclared evidence')
    assessment = state['assessment']
    allowed_maps = {name for issue in record['issues'] for name in issue['map_files']}
    changed_maps = {name for name, sha in record['original_map_hashes'].items()
                    if file_hash(canonical(state['identity']['package_dir']) / name) != sha}
    require(changed_maps <= allowed_maps, 'audit repair changed an undeclared map')
    if assessment['phase'] != 'REPAIR':
        require(assessment['round'] == 2 and assessment['required_ids'] == record['retest_ids'], 'audit retest selection changed')
    for qid, answer in state['round_1']['answers'].items():
        if qid not in record['retest_ids']:
            require(assessment['answers'][qid] == answer and assessment['verdicts'][qid] == state['round_1']['verdicts'][qid], 'audit repair changed an unselected answer/verdict')


def begin_audit_repair(request):
    """One pre-seal map audit repair, retaining the original passing QA verbatim.

    The base runtime's failed_ids field is reused as its repair target set;
    audit_repair labels this explicitly. No historical verdict is rewritten.
    """
    work = canonical(request['work_dir'])
    require((work / 'state.json').is_file(), 'missing A-book state')
    with rt.locked(work):
        require(not (work / 'journal.json').exists(), 'recover pending base transaction first')
        state_path = work / 'state.json'
        state = read_json(state_path)
        rt.identity_check(state, work)
        payload = {k: request[k] for k in ('expected_state_sha256', 'authorization', 'issues')}
        unit_id = request['unit_id']
        if rt.same_unit(state, unit_id, {'category': 'post_pass_map_audit', 'data': payload}):
            verify_audit_repair(state)
            return {'status': 'ALREADY_COMMITTED', 'revision': state['revision'], 'retest_ids': state['audit_repair']['retest_ids']}
        require(file_hash(state_path) == request['expected_state_sha256'], 'audit repair state hash mismatch')
        require(request.get('expected_revision') == state['revision'], 'stale audit repair revision')
        require(isinstance(request['authorization'], str) and request['authorization'].strip(), 'repair authorization basis required')
        a = state['assessment']
        require(state['stage'] == 'GROUNDED_QA' and a.get('phase') == 'PASSED_GROUNDED' and a.get('round') == 1
                and not state.get('round_1') and not state.get('audit_repair') and not state.get('sealed')
                and not canonical(state['identity']['agent_path']).exists(), 'one pre-seal audit repair only')
        require('package-audit' not in state['units'], 'package audit already recorded; this recovery is pre-audit only')
        issues = request['issues']
        require(isinstance(issues, list) and 1 <= len(issues) <= 20, 'nonempty bounded audit issues required')
        questions = {q['id']: q for q in state['questions']}
        affected = []
        for issue in issues:
            require(isinstance(issue, dict) and set(issue) == {'question_id', 'reason', 'map_files', 'additional_evidence'}, 'audit issue schema')
            qid = issue['question_id']
            require(qid in questions and qid not in affected, 'unknown or duplicate audit question')
            require(isinstance(issue['reason'], str) and 0 < len(issue['reason'].strip()) <= 2000, 'audit finding reason required')
            maps = issue['map_files']
            require(isinstance(maps, list) and maps and len(maps) == len(set(maps)) and set(maps) <= set(questions[qid]['affected_maps']), 'audit maps outside frozen scope')
            extra = issue['additional_evidence']
            require(isinstance(extra, list) and len(questions[qid]['evidence']) + len(extra) <= 4, 'at most four total source windows')
            windows = questions[qid]['evidence'] + extra
            require(len({digest(encoded(e)) for e in windows}) == len(windows), 'duplicate audit source window')
            for window in windows:
                require(isinstance(window, dict) and set(window) == {'section_id', 'locator'}, 'audit evidence schema')
                rt.evidence_window(state, window)
            affected.append(qid)
        sampled = sorted((k for k, v in a['verdicts'].items() if v['correct'] and k not in affected),
                         key=lambda k: digest((state['question_hash'] + k).encode('utf-8')))[:3]
        selected = sorted(set(affected + sampled))
        new = rt.copy_state(state)
        new['round_1'] = rt.copy_state(a)
        new['round_1_sha256'] = digest(encoded(a))
        new['audit_repair'] = {'trigger': 'POST_PASS_MAP_AUDIT', 'issues': rt.copy_state(issues),
            'authorization': request['authorization'], 'original_state_sha256': request['expected_state_sha256'],
            'original_questions': rt.copy_state(state['questions']), 'original_question_hash': state['question_hash'],
            'original_map_hashes': dict(state['evidence_hashes']),
            'original_assessment_sha256': new['round_1_sha256'], 'retest_ids': selected,
            'extension_path': str(Path(__file__).resolve()), 'extension_sha256': file_hash(__file__),
            'compatibility_note': 'During REPAIR only, failed_ids means audit-affected questions; original passing verdicts are retained unchanged in round_1.'}
        new['audit_repair_sha256'] = digest(encoded(new['audit_repair']))
        for q in new['questions']:
            for issue in issues:
                if q['id'] == issue['question_id']:
                    q['evidence'] += rt.copy_state(issue['additional_evidence'])
        new['question_hash'] = digest(encoded(new['questions']))
        new['assessment']['phase'] = 'REPAIR'
        new['assessment']['failed_ids'] = sorted(affected)
        new['assessment']['retest_ids'] = selected
        new['repair_map_hashes'] = {f: file_hash(canonical(state['identity']['package_dir']) / f) for f in rt.MARKDOWN_FILES}
        rt.save_unit(new, unit_id, {'category': 'post_pass_map_audit', 'data': payload})
        rt.transaction(work, state, new, request)
        return {'status': 'REPAIR_STARTED', 'revision': new['revision'], 'audit_affected_ids': sorted(affected),
                'retest_ids': selected, 'original_qa_preserved': True, 'next': 'Use base commit_files, repair-complete, start_retest, answers, verification and decide. No third round.'}


def bound(path):
    path = canonical(path)
    require(path.is_file(), 'missing file: ' + str(path))
    return {'path': str(path), 'sha256': file_hash(path)}


def verify_bound(item):
    require(isinstance(item, dict) and item.get('sha256') and file_hash(item['path']) == item['sha256'], 'file missing or changed: ' + str(item.get('path')))


def dependencies(project_root=None, enforce=True):
    project = canonical(project_root or READING)
    candidates = [project / 'plugins/deepbooker/skills/deepbooker', READING / 'plugins/deepbooker/skills/deepbooker']
    cache = ROOT.parents[1] / 'plugins/cache/reading/deepbooker'
    if cache.is_dir():
        candidates += sorted(cache.glob('*/skills/deepbooker'), reverse=True)
    plugin = next((p for p in candidates if (p / 'SKILL.md').is_file()), None)
    require(plugin is not None, 'installed Deepbooker not found')
    files = {'abook_runtime': BASE, 'abook_protocol': BASE.with_name('protocol-v3.md'),
             'abook_agent': ROOT.parents[1] / 'agents/a-book.toml', 'deepbooker': plugin / 'SKILL.md',
             'state_validator': READING / '.deepbooker-work/validate-reading-state.ps1'}
    files.update({name: plugin / 'references' / name for name in REFERENCES})
    result = {key: bound(path) for key, path in files.items()}
    if enforce:
        lock = read_json(ROOT / 'dependencies.json')
        for key, value in result.items():
            require(key in lock and lock[key]['sha256'] == value['sha256'], 'dependency drift requires review: ' + key)
    return {'status': 'READY', 'files': result, 'python': sys.executable,
            'pdf_python': str(READING / '.deepbooker-work/documents-runtime/Scripts/python.exe')}


def container(source):
    path = canonical(source)
    require(path.is_file(), 'source missing')
    suffix = path.suffix.lower()
    require(suffix in {'.epub', '.pdf', '.docx', '.txt', '.md', '.html', '.htm'}, 'unsupported source format: ' + suffix)
    with path.open('rb') as stream:
        head = stream.read(1024)
    if suffix == '.pdf':
        require(b'%PDF-' in head, 'PDF extension/container mismatch')
    elif suffix in {'.epub', '.docx'}:
        require(zipfile.is_zipfile(path), 'ZIP extension/container mismatch')
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            require(len(names) == len(set(names)), 'duplicate ZIP entries')
            require(not any(i.flag_bits & 1 for i in z.infolist()), 'encrypted ZIP')
            require(('META-INF/container.xml' if suffix == '.epub' else 'word/document.xml') in names, 'wrong ZIP container type')
    else:
        require(not head.startswith((b'PK\x03\x04', b'%PDF-')), 'text extension/container mismatch')
        path.read_text(encoding='utf-8-sig', errors='strict')
    return path, suffix


def pdf_pages(path):
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise rt.Rejected('PDF requires pypdf; use the preflight-selected existing Python') from exc
    reader = PdfReader(path)
    require(not reader.is_encrypted, 'encrypted PDF: provide an authorized readable copy')
    require(len(reader.pages) > 0, 'empty PDF')
    return [(i, p.extract_text() or '') for i, p in enumerate(reader.pages, 1)]


def inspect_source(source):
    path, suffix = container(source)
    result = {'source': bound(path), 'format': suffix[1:], 'status': 'READY_FOR_REVIEW', 'review_items': [], 'reading_performed': False}
    if suffix == '.pdf':
        pages = pdf_pages(path)
        empty = [i for i, text in pages if not text.strip()]
        result.update(page_count=len(pages), textless_pages=empty)
        result['review_items'] = [{'locator': 'page:' + str(i), 'check': 'text, figures, tables and extraction completeness'} for i, _ in pages]
        if empty:
            result['status'] = 'SOURCE_REVIEW_REQUIRED'
            result['next_action'] = 'Render textless pages, obtain reviewed transcriptions or blank classifications, then prepare_pdf.'
            return result
    book = rt.open_source(path)
    result['entries'] = [{'entry': e, 'characters': len(book.text(e))} for e in book.linear]
    result['navigation_targets'] = book.navigation_targets
    require(any(e['characters'] for e in result['entries']), 'no readable source text')
    if suffix in {'.epub', '.docx'}:
        with zipfile.ZipFile(path) as z:
            images = [n for n in z.namelist() if Path(n).suffix.lower() in {'.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.emf', '.wmf'}]
            result['review_items'] += [{'locator': n, 'check': 'classify decorative versus argument-bearing; inspect latter'} for n in images]
            if suffix == '.docx':
                extras = [n for n in z.namelist() if n.startswith(('word/header', 'word/footer', 'word/comments', 'word/embeddings/'))]
                result['review_items'] += [{'locator': n, 'check': 'inspect part; source copy required if substantive content is absent from native extraction'} for n in extras]
    if suffix in {'.html', '.htm', '.md'}:
        result['review_items'].append({'locator': str(path), 'check': 'linked chapter completeness, images, math and notes'})
    return result


def prepare_pdf(request):
    path, suffix = container(request['source'])
    require(suffix == '.pdf', 'prepare_pdf requires PDF')
    pages = pdf_pages(path)
    overrides = request.get('page_overrides', {})
    require(isinstance(overrides, dict) and set(overrides) <= {str(i) for i, _ in pages}, 'unknown PDF override page')
    converted, mapping = [], []
    for number, original_text in pages:
        entry = f'page-{number:06}.xhtml'
        override = overrides.get(str(number))
        text, method, evidence = original_text, 'pypdf-extraction', ''
        if override is not None:
            require(override.get('kind') in {'blank', 'transcription'} and isinstance(override.get('evidence'), str) and override['evidence'].strip(), 'reviewed PDF override needs kind and evidence')
            require(isinstance(override.get('text'), str), 'override text must be a string')
            method, evidence = override['kind'], override['evidence']
            if method == 'blank':
                require(not override['text'].strip() and not original_text.strip(), 'blank override cannot remove extracted or transcribed content')
                text = f'[Visually confirmed blank original PDF page {number}]'
            else:
                text = override['text']
                require(text.strip(), 'empty transcription')
        require(text.strip(), f'page {number} has no text: reviewed transcription or blank override required')
        converted.append((entry, '<html xmlns="http://www.w3.org/1999/xhtml"><body><p>' + escape(text) + '</p></body></html>'))
        mapping.append({'entry': entry, 'original_page': number, 'method': method, 'evidence': evidence, 'text_sha256': digest(text.encode('utf-8'))})
    output = canonical(request['output_dir'])
    require(not output.exists() and not rt.within(path, output), 'PDF copy target exists or overlaps original')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.adeep-pdf-', dir=output.parent) as temp:
        temporary = Path(temp)
        copy = temporary / 'reading-copy.epub'
        with zipfile.ZipFile(copy, 'w') as z:
            z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
            z.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
            manifest = ''.join(f'<item id="p{i}" href="{name}" media-type="application/xhtml+xml"/>' for i, (name, _) in enumerate(converted))
            spine = ''.join(f'<itemref idref="p{i}"/>' for i in range(len(converted)))
            z.writestr('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">' + file_hash(path) + '</dc:identifier><dc:title>' + escape(path.stem) + '</dc:title><dc:language>und</dc:language></metadata><manifest>' + manifest + '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/></manifest><spine>' + spine + '</spine></package>')
            nav = ''.join(f'<li><a href="{name}">Original PDF page {i}</a></li>' for i, (name, _) in enumerate(converted, 1))
            z.writestr('nav.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>' + nav + '</ol></nav></body></html>')
            for name, content in converted:
                z.writestr(name, content)
        provenance = {'schema_version': 1, 'original': bound(path), 'reading_source': {'path': str(output / copy.name), 'sha256': file_hash(copy)}, 'page_count': len(pages), 'pages': mapping}
        rt.atomic(temporary / 'source-provenance.json', encoded(provenance))
        rt.open_source(copy)
        output.mkdir()
        for name in ('reading-copy.epub', 'source-provenance.json'):
            os.replace(temporary / name, output / name)
    return {'status': 'PREPARED', 'reading_source': provenance['reading_source'], 'provenance': bound(output / 'source-provenance.json'), 'page_count': len(pages), 'requires_source_review': True}


def verify_reading(work):
    work = canonical(work)
    require(not (work / 'journal.json').exists(), 'pending A-book transaction; recover through its runtime')
    state_file = work / 'state.json'
    before = file_hash(state_file)
    state = read_json(state_file)
    rt.identity_check(state, work)
    verify_audit_repair(state)
    require(state.get('sealed') and state['assessment'].get('phase') == 'PASSED_GROUNDED', 'sealed passing A-book v3 package required')
    require(set(state['sealed']) == rt.PACKAGE_FILES, 'eight sealed files required')
    book = rt.open_source(state['identity']['source'])
    for sid in state['reading_order']:
        section = state['reading'][sid]
        require(section['status'] in {'READ', 'EXCLUDED'}, 'reading incomplete: ' + sid)
        text, _ = book.section(section['entries'])
        require(digest(text.encode('utf-8')) == section['sha256'], 'section text hash changed: ' + sid)
        for checkpoint in section['checkpoints']:
            loc = checkpoint['locator']
            actual = rt.envelope(book, loc['entries'], loc['start'], loc['end'])
            require(all(actual[k] == checkpoint[k] for k in ('receipt', 'text_sha256', 'locator')), 'invalid source receipt: ' + sid)
    require(before == file_hash(state_file), 'A-book state changed during read; retry after writer commits')
    return state


def validate_seed(state_path, project_root, validator):
    shell = shutil.which('pwsh') or shutil.which('powershell')
    require(shell is not None, 'PowerShell state validator unavailable')
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    run = subprocess.run([shell, '-NoProfile', '-File', str(validator), '-StatePath', str(state_path), '-ProjectRoot', str(project_root)], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=60, creationflags=flags)
    require(run.returncode == 0, 'Deepbooker state validation failed: ' + (run.stdout + run.stderr)[-4000:])
    return {'exit_code': run.returncode, 'output': run.stdout.strip()}


def bridge(request):
    deps = dependencies(request['project_root'])['files']
    state = verify_reading(request['abook_work'])
    project, report, combo, word = (canonical(request[k]) for k in ('project_root', 'report_dir', 'combination_work', 'word_path'))
    require(project.is_dir() and report != project and combo != project and rt.within(report, project) and rt.within(combo, project), 'report/work must be project-contained child paths')
    require(not rt.within(report, combo) and not rt.within(combo, report), 'report/work overlap')
    require(rt.within(word, READING / 'word') and word.suffix.lower() == '.docx', 'Word path outside declared output root')
    for other in (canonical(state['identity']['package_dir']), canonical(state['identity']['work_dir'])):
        require(not any(rt.within(p, other) or rt.within(other, p) for p in (report, combo)), 'combination paths overlap A-book targets')
    metadata = request['book']
    require(all(isinstance(metadata.get(k), str) and metadata[k].strip() for k in ('title', 'author', 'edition', 'language')), 'book identity incomplete')
    require(metadata['edition'] == state['identity']['edition'], 'edition differs from A-book')
    require(metadata.get('publication_year') is None or type(metadata['publication_year']) is int, 'invalid publication year')
    date.fromisoformat(request['research_cutoff']['date'])
    require(request['research_cutoff'].get('timezone'), 'research timezone missing')
    source = bound(state['identity']['source'])
    original, provenance = source, None
    if request.get('provenance'):
        provenance = bound(request['provenance'])
        origin = read_json(provenance['path'])
        require(origin['reading_source'] == source, 'reading copy provenance mismatch')
        verify_bound(origin['original'])
        original = origin['original']
    review_record = bound(request['source_review'])
    review = read_json(review_record['path'])
    require(review.get('source_sha256') == source['sha256'] and review.get('original_sha256') == original['sha256'], 'source review fingerprint mismatch')
    require(all(review.get(k) is True for k in ('inventory_reconciled', 'figures_and_tables_checked', 'notes_checked', 'exclusions_checked')), 'source review incomplete')
    require(review.get('unresolved_gaps') == [] and isinstance(review.get('evidence'), list) and review['evidence'], 'source review has gaps or missing evidence')
    require(all(isinstance(e, dict) and e.get('locator') and e.get('finding') for e in review['evidence']), 'source review evidence schema')
    mappings = request['sections']
    require([m['section_id'] for m in mappings] == state['reading_order'], 'section order/coverage mismatch')
    timestamp = state['started_at']
    sections, claims, evidence, ids = [], [], [], set()
    for m in mappings:
        sid = m['section_id']; s = state['reading'][sid]
        require(m['section_kind'] in SECTION_KINDS, 'invalid section kind')
        core = m.get('core_claims', [])
        require(isinstance(core, list), 'core_claims must be a list')
        require(s['substantive'] or not core, 'excluded material cannot become core claims')
        require(not (s['substantive'] and m['section_kind'] == 'CHAPTER') or core, 'READ chapter requires source-grounded core claims: ' + sid)
        locator = '; '.join(s['entries'])
        if provenance:
            page_map = {p['entry']: p['original_page'] for p in origin['pages']}
            locator += '; original PDF pages: ' + ', '.join(str(page_map[e]) for e in s['entries'] if e in page_map)
        claim_ids = []
        for claim in core:
            cid = claim['claim_id']
            require(isinstance(cid, str) and cid.strip() and cid not in ids, 'duplicate/invalid claim id')
            require(isinstance(claim.get('normalized_claim'), str) and claim['normalized_claim'].strip(), 'empty core proposition')
            require(claim['claim_type'] in CLAIM_TYPES and type(claim['material']) is bool, 'invalid claim type/material')
            ids.add(cid); claim_ids.append(cid)
            claims.append({**claim, 'book_locators': [locator], 'core_for_section_ids': [sid] if m['section_kind'] == 'CHAPTER' else [], 'workflow_status': 'IDENTIFIED', 'claim_status': None, 'source_ids': ['BOOK'], 'xros_id': None, 'ceiling': None, 'limitations': None, 'updated_at': timestamp})
        notes = [c['evidence'] for c in s['checkpoints']]
        sections.append({'section_id': sid, 'title': s['title'], 'locator': locator, 'section_kind': m['section_kind'], 'status': s['status'], 'reason': s['reason'] or None, 'notes': json.dumps(notes, ensure_ascii=False), 'claim_ids': claim_ids, 'core_claim_ids': claim_ids if m['section_kind'] == 'CHAPTER' else [], 'updated_at': timestamp})
        evidence.append({'section_id': sid, 'substantive': s['substantive'], 'exclusions': s['exclusions'], 'checkpoints': [{k: c[k] for k in ('locator', 'receipt', 'text_sha256')} for c in s['checkpoints']]})
    report_state = {'schema_version': '1.0.0', 'run_id': state['run_id'], 'run_status': 'IN_PROGRESS', 'book': metadata,
                    'source': {'kind': 'LOCAL_FILE', 'canonical_locator': original['path'], 'sha256': original['sha256'], 'final_url': None, 'etag': None, 'last_modified': None},
                    'research_cutoff': request['research_cutoff'], 'sources': [{'source_id': 'BOOK', 'source_type': 'BOOK', 'citation': ', '.join(metadata[k] for k in ('title', 'author', 'edition')), 'locator_or_url': original['path'], 'accessed_at': timestamp, 'content_sha256': original['sha256'], 'private': True}],
                    'sections': sections, 'claims': claims, 'xros': [], 'transfer': {'mode': 'CENTRAL', 'status': 'PENDING', 'assumption_label': 'ASSUMPTION_FOR_TRANSFER', 'selected_viewpoint_ids': [], 'applications': [], 'top_five_ids': [], 'limitations': []}, 'updated_at': timestamp}
    if provenance:
        report_state['sources'].append({'source_id': 'READING_COPY', 'source_type': 'BOOK', 'citation': 'Reviewed reading copy; consult original for exact wording', 'locator_or_url': source['path'], 'accessed_at': timestamp, 'content_sha256': source['sha256'], 'private': True})
    request_hash = digest(encoded(request))
    combo_file = combo / 'combination.json'
    if combo_file.exists():
        existing = read_json(combo_file)
        require(existing['request_sha256'] == request_hash, 'existing combination binding conflict')
        for item in (existing['source'], existing['original'], existing['source_review'], existing['bridge_evidence']):
            verify_bound(item)
        require(read_json(existing['state_path'])['source']['sha256'] == original['sha256'], 'resumed report source changed')
        return {'status': 'RESUMED', 'combination': str(combo_file), 'report_state': existing['state_path']}
    paths = {'book_report': str(report / 'eat-the-book/README.md'), 'transfer_report': str(report / 'chapter-transfer/README.md'), 'word': str(word)}
    require(not any(Path(p).exists() for p in paths.values()), 'existing report artifact: choose collision-safe outputs')
    target = report / 'reading-state.json'
    seed_bytes = encoded(report_state)
    require(not target.exists() or target.read_bytes() == seed_bytes, 'existing state has different provenance or progress')
    bridge_data = {'schema_version': 1, 'abook_run_id': state['run_id'], 'reading_source': source, 'original': original, 'provenance': provenance, 'reading': evidence, 'source_review': review_record, 'reading_imported_only': True}
    evidence_path = combo / 'bridge-evidence.json'
    require(not evidence_path.exists() or evidence_path.read_bytes() == encoded(bridge_data), 'existing bridge evidence differs')
    # Validate a unique temporary candidate before publishing the canonical state.
    report.mkdir(parents=True, exist_ok=True)
    probe = report / ('.reading-state-' + uuid.uuid4().hex + '.json')
    try:
        rt.atomic(probe, seed_bytes)
        validation = validate_seed(probe, project, deps['state_validator']['path'])
    finally:
        probe.unlink(missing_ok=True)
    if not target.exists():
        rt.atomic(target, seed_bytes)
    rt.atomic(evidence_path, encoded(bridge_data))
    record = {'schema_version': 1, 'request_sha256': request_hash, 'abook_work': str(canonical(request['abook_work'])), 'abook_run_id': state['run_id'], 'test_fixture': state.get('test_fixture', False), 'project_root': str(project), 'state_path': str(target), 'source': source, 'original': original, 'provenance': provenance, 'source_review': review_record, 'bridge_evidence': bound(evidence_path), 'artifacts': paths, 'dependencies': deps, 'created_at': timestamp}
    rt.atomic(combo_file, encoded(record))
    return {'status': 'IMPORTED_READING_ONLY', 'combination': str(combo_file), 'report_state': str(target), 'sections': len(sections), 'claims': len(claims), 'validation': validation}


def check(request):
    combo = read_json(request['combination'])
    dependencies(combo['project_root'])
    for item in list(combo['dependencies'].values()) + [combo[k] for k in ('source', 'original', 'source_review', 'bridge_evidence')]:
        verify_bound(item)
    if combo.get('provenance'):
        verify_bound(combo['provenance'])
    state = verify_reading(combo['abook_work'])
    require(state['run_id'] == combo['abook_run_id'] and state['identity']['source_sha256'] == combo['source']['sha256'], 'A-book run identity changed')
    report = read_json(combo['state_path'])
    require(report['run_id'] == state['run_id'] and report['source']['sha256'] == combo['original']['sha256'], 'report identity changed')
    validate_seed(combo['state_path'], combo['project_root'], combo['dependencies']['state_validator']['path'])
    require([s['section_id'] for s in report['sections']] == state['reading_order'], 'report coverage changed')
    for section in report['sections']:
        require(section['status'] == state['reading'][section['section_id']]['status'], 'report section coverage differs from reading')
    pending = []
    if state.get('test_fixture') or combo.get('test_fixture'):
        pending.append('TEST_FIXTURE_NOT_REAL_BOOK')
    if state['stage'] != 'COMPLETE':
        pending.append('A_BOOK_' + state['stage'])
    else:
        for gate in ('nlpm', 'toml', 'doctor', 'parent-canary'):
            rt.validation_record(state, gate)
        agent_hash = file_hash(state['identity']['agent_path'])
        require(agent_hash and rt.validation_record(state, 'parent-canary').get('agent_sha256') == agent_hash, 'Agent/canary hash changed')
    if report['run_status'] != 'COMPLETE':
        pending.append('DEEPBOOKER_' + report['run_status'])
    if not report['claims'] or any(c['workflow_status'] != 'FINALIZED' for c in report['claims']):
        pending.append('CLAIMS_UNFINISHED')
    xros = {x['xros_id']: x for x in report['xros']}
    for claim in report['claims']:
        if claim['workflow_status'] != 'FINALIZED':
            continue
        needed = claim.get('material') or claim.get('core_for_section_ids')
        if needed and claim.get('claim_status') != 'NON_FALSIFIABLE_OR_INTERPRETIVE':
            route = xros.get(claim.get('xros_id'))
            if not route or route.get('claim_id') != claim['claim_id'] or route.get('route') not in {'RUN', 'REASON'} or route.get('spec_validation') in {'PENDING', 'INVALID', 'BLOCKED'}:
                pending.append('XROS_UNFINISHED_' + claim['claim_id'])
            elif claim['claim_status'] == 'VERIFIED' and not (route.get('soundness') == 'sound' and route.get('pass_condition_result') == 'PASS' and route.get('exit_code') == 0):
                pending.append('XROS_VERIFIED_WITHOUT_ORACLE_' + claim['claim_id'])
    if report['transfer']['status'] != 'COMPLETE' or len(set(report['transfer']['top_five_ids'])) != 5:
        pending.append('TRANSFER_UNFINISHED')
    if not request.get('validation') or not Path(request['validation']).is_file():
        pending.append('REPORT_VALIDATION_MISSING')
    else:
        validation = read_json(request['validation'])
        require(validation['source_sha256'] == combo['original']['sha256'] and validation['state_sha256'] == file_hash(combo['state_path']), 'report validation fingerprint changed')
        for key in CHECKS:
            if validation.get('checks', {}).get(key) is not True:
                pending.append('CHECK_' + key.upper())
        for key, path in combo['artifacts'].items():
            actual = file_hash(path)
            require(actual and validation.get('artifacts', {}).get(key) == actual, 'missing/changed artifact: ' + key)
        require(validation.get('evidence'), 'missing validation evidence')
        for item in validation['evidence']:
            require(rt.within(canonical(item['path']), canonical(combo['project_root'])), 'validation evidence outside project')
            verify_bound(item)
        render = validation.get('render', {})
        if render.get('exit_code') != 0 or type(render.get('pages')) is not int or render['pages'] <= 0 or render.get('inspected_pages') != render['pages']:
            pending.append('WORD_PAGE_QA_INCOMPLETE')
        with zipfile.ZipFile(combo['artifacts']['word']) as z:
            ET.fromstring(z.read('word/document.xml'))
    return {'status': 'PARTIAL' if pending else 'COMPLETE', 'pending_gates': pending, 'agent_stage': state['stage'], 'report_stage': report['run_status'], 'book_reading_performed_by_this_check': False}


def main_request(request):
    op = request['op']
    if op == 'dependencies':
        return dependencies(request.get('project_root'))
    if op == 'inspect':
        return inspect_source(request['source'])
    if op == 'prepare_pdf':
        return prepare_pdf(request)
    if op == 'begin_audit_repair':
        return begin_audit_repair(request)
    if op == 'audit_repair_status':
        work = canonical(request['work_dir'])
        with rt.locked(work):
            require(not (work / 'journal.json').exists(), 'recover pending base transaction first')
            state = read_json(work / 'state.json')
            rt.identity_check(state, work)
            require(state.get('audit_repair'), 'no audit repair recorded')
            verify_audit_repair(state)
            return {'status': 'VALID', 'assessment': rt.summary(state)['assessment'], 'retest_ids': state['audit_repair']['retest_ids']}
    if op == 'bridge':
        return bridge(request)
    if op == 'check':
        return check(request)
    raise rt.Rejected('unknown operation: ' + str(op))


def cli():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    args = parser.parse_args()
    try:
        request = json.load(sys.stdin) if args.request == '-' else read_json(args.request)
        print(json.dumps(main_request(request), ensure_ascii=False))
    except (ValueError, KeyError, TypeError, OSError, zipfile.BadZipFile, ET.ParseError, subprocess.SubprocessError) as exc:
        print(json.dumps({'status': 'BLOCKED', 'error': str(exc)}, ensure_ascii=False))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(cli())
