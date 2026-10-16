#!/usr/bin/env python3
"""Check the project is safe to push to GitHub and deploy on Render, before you do either.

    python scripts/preflight.py

Checks: oversized files, files that should not be committed, every configured source file exists
with the exact upper/lower-case spelling Linux needs, the data imports, and how long / how much
memory that takes. Exit code 1 means fix something first.
"""
import os
import resource
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
WARN_MB, BLOCK_MB, REPO_WARN_MB = 50, 100, 400
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.pytest_cache', '.venv', 'venv', '__MACOSX'}
JUNK = {'.DS_Store'}
problems, notes = [], []


def walk():
    for dirpath, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            yield Path(dirpath) / name


def check_sizes():
    total = 0
    for path in walk():
        size = path.stat().st_size
        total += size
        mb = size / 1048576
        rel = path.relative_to(ROOT)
        if mb >= BLOCK_MB:
            problems.append(f'{rel} is {mb:.0f} MB: GitHub rejects files of 100 MB or more. Add it to .gitignore or split it.')
        elif mb >= WARN_MB:
            notes.append(f'{rel} is {mb:.0f} MB: GitHub warns above 50 MB.')
        if path.name in JUNK or path.name.startswith('._') or path.suffix == '.sqlite3':
            notes.append(f'{rel} should not be committed (already in .gitignore).')
    print(f'Project size: {total / 1048576:.0f} MB (files git would track are smaller: .gitignore applies)')
    if total / 1048576 > REPO_WARN_MB:
        notes.append(f'Project is over {REPO_WARN_MB} MB; consider trimming data you do not need on the server.')


def check_sources():
    from app.bootstrap import source_root
    from app.config import SOURCE_DATA_DIR, district_configurations
    from app.ingestion.raw import SCHEMAS
    for config in district_configurations():
        root = source_root(SOURCE_DATA_DIR, config)
        if not root.is_dir():
            problems.append(f"{config['district']}: source folder {root} not found (Linux paths are case-sensitive).")
            continue
        wanted = [Path(c['folder']) / n for c in config['courts'] for n in SCHEMAS]
        if config.get('monthly_working_days'):
            wanted.append(Path(config['monthly_working_days']['file']))
        for rel in wanted:
            # Compare each path part against the real directory listing: catches 'CJM' vs 'cjm'.
            here = root
            for part in rel.parts:
                names = os.listdir(here) if here.is_dir() else []
                if part not in names:
                    hint = next((n for n in names if n.lower() == part.lower()), None)
                    problems.append(f"{config['district']}: '{rel}' missing" + (f" (found '{hint}': fix the case)" if hint else ''))
                    break
                here = here / part


def check_import():
    from app.bootstrap import load_districts
    from app.data_store import CsvStore
    repo = CsvStore()
    start = time.time()
    ok = load_districts(repo, log=lambda m: print('  ', m))
    seconds = time.time() - start
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    peak_mb = peak / 1048576 if sys.platform == 'darwin' else peak / 1024
    print(f'Import: {seconds:.1f}s, peak memory {peak_mb:.0f} MB')
    if not ok:
        problems.append('A district failed to import (see the error above).')
    if peak_mb > 450:
        notes.append('Peak memory is close to the 512 MB free-plan limit; use a larger Render plan.')


if __name__ == '__main__':
    check_sizes()
    check_sources()
    if not problems:
        check_import()
    for n in notes:
        print('note:', n)
    for p in problems:
        print('PROBLEM:', p)
    print('\nFAIL: fix the problems above.' if problems else '\nOK: safe to push and deploy.')
    sys.exit(1 if problems else 0)
