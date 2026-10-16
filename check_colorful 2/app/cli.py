"""Validate district CSV files using the same direct loader as the web app."""
import argparse
import json
import sys
from pathlib import Path
from app.bootstrap import source_root
from app.config import SOURCE_DATA_DIR, district_configurations
from app.ingestion.raw import import_snapshot
from app.data_store import CsvStore

def main():
    parser = argparse.ArgumentParser(description='Validate configured district CSV folders without a database')
    parser.add_argument('--source-dir', type=Path, default=SOURCE_DATA_DIR)
    parser.add_argument('--district', help='Import only this district; default imports all configured districts')
    args = parser.parse_args()
    configs = [c for c in district_configurations() if not args.district or c['district'] == args.district]
    if not configs:
        parser.error('Unknown configured district')
    repo = CsvStore()
    print('Validating source files directly; no database is created. '
          'The web app loads its own in-memory records at startup.', file=sys.stderr)
    failed = False
    for config in configs:
        root = source_root(args.source_dir, config, bool(args.district))
        try:
            result = import_snapshot(repo, root, config)
            print(json.dumps({'district': config['district'], **result}), flush=True)
        except Exception as exc:
            failed = True
            print(json.dumps({'district': config['district'], 'status': 'error', 'error': str(exc)}), flush=True)
    return int(failed)

if __name__ == '__main__':
    raise SystemExit(main())
