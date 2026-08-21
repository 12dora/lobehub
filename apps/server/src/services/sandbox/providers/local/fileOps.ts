/**
 * In-container Python helpers for sandbox file tools.
 *
 * Marker `LOBE_SANDBOX_FILE_OPS` lets the fake Docker daemon in tests dispatch
 * the same JSON protocol without executing CPython.
 *
 * Every path is jailed with os.path.realpath under /mnt/data so symlink
 * escapes (e.g. ln -s /etc /mnt/data/etc) are rejected.
 */
export const FILE_OPS_SCRIPT = `
# LOBE_SANDBOX_FILE_OPS
import base64, json, os, re, shutil, glob, fnmatch
from pathlib import Path
from datetime import datetime

ROOT = '/mnt/data'

def load_args(encoded):
    return json.loads(base64.b64decode(encoded).decode())

def emit(value):
    print(json.dumps(value, ensure_ascii=False))

def fail(message):
    emit({'success': False, 'error': message})
    return

def jailed(path, must_exist=False):
    if not path:
        path = '.'
    if not os.path.isabs(path):
        path = os.path.join(ROOT, path)
    norm = os.path.normpath(path)
    root_real = os.path.realpath(ROOT)
    if os.path.lexists(norm):
        real = os.path.realpath(norm)
    else:
        parent = os.path.dirname(norm) or ROOT
        walk = parent
        missing = []
        while walk not in (ROOT, os.sep, '') and not os.path.isdir(walk):
            missing.append(os.path.basename(walk))
            nxt = os.path.dirname(walk)
            if nxt == walk:
                break
            walk = nxt
        if os.path.isdir(walk):
            real_parent = os.path.realpath(walk)
        else:
            real_parent = root_real
        bits = list(reversed(missing)) + [os.path.basename(norm)]
        real = os.path.normpath(os.path.join(real_parent, *bits))
    if real != root_real and not real.startswith(root_real + os.sep):
        raise ValueError('path escapes sandbox workspace: ' + str(path))
    if must_exist and not os.path.lexists(real):
        raise FileNotFoundError(real)
    return real

def main(encoded):
    args = load_args(encoded)
    op = args.get('op')
    try:
        if op == 'list':
            directory = jailed(args.get('directoryPath') or '.')
            entries = []
            for entry in os.scandir(directory):
                try:
                    stat = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                path = jailed(entry.path)
                entries.append({
                    'name': entry.name,
                    'path': path,
                    'isDirectory': entry.is_dir(follow_symlinks=False),
                    'size': stat.st_size,
                    'mtime': stat.st_mtime,
                })
            emit({'files': entries, 'totalCount': len(entries)})
            return
        if op == 'read':
            path = jailed(args.get('path'), must_exist=True)
            start = args.get('startLine')
            end = args.get('endLine')
            text = Path(path).read_text(errors='replace')
            lines = text.splitlines(True)
            selected = lines
            if start is not None or end is not None:
                start_idx = max((start or 1) - 1, 0)
                end_idx = end if end is not None else len(lines)
                selected = lines[start_idx:end_idx]
            content = ''.join(selected)
            emit({
                'content': content,
                'filename': os.path.basename(path),
                'charCount': len(content),
                'totalCharCount': len(text),
                'totalLineCount': len(lines),
            })
            return
        if op == 'prepare_write':
            path = jailed(args.get('path'))
            target = Path(path)
            if args.get('createDirectories'):
                target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'')
            emit({'success': True})
            return
        if op == 'append_chunk':
            path = jailed(args.get('path'))
            chunk = base64.b64decode(args.get('chunk') or '')
            with Path(path).open('ab') as file:
                file.write(chunk)
            emit({'bytesWritten': len(chunk), 'success': True})
            return
        if op == 'edit':
            path = Path(jailed(args.get('path'), must_exist=True))
            search = args.get('search') or ''
            replace = args.get('replace') or ''
            text = path.read_text(errors='replace')
            count = text.count(search)
            if count == 0:
                emit({'success': False, 'error': 'search text not found', 'replacements': 0})
                return
            new_text = text.replace(search, replace) if args.get('all') else text.replace(search, replace, 1)
            replacements = count if args.get('all') else 1
            path.write_text(new_text)
            emit({'success': True, 'replacements': replacements, 'linesAdded': replace.count('\\n'), 'linesDeleted': search.count('\\n')})
            return
        if op == 'search':
            directory = jailed(args.get('directory') or '.')
            raw_keywords = args.get('keywords') or args.get('keyword') or ''
            keywords = [item.strip() for item in str(raw_keywords).split() if item.strip()]
            raw_file_types = args.get('fileTypes') or args.get('fileType') or []
            if isinstance(raw_file_types, str):
                raw_file_types = [raw_file_types]
            file_types = [item if str(item).startswith('.') else f'.{item}' for item in raw_file_types if str(item).strip()]
            def parse_time(value):
                if not value:
                    return None
                try:
                    return datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
                except Exception:
                    return None
            modified_after = parse_time(args.get('modifiedAfter'))
            modified_before = parse_time(args.get('modifiedBefore'))
            content_contains = args.get('contentContains')
            limit = args.get('limit')
            results = []
            for root, _, files in os.walk(directory):
                for name in files:
                    if keywords and not all(keyword in name for keyword in keywords):
                        continue
                    if file_types and not any(name.endswith(file_type) for file_type in file_types):
                        continue
                    path = os.path.join(root, name)
                    try:
                        jailed(path)
                        stat = os.stat(path)
                    except Exception:
                        continue
                    if modified_after is not None and stat.st_mtime < modified_after:
                        continue
                    if modified_before is not None and stat.st_mtime > modified_before:
                        continue
                    if content_contains:
                        try:
                            if str(content_contains) not in Path(path).read_text(errors='replace'):
                                continue
                        except Exception:
                            continue
                    results.append({'name': name, 'path': path, 'size': stat.st_size, 'mtime': stat.st_mtime})
            sort_by = args.get('sortBy')
            reverse = args.get('sortDirection') == 'desc'
            if sort_by == 'size':
                results.sort(key=lambda item: item.get('size') or 0, reverse=reverse)
            elif sort_by == 'date':
                results.sort(key=lambda item: item.get('mtime') or 0, reverse=reverse)
            else:
                results.sort(key=lambda item: item.get('name') or '', reverse=reverse)
            total = len(results)
            if isinstance(limit, int) and limit > 0:
                results = results[:limit]
            emit({'results': results, 'totalCount': total})
            return
        if op == 'move':
            results = []
            for operation in args.get('operations') or []:
                source = operation.get('source')
                destination = operation.get('destination')
                try:
                    shutil.move(jailed(source, must_exist=True), jailed(destination))
                    results.append({'source': source, 'destination': destination, 'success': True})
                except Exception as error:
                    results.append({'source': source, 'destination': destination, 'success': False, 'error': str(error)})
            emit({'results': results, 'successCount': len([item for item in results if item.get('success')])})
            return
        if op == 'grep':
            directory = jailed(args.get('directory') or '.')
            pattern = args.get('pattern') or ''
            file_pattern = args.get('filePattern') or '*'
            recursive = args.get('recursive', True)
            regex = re.compile(pattern)
            matches = []
            walker = os.walk(directory) if recursive else [(directory, [], os.listdir(directory))]
            for root, _, files in walker:
                for name in files:
                    if not fnmatch.fnmatch(name, file_pattern):
                        continue
                    path = os.path.join(root, name)
                    try:
                        jailed(path)
                        with open(path, 'r', errors='replace') as file:
                            for index, line in enumerate(file, 1):
                                if regex.search(line):
                                    matches.append({'path': path, 'lineNumber': index, 'line': line.rstrip('\\n')})
                    except Exception:
                        pass
            emit({'matches': matches, 'totalMatches': len(matches)})
            return
        if op == 'glob':
            directory = jailed(args.get('directory') or '.')
            pattern = args.get('pattern') or '*'
            files = []
            for path in glob.glob(os.path.join(directory, pattern), recursive=True):
                try:
                    files.append(jailed(path))
                except Exception:
                    continue
            emit({'files': files, 'totalCount': len(files)})
            return
        if op == 'delete':
            path = jailed(args.get('path'), must_exist=True)
            target = Path(path)
            if target.is_dir():
                shutil.rmtree(target)
            else:
                target.unlink()
            emit({'success': True, 'path': path})
            return
        fail('unknown file op: ' + str(op))
    except Exception as error:
        fail(str(error))
`.trim();

export const encodeFileOpArgs = (op: string, params: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ ...params, op })).toString('base64');

export const buildFileOpCommand = (op: string, params: Record<string, unknown>) =>
  `${FILE_OPS_SCRIPT}\nmain('${encodeFileOpArgs(op, params)}')\n`;
