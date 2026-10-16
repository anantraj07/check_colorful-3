"""Read CSVs directly into validated per-court Python collections."""
import csv
import hashlib
import json
from collections import Counter
from datetime import date, datetime, timezone
from pathlib import Path
from app.ingestion.working_days import read_working_days
from app.data_store import CaseRecord, CourtData, HearingList
CASE_COLUMNS = {'cino', 'regcase_type', 'date_of_filing', 'dt_regis', 'date_first_list', 'date_of_decision', 'disp_nature'}
SCHEMAS = {'civil_t.csv': CASE_COLUMNS, 'civil_t_a.csv': CASE_COLUMNS, 'daily_proc.csv': {'cino', 'todays_date'}, 'daily_proc_a.csv': {'cino', 'todays_date'}, 'case_type_t.csv': {'case_type', 'type_name', 'type_flag'}, 'disp_type_t.csv': {'disp_type', 'disp_name', 'national_code'}}

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def rows(path):
    """Yield (line, {column: value}) holding only the columns this file type needs.

    Equivalent to csv.DictReader + strip, but without building a dict of every column for every
    row, which dominated load time on the multi-million-row hearing files.
    """
    needed = SCHEMAS[path.name]
    with path.open(newline='', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        header = next(reader, None) or []
        missing = needed - set(header)
        if missing:
            raise ValueError(f'{path.name}: missing columns {sorted(missing)}')
        width = len(header)
        picks = [(name, header.index(name)) for name in needed]
        line = 1
        for row in reader:
            if not row:
                continue  # blank lines are skipped and not counted, as DictReader did
            line += 1
            n = len(row)
            if n > width:
                raise ValueError(f'{path.name}:{line}: unexpected extra columns')
            yield (line, {name: (row[i].strip() if i < n else '') for name, i in picks})

def valid_date(value, quality, field, cache=None):
    if not value:
        quality['missing_' + field] += 1
        return None
    if cache is not None and value in cache:
        result = cache[value]
        if result is None:
            quality['invalid_' + field] += 1
        return result
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError()
        if cache is not None:
            cache[value] = value  # Share repeated date strings within a court.
        return value
    except ValueError:
        quality['invalid_' + field] += 1
        if cache is not None:
            cache[value] = None
        return None

def allowed(day):
    d = date.fromisoformat(day)
    return d.weekday() != 6 and (not (d.weekday() == 5 and (d.day - 1) // 7 in (1, 3)))

REQUIRED_RATE_PURPOSES = {'arrival_rate', 'hearing_rate'}

def validate_config(config):
    """Fail loudly on configuration that would silently change what the numbers mean."""
    court_ids = {c['id'] for c in config['courts']}
    cutoffs = config.get('listing_cutoffs') or {}
    if not isinstance(cutoffs, dict):
        raise ValueError('listing_cutoffs must map court id to an ISO date')
    for court, day in cutoffs.items():
        if court not in court_ids:
            raise ValueError(f'listing_cutoffs: unknown court {court!r}')
        try:
            if date.fromisoformat(day).isoformat() != day:
                raise ValueError()
        except (TypeError, ValueError):
            raise ValueError(f'listing_cutoffs[{court}]: {day!r} is not an ISO date (YYYY-MM-DD)') from None
    if config.get('require_monthly_working_days'):
        source = config.get('monthly_working_days')
        where = config['district']
        if not source:
            raise ValueError(f'{where}: monthly_working_days workbook is required; refusing to infer working days from activity dates')
        missing = REQUIRED_RATE_PURPOSES - set(source.get('uses', []))
        if missing:
            raise ValueError(f'{where}: monthly_working_days must be used for {sorted(missing)}')
        absent = sorted(court_ids - set(source.get('sheets', {})))
        if absent:
            raise ValueError(f'{where}: monthly_working_days has no sheet configured for {absent}')

def reject_copied_workbook(repo, config, digest):
    """A district's working-day workbook must not be byte-identical to another district's."""
    for snapshot in repo.snapshots.values():
        other = json.loads(snapshot['config'])['district']
        if other != config['district'] and any(f['court'] == '__district__' and f['sha256'] == digest for f in snapshot['files']):
            raise ValueError(f"{config['district']}: working-day workbook is byte-identical to {other}'s; supply this district's own counts")

def import_snapshot(repo, root, config):
    now = datetime.now(timezone.utc).isoformat()
    try:
        validate_config(config)
        inventory = []
        for court in config['courts']:
            for name in SCHEMAS:
                path = Path(root) / court['folder'] / name
                inventory.append((court['id'], name, path, sha(path), path.stat().st_size))
        workbook = config.get('monthly_working_days')
        monthly = {}
        if workbook:
            path = Path(root) / workbook['file']
            inventory.append(('__district__', workbook['file'], path, sha(path), path.stat().st_size))
            monthly = read_working_days(path, config)
        digest = hashlib.sha256(json.dumps([config, [(c, n, h) for c, n, p, h, b in inventory]], sort_keys=True).encode()).hexdigest()
        quality = {}
        with repo.lock:
            if workbook:
                reject_copied_workbook(repo, config, inventory[-1][3])
            if digest in repo.snapshots:
                repo.active_districts[config['district']] = digest
                repo.record_import(now, 'unchanged', digest, config['district'])
                return {'status': 'unchanged', 'snapshot': digest}
        courts, files = {}, []
        # Build a district privately; a failure below cannot change the active data.
        for court in config['courts']:
            cid = court['id']
            q, activity, counts, date_cache = Counter(), set(), {}, {}
            data = CourtData()
            folder = Path(root) / court['folder']
            for line, r in rows(folder / 'case_type_t.csv'):
                counts['case_type_t.csv'] = line - 1
                code = r['case_type'] or 'UNKNOWN'
                if code in data.types:
                    q['duplicate_type_codes'] += 1
                data.types[code] = (r['type_name'] or f'Type {code}', {'1': 'Civil', '2': 'Criminal'}.get(r['type_flag'], 'Unknown'))
            for line, r in rows(folder / 'disp_type_t.csv'):
                counts['disp_type_t.csv'] = line - 1
                data.dispositions[r['disp_type']] = r
            # Match the previous resolution rule: last row wins; archived follows pending.
            date_fields = ('filing', 'registered', 'listing', 'decision')
            type_codes = {code: code for code in data.types}
            for filename, status in [('civil_t.csv', 'pending'), ('civil_t_a.csv', 'disposed')]:
                for line, r in rows(folder / filename):
                    counts[filename] = line - 1
                    cino = r['cino']
                    if not cino:
                        q['excluded_missing_case_id'] += 1
                        continue
                    previous = data.cases.get(cino)
                    if previous is not None:
                        q['duplicate_case_ids'] += 1
                    code = r['regcase_type'] or 'UNKNOWN'
                    code = type_codes.setdefault(code, code)
                    if code not in data.types:
                        data.types[code] = (f'Type {code}' if code != 'UNKNOWN' else 'Unclassified', 'Unknown')
                        q['unknown_type_codes'] += 1
                    dates = [valid_date(r[k], q, k, date_cache) for k in ('date_of_filing', 'dt_regis', 'date_first_list', 'date_of_decision')]
                    if previous is not None and [previous[k] for k in date_fields] != dates:
                        q['conflicting_case_dates'] += 1
                    data.cases[cino] = CaseRecord(cino=cino, type_code=code, **dict(zip(date_fields, dates)),
                                           status=status, disposition=r['disp_nature'], source_file=filename, source_row=line)
            for case in data.cases.values():
                activity.update(d for d in (case['filing'], case['registered'], case['decision']) if d)
            hearing_rows = {}
            for filename in ['daily_proc.csv', 'daily_proc_a.csv']:
                for line, r in rows(folder / filename):
                    counts[filename] = line - 1
                    day = valid_date(r['todays_date'], q, 'hearing_date', date_cache)
                    if day:
                        activity.add(day)
                    case = data.cases.get(r['cino'])
                    if case is None:
                        q['excluded_orphan_hearings'] += 1
                        continue
                    if day:
                        dates = hearing_rows.setdefault(case['cino'], {})
                        if day in dates:
                            q['duplicate_hearing_dates'] += 1
                        else:
                            dates[day] = (filename, line)
            if hearing_rows:
                q.setdefault('duplicate_hearing_dates', 0)
            # Freeze each case's deduplicated dates in order; retain first-row provenance.
            for cino in list(hearing_rows):
                dates = hearing_rows.pop(cino)
                data.hearings[cino] = HearingList((day, *dates[day]) for day in sorted(dates))
            data.calendar = tuple(d for d in sorted(activity) if allowed(d))
            if workbook:
                entries = monthly[cid]
                data.monthly_working_days = {month: (days, line) for month, days, line in entries}
                q['missing_monthly_working_days'] = sum(days is None for month, days, line in entries)
                q['zero_monthly_working_days'] = sum(days == 0 for month, days, line in entries)
            q['case_records'] = len(data.cases)
            quality[cid], courts[cid] = dict(q), data
            for c, n, path, digest_file, size in inventory:
                if c == cid:
                    files.append(dict(court=cid, name=n, sha256=digest_file, rows=counts.get(n, 0), bytes=size))
        if workbook:
            c, n, path, digest_file, size = inventory[-1]
            files.append(dict(court=c, name=n, sha256=digest_file, rows=sum(len(entries) for entries in monthly.values()), bytes=size))
        for c, n, path, digest_file, size in inventory:
            if sha(path) != digest_file:
                raise ValueError(f'{c}/{n}: source changed during import')
        snapshot = dict(id=digest, created_at=now, config=json.dumps(config), quality=json.dumps(quality),
                        courts=courts, files=files)
        with repo.lock:
            if workbook:
                reject_copied_workbook(repo, config, inventory[-1][3])
            repo.publish(snapshot, config['district'])
        return {'status': 'imported', 'snapshot': digest, 'quality': quality}
    except Exception as exc:
        repo.record_import(now, 'error', str(exc), config['district'])
        raise
