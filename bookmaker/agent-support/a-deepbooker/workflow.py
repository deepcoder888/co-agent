"""A-deepbooker deterministic handoff, render delta, progress and delivery helpers.

This companion never modifies the legacy runtimes or certifies book understanding.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


SUPPORT = Path.home() / '.codex/agent-support/a-deepbooker'
# Public copy: the folder that receives the finished Word copy comes from DEEPBOOKER_READY_DIR.
READY = Path(os.environ.get('DEEPBOOKER_READY_DIR') or Path.home() / 'Documents' / 'READY TO READ')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def path(value):
    result = Path(value)
    require(result.is_absolute(), f'Absolute path required: {value}')
    return result.resolve()


def read(value):
    return json.loads(path(value).read_text(encoding='utf-8-sig'))


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def digest_json(value):
    return digest_bytes(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                  separators=(',', ':')).encode('utf-8'))


def sha(value):
    with path(value).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def bound(value):
    return {'path': str(path(value)), 'sha256': sha(value)}


def verify(item):
    require(sha(item['path']) == item['sha256'], f'Changed file: {item["path"]}')


def save_new(value, data):
    target = path(value)
    with target.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def core(request):
    spec = importlib.util.spec_from_file_location('a_deepbooker_legacy', SUPPORT / 'runtime.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.main_request(request)


def access(request):
    files = [bound(item) for item in request.get('reads', [])]
    directories = []
    for value in request.get('write_dirs', []):
        directory = path(value)
        directory.mkdir(parents=True, exist_ok=True)
        sentinel = directory / ('.a-deepbooker-probe-' + uuid.uuid4().hex)
        with sentinel.open('xb') as probe:
            try:
                probe.write(b'access-probe')
                probe.flush()
                os.fsync(probe.fileno())
            finally:
                probe.close()
                sentinel.unlink()
        directories.append(str(directory))
    require(files or directories, 'Access probe needs at least one input')
    result = {'status': 'ACCESS_PASSED', 'files': files, 'write_dirs': directories,
              'runtime_identity': 'VERIFY_FROM_HOST_METADATA'}
    if request.get('expect_readonly_dir'):
        directory = path(request['expect_readonly_dir'])
        require(directory.is_dir(), 'Read-only sentinel needs an existing directory')
        sentinel = directory / ('.readonly-canary-' + uuid.uuid4().hex)
        try:
            # tempfile retries PermissionError on Windows for up to TMP_MAX names.
            # One exclusive create gives an immediate, bounded denial test.
            with sentinel.open('xb'):
                pass
        except PermissionError:
            result['write_denied'] = True
        else:
            sentinel.unlink()
            raise ValueError('Read-only sentinel could write; effective sandbox not proven')
    return result


def sandbox_access(request):
    root = path(request['project_root'])
    probe = path(request['probe_dir'])
    require(probe.is_relative_to(root), 'Sandbox probe directory must be in the declared project')
    # Demonstrate this is writable to the host, then denied to the restricted child.
    host = access({'reads': request['reads'], 'write_dirs': [str(probe)]})
    child_request = {'op': 'access', 'reads': request['reads'], 'write_dirs': [],
                     'expect_readonly_dir': str(probe)}
    # Codex sandbox does not forward stdin; pass a host-written request file.
    request_file = str(probe / ('access-' + uuid.uuid4().hex + '.json'))
    with Path(request_file).open('x', encoding='utf-8') as stream:
        json.dump(child_request, stream, ensure_ascii=False)
    codex = path(request.get('codex') or shutil.which('codex') or '')
    command = [str(codex), 'sandbox', '-P', 'a-deepbooker-probe',
               '-c', 'permissions.a-deepbooker-probe.filesystem={":root"="read"}',
               '-c', 'permissions.a-deepbooker-probe.network.enabled=false',
               '-C', str(root), '--', sys.executable, '-X', 'utf8', '-B', str(Path(__file__).resolve()),
               '--request', request_file]
    # Disk captures prevent a timed-out launcher descendant from holding a PIPE open.
    with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0, timeout=90)
        stdout.seek(0)
        stderr.seek(0)
        output = stdout.read().decode('utf-8', errors='replace')
        errors = stderr.read().decode('utf-8', errors='replace')
    require(result.returncode == 0, f'Sandbox access failed: {output[-1500:]} {errors[-1500:]}')
    child = json.loads(output.strip().splitlines()[-1])
    require(child.get('write_denied') is True and child['files'] == host['files'],
            'Sandbox evidence differs from host bindings')
    return {'status': 'SANDBOX_ACCESS_PASSED', 'host': host, 'restricted_child': child,
            'exit_code': result.returncode, 'command': command, 'codex': bound(codex),
            'request': bound(request_file),
            'identity_scope': 'Real restricted-token execution; no model or named-Agent invocation',
            'stderr': errors}


def select(document, pointer):
    require(pointer == '' or pointer.startswith('/'), 'Invalid JSON Pointer')
    value = document
    for part in pointer.split('/')[1:] if pointer else []:
        part = part.replace('~1', '/').replace('~0', '~')
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def bundle(request):
    files = {key: bound(value) for key, value in request.get('files', {}).items()}
    selections = []
    ids = set(files)
    for item in request.get('selections', []):
        require(item['id'] not in ids, 'Duplicate handoff ID')
        ids.add(item['id'])
        data = path(item['path']).read_bytes()
        value = select(json.loads(data.decode('utf-8-sig')), item['pointer'])
        selections.append({'id': item['id'], 'source': {
            'path': str(path(item['path'])), 'sha256': digest_bytes(data)},
            'pointer': item['pointer'], 'value': value, 'value_sha256': digest_json(value)})
    require(files or selections, 'Empty handoff')
    return {'schema': 'a-deepbooker-bundle-v2', 'status': 'BOUND',
            'files': files, 'selections': selections}


def verify_bundle(request):
    data = read(request['bundle'])
    require(data['schema'] == 'a-deepbooker-bundle-v2', 'Wrong bundle schema')
    for item in data['files'].values():
        verify(item)
    for item in data['selections']:
        verify(item['source'])
        value = select(read(item['source']['path']), item['pointer'])
        require(value == item['value'] and digest_json(value) == item['value_sha256'],
                'Receipt selection changed')
    return {'status': 'VERIFIED', 'bundle': bound(request['bundle']),
            'file_count': len(data['files']), 'selection_count': len(data['selections'])}


def pixels(value):
    from PIL import Image
    with Image.open(path(value)) as image:
        rgba = image.convert('RGBA')
        width, height = rgba.size
        raw = f'{width}:{height}:RGBA:'.encode('ascii') + rgba.tobytes()
    return {'width': width, 'height': height, 'pixel_sha256': digest_bytes(raw)}


def word_executable(request):
    if request.get('word_exe'):
        return path(request['word_exe'])
    import winreg
    key_name = r'SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\WINWORD.EXE'
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(hive, key_name) as key:
                return path(winreg.QueryValue(key, None).strip('"'))
        except FileNotFoundError:
            pass
    raise FileNotFoundError('Word executable not registered; select an installed renderer')


def environment(request, renderer, pwsh):
    import fitz
    from PIL import __version__ as pillow_version
    font_dirs = [Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts']
    if os.environ.get('LOCALAPPDATA'):
        font_dirs.append(Path(os.environ['LOCALAPPDATA']) / 'Microsoft/Windows/Fonts')
    font_files = sorted({item.resolve() for directory in font_dirs if directory.exists()
                         for item in directory.rglob('*') if item.is_file()}, key=str)
    return {'renderer': bound(renderer), 'word': bound(word_executable(request)),
            'pwsh': bound(pwsh), 'python': bound(sys.executable), 'platform': platform.platform(),
            'pymupdf': fitz.VersionBind, 'pillow': pillow_version,
            'font_set_sha256': digest_json([bound(item) for item in font_files]),
            'dpi': request.get('dpi', 110), 'colorspace': 'RGB', 'alpha': False}


def render(request):
    import fitz
    docx = path(request['docx'])
    root = path(request['project_root'])
    renderer = path(request.get('renderer', str(root / '.deepbooker-work/render-docx-with-word.ps1')))
    pwsh = path(request.get('pwsh') or shutil.which('pwsh') or '')
    dpi = request.get('dpi', 110)
    require(type(dpi) is int and 72 <= dpi <= 300, 'DPI must be 72..300')
    output = path(request['output_dir'])
    require(not output.exists(), 'Use a new render directory; preserve previous page evidence')
    source = bound(docx)
    env = environment(request, renderer, pwsh)
    output.mkdir(parents=True)
    pdf = output / 'report.pdf'
    command = [str(pwsh), '-NoLogo', '-NoProfile', '-File', str(renderer),
               '-Docx', str(docx), '-Pdf', str(pdf)]
    started = time.monotonic()
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    with (output / 'render.stdout.txt').open('wb') as stdout, (output / 'render.stderr.txt').open('wb') as stderr:
        process = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=stdout,
                                 stderr=stderr, creationflags=flags, timeout=180)
    run = {'exit_code': process.returncode, 'seconds': round(time.monotonic() - started, 3),
           'create_no_window': os.name == 'nt', 'argv': command}
    save_new(output / 'process.json', run)
    require(process.returncode == 0, f'Render failed; inspect logs in {output}')
    verify(source)
    pages = []
    with fitz.open(pdf) as document:
        require(len(document) > 0 and not document.is_encrypted, 'Empty/encrypted render')
        for index, page in enumerate(document, 1):
            target = output / f'page-{index:04d}.png'
            page.get_pixmap(dpi=dpi, colorspace=fitz.csRGB, alpha=False).save(target)
            pages.append({'page': index, **bound(target), **pixels(target)})
    manifest = {'schema': 'a-deepbooker-render-v2', 'status': 'RENDERED_PENDING_REVIEW',
                'docx': source, 'pdf': bound(pdf), 'environment': env,
                'renderer_fingerprint': digest_json(env), 'process': run, 'pages': pages}
    save_new(output / 'render-manifest.json', manifest)
    return {'status': manifest['status'], 'manifest': str(output / 'render-manifest.json'),
            'pages': len(pages), 'exit_code': 0}


def load_manifest(value):
    data = read(value)
    require(data['schema'] == 'a-deepbooker-render-v2' and data['process']['exit_code'] == 0,
            'Invalid or failed render manifest')
    require(digest_json(data['environment']) == data['renderer_fingerprint'], 'Renderer binding changed')
    verify(data['docx'])
    verify(data['pdf'])
    require(data['pages'] and [p['page'] for p in data['pages']] == list(range(1, len(data['pages']) + 1)),
            'Pages must be contiguous and unique')
    for item in data['pages']:
        verify(item)
        require(all(item[k] == v for k, v in pixels(item['path']).items()), 'Pixel hash changed')
    return data


def load_review(value):
    data = read(value)
    require(data['schema'] == 'a-deepbooker-review-v2' and data['status'] == 'COMPLETE',
            'Previous review is not complete')
    # Old DOCX bytes may have been replaced. Verify immutable manifest/page snapshots instead.
    verify(data['manifest'])
    snapshot = read(data['manifest']['path'])
    require(data['renderer_fingerprint'] == snapshot['renderer_fingerprint'], 'Review renderer mismatch')
    require(len(data['pages']) == len(snapshot['pages']), 'Review coverage mismatch')
    require(data['docx'] == snapshot['docx'], 'Review DOCX mismatch')
    for reviewed, rendered in zip(data['pages'], snapshot['pages']):
        require(reviewed['page'] == rendered['page'] and reviewed['outcome'] == 'PASS', 'Incomplete review')
        require(all(reviewed[k] == rendered[k] for k in ('width', 'height', 'pixel_sha256')), 'Review pixels mismatch')
        verify(rendered)
        require(all(rendered[k] == v for k, v in pixels(rendered['path']).items()), 'Old pixels changed')
        require(reviewed.get('view_evidence') and reviewed.get('note'), 'Missing visual observation')
    for item in data['evidence']:
        verify(item)
    return data


def review_plan(request):
    current = load_manifest(request['manifest'])
    previous = load_review(request['previous_review']) if request.get('previous_review') else None
    same_environment = bool(previous and previous['renderer_fingerprint'] == current['renderer_fingerprint'])
    old_pages = {p['page']: p for p in previous['pages']} if previous else {}
    inherited, needs = [], []
    for item in current['pages']:
        prior = old_pages.get(item['page'])
        equal = prior and all(prior[k] == item[k] for k in ('width', 'height', 'pixel_sha256'))
        (inherited if same_environment and equal else needs).append(item['page'])
    return {'status': 'REVIEW_REQUIRED' if needs else 'INHERITABLE',
            'manifest': bound(request['manifest']), 'needs_review': needs, 'inherited': inherited,
            'removed_pages': sorted(set(old_pages) - {p['page'] for p in current['pages']}),
            'same_environment': same_environment}


def accept_review(request):
    plan = review_plan(request)
    current = load_manifest(request['manifest'])
    observations = read(request['observations'])
    require(isinstance(observations, list), 'Observations must be a list')
    ids = [x['page'] for x in observations]
    require(len(set(ids)) == len(ids), 'Duplicate review page')
    require(set(ids) == set(plan['needs_review']), 'Review exactly the changed/new pages')
    previous = load_review(request['previous_review']) if request.get('previous_review') else None
    old = {p['page']: p for p in previous['pages']} if previous else {}
    supplied = {p['page']: p for p in observations}
    result_pages = []
    for rendered in current['pages']:
        number = rendered['page']
        observation = old[number] if number in plan['inherited'] else supplied[number]
        require(observation['outcome'] in ('PASS', 'FAIL'), 'Invalid page outcome')
        require(str(observation.get('note', '')).strip() and str(observation.get('view_evidence', '')).strip(),
                'Each observed page needs a note and image-view evidence reference')
        result_pages.append({**rendered, 'outcome': observation['outcome'],
                             'note': observation['note'], 'view_evidence': observation['view_evidence'],
                             'basis': 'INHERITED' if number in plan['inherited'] else 'VIEWED'})
    evidence = [bound(request['observations'])]
    if previous:
        evidence += [bound(request['previous_review']), *previous['evidence']]
    return {'schema': 'a-deepbooker-review-v2',
            'status': 'COMPLETE' if all(x['outcome'] == 'PASS' for x in result_pages) else 'PARTIAL',
            'manifest': bound(request['manifest']), 'docx': current['docx'],
            'renderer_fingerprint': current['renderer_fingerprint'], 'pages': result_pages,
            'removed_pages': plan['removed_pages'], 'evidence': evidence}


def validation(request):
    combo = read(request['combination'])
    proof = read(request['content_evidence'])
    review = load_review(request['review'])
    manifest = load_manifest(review['manifest']['path'])
    require(bound(combo['artifacts']['word']) == review['docx'], 'Word changed after visual QA')
    keys = ('state', 'coverage', 'chapters', 'xros', 'analysis', 'concepts', 'transfer',
            'readmes', 'word_structure', 'word_visual')
    require(all(proof.get('checks', {}).get(key) is True for key in keys), 'Content gate is pending')
    verify(combo['original'])
    evidence = [request['content_evidence'], request['review'], *proof['evidence']]
    root = path(combo['project_root'])
    require(all(path(p).is_relative_to(root) for p in evidence), 'Evidence must remain in project')
    return {'source_sha256': sha(combo['original']['path']), 'checks': {key: True for key in keys},
            'artifacts': {key: sha(value) for key, value in combo['artifacts'].items()},
            'state_sha256': sha(combo['state_path']), 'evidence': [bound(p) for p in dict.fromkeys(evidence)],
            'render': {'exit_code': 0, 'pages': len(manifest['pages']), 'inspected_pages': len(review['pages'])}}


def copy_final(source, directory):
    source = path(source)
    require(source.suffix.lower() == '.docx', 'Final delivery accepts DOCX only')
    directory = path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    expected = sha(source)
    index = 1
    while True:
        destination = directory / (source.name if index == 1 else f'{source.stem} ({index}){source.suffix}')
        try:
            with destination.open('xb') as output, source.open('rb') as input_file:
                shutil.copyfileobj(input_file, output)
                output.flush()
                os.fsync(output.fileno())
            break
        except FileExistsError:
            if sha(destination) == expected:
                break
            index += 1
    require(sha(destination) == expected == sha(source), 'Final copy hash mismatch')
    return {'source': bound(source), 'destination': bound(destination), 'verified': True}


def deliver(request):
    acceptance = core({'op': 'check', 'combination': request['combination'], 'validation': request['validation']})
    if acceptance['status'] != 'COMPLETE':
        return {'status': 'PARTIAL', 'core': acceptance, 'pending_gates': acceptance['pending_gates']}
    combo = read(request['combination'])
    review = load_review(request['review'])
    load_manifest(review['manifest']['path'])
    require(bound(combo['artifacts']['word']) == review['docx'], 'Delivery Word changed')
    try:
        receipt = copy_final(combo['artifacts']['word'], READY)
    except (OSError, ValueError) as exc:
        return {'status': 'PARTIAL', 'core': acceptance, 'pending_gates': ['READY_TO_READ_COPY'], 'error': str(exc)}
    return {'status': 'COMPLETE', 'core': acceptance, 'ready_copy': receipt, 'pending_gates': []}


def progress(request, now=None):
    now = time.time() if now is None else now
    target = path(request['ledger'])
    files = [bound(p) for p in request['evidence']]
    require(files and all(path(x['path']) != target for x in files), 'Progress needs stable gate evidence, not its ledger')
    require(request['next_action'].strip(), 'Missing next action')
    old = read(target) if target.exists() else None
    if old:
        require(old['schema'] == 'a-deepbooker-progress-v2' and old['run_id'] == request['run_id'], 'Wrong run ledger')
        require(old['worker_id'] == request['worker_id'], 'Writer change: preserve old ledger and verify terminal before a new ledger')
        require(now >= old['checked_at'], 'Clock moved backwards')
    fingerprint = digest_json(sorted(files, key=lambda x: x['path']))
    changed = not old or old['evidence_sha256'] != fingerprint
    last_progress = now if changed else old['last_progress_at']
    quiet = now - last_progress
    stalled = [] if changed else old['stalled_observations']
    active = request.get('active_tool', False)
    require(type(active) is bool, 'active_tool must be boolean')
    observation = request.get('observation')
    require(observation in (None, 'active', 'stalled'), 'Unknown progress observation')
    if active or observation == 'active':
        stalled = []
    elif observation == 'stalled' and quiet >= 600 and (not stalled or now - stalled[-1] >= 120):
        stalled = (stalled + [now])[-2:]
    action = 'PROGRESS' if changed else 'WAIT'
    if active:
        action = 'INSPECT_ACTIVE_TOOL' if quiet >= 1200 else 'TOOL_ACTIVE'
    elif quiet >= 600:
        action = 'HANDOFF_RECOMMENDED' if len(stalled) == 2 else 'INSPECT'
    data = {'schema': 'a-deepbooker-progress-v2', 'status': action, 'run_id': request['run_id'],
            'stage': request['stage'], 'worker_id': request['worker_id'], 'evidence': files,
            'evidence_sha256': fingerprint, 'last_progress_at': last_progress, 'checked_at': now,
            'checked_utc': datetime.fromtimestamp(now, timezone.utc).isoformat(),
            'quiet_seconds': round(quiet), 'stalled_observations': stalled,
            'active_tool': active, 'next_action': request['next_action'], 'may_terminate_worker': False}
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.parent / ('.progress-' + uuid.uuid4().hex)
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
        os.replace(temporary, target)
    finally:
        if Path(temporary).exists():
            Path(temporary).unlink()
    return data


OPERATIONS = {fn.__name__: fn for fn in (access, sandbox_access, bundle, verify_bundle, render, review_plan,
                                       accept_review, validation, deliver, progress)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog='Operations: ' + ', '.join(OPERATIONS))
    parser.add_argument('--request', required=True)
    parser.add_argument('--output')
    args = parser.parse_args()
    try:
        if args.output:
            require(not path(args.output).exists(), 'Output exists; choose a new result filename')
        request = json.load(sys.stdin) if args.request == '-' else read(args.request)
        result = OPERATIONS[request['op']](request)
        if args.output:
            save_new(args.output, result)
            print(json.dumps({'status': result.get('status', 'RECORDED'), 'output': str(path(args.output))}))
        else:
            print(json.dumps(result, ensure_ascii=False))
        return 2 if result.get('status') in ('PARTIAL', 'BLOCKED') else 0
    except (ValueError, KeyError, IndexError, TypeError, OSError, subprocess.SubprocessError) as exc:
        print(json.dumps({'status': 'BLOCKED', 'error': str(exc)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
