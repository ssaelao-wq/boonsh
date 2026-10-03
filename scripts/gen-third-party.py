#!/usr/bin/env python3
"""Writes src-tauri/THIRD_PARTY_LICENSES.txt: the licenses of every library that goes into the boonsh app.

Rust crates come from `cargo metadata` (only the normal dependencies of the Windows build, so build tools and
test helpers are left out); JavaScript packages come from package.json "dependencies" and what they depend on.
Components that share an identical license text are listed together under one copy of the text.

Run from the repository root after changing dependencies:  python scripts/gen-third-party.py
"""
import hashlib
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'src-tauri', 'THIRD_PARTY_LICENSES.txt')
LICENSE_FILE = re.compile(r'^(licen[sc]e|copying|unlicense|notice|copyright)([-_.].*)?$', re.I)


def read_license_files(folder):
    texts = []
    try:
        names = sorted(os.listdir(folder))
    except OSError:
        return texts
    for n in names:
        p = os.path.join(folder, n)
        if os.path.isfile(p) and LICENSE_FILE.match(n):
            with open(p, 'rb') as f:
                t = f.read().decode('utf-8', errors='replace').replace('\r\n', '\n').strip()
            if t:
                texts.append(t)
    return texts


def rust_components():
    meta = json.loads(subprocess.check_output(
        ['cargo', 'metadata', '--format-version', '1', '--manifest-path', os.path.join(ROOT, 'src-tauri', 'Cargo.toml'),
         '--filter-platform', 'x86_64-pc-windows-msvc'], cwd=ROOT))
    pkgs = {p['id']: p for p in meta['packages']}
    nodes = {n['id']: n for n in meta['resolve']['nodes']}
    root = meta['resolve']['root']
    seen, todo = set(), [root]
    while todo:
        cur = todo.pop()
        if cur in seen:
            continue
        seen.add(cur)
        for d in nodes[cur]['deps']:
            if any(k.get('kind') is None for k in d['dep_kinds']):  # normal dependencies only
                todo.append(d['pkg'])
    out = []
    for pid in seen:
        p = pkgs[pid]
        if pid == root:
            continue
        out.append(('Rust', p['name'], p['version'], p.get('license') or 'see source', p.get('repository') or '',
                    read_license_files(os.path.dirname(p['manifest_path']))))
    return out


def js_components():
    base = os.path.join(ROOT, 'node_modules')
    with open(os.path.join(ROOT, 'package.json'), encoding='utf-8') as f:
        todo = list(json.load(f).get('dependencies', {}))
    seen, out = set(), []
    while todo:
        name = todo.pop()
        if name in seen:
            continue
        seen.add(name)
        folder = os.path.join(base, *name.split('/'))
        try:
            with open(os.path.join(folder, 'package.json'), encoding='utf-8') as f:
                pj = json.load(f)
        except OSError:
            print(f'warning: {name} is not installed (run npm install)', file=sys.stderr)
            continue
        todo += list(pj.get('dependencies', {}))
        lic = pj.get('license') or 'see source'
        repo = pj.get('repository')
        repo = repo.get('url', '') if isinstance(repo, dict) else (repo or '')
        out.append(('JavaScript', name, pj.get('version', ''), lic if isinstance(lic, str) else str(lic), repo, read_license_files(folder)))
    return out


def main():
    comps = sorted(rust_components() + js_components(), key=lambda c: (c[0], c[1].lower(), c[2]))
    groups = {}  # text -> components
    nofile = []
    for c in comps:
        if not c[5]:
            nofile.append(c)
        for t in c[5]:
            groups.setdefault(t, []).append(c)

    lines = [
        'THIRD-PARTY LICENSES',
        '====================',
        '',
        'boonsh itself is released under the MIT License (see the LICENSE file).',
        'boonsh includes the open-source components listed below. Each is used under its own license, whose',
        'text follows. Components that share the same license text are listed together above that text.',
        '',
        f'{len(comps)} components: ' + ', '.join(f'{k} {sum(1 for c in comps if c[0] == k)}' for k in ('Rust', 'JavaScript')),
        '',
    ]
    for n, (text, members) in enumerate(sorted(groups.items(), key=lambda kv: (kv[1][0][0], kv[1][0][1].lower())), 1):
        lines += ['', '=' * 78, f'License text {n}, used by:', '']
        for kind, name, ver, lic, repo, _ in members:
            lines.append(f'  - {name} {ver} ({lic})' + (f'  {repo}' if repo else ''))
        lines += ['', '-' * 78, text, '']
    if nofile:
        lines += ['', '=' * 78, 'Components that ship no separate license file (license named in their package data):', '']
        for kind, name, ver, lic, repo, _ in nofile:
            lines.append(f'  - {name} {ver} ({lic})' + (f'  {repo}' if repo else ''))
        lines.append('')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines))
    print(f'{len(comps)} components, {len(groups)} distinct license texts, {len(nofile)} without a file -> {OUT} ({os.path.getsize(OUT) // 1024} KB)')


if __name__ == '__main__':
    main()
