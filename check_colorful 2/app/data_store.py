"""Validated CSV records held in Python collections; no database or query engine.

A complete district is built off to the side and published only after validation.
Published snapshots are treated as read-only by analytics. Reloads keep earlier
snapshots available to in-flight requests and never partly replace a district.
"""
import json
from array import array
from dataclasses import dataclass, field
from threading import RLock


class HearingList:
    """One case's hearings, stored compactly (date strings are shared; row numbers are 4-byte ints).

    Behaves like the tuple of (day, source_file, source_row) it replaces: len(), indexing and
    iteration give the same tuples. `.days` is the cheap path for code that only needs dates.
    """
    __slots__ = ('days', 'rows', 'files')

    def __init__(self, entries):
        entries = tuple(entries)
        self.days = tuple(e[0] for e in entries)
        self.rows = array('I', (e[2] for e in entries))
        self.files = tuple(e[1] for e in entries)

    def __len__(self):
        return len(self.days)

    def __getitem__(self, i):
        return (self.days[i], self.files[i], self.rows[i])

    def __iter__(self):
        return zip(self.days, self.files, self.rows)

    def __eq__(self, other):
        return tuple(self) == tuple(other)

    __hash__ = None


class CaseRecord:
    """One case. Reads like the dict it replaces (record['filing'], dict(record, name=...)) but stores
    its fields in slots, which is roughly a third of the memory for the ~250k cases held in RAM."""
    __slots__ = ('cino', 'type_code', 'filing', 'registered', 'listing', 'decision', 'status',
                 'disposition', 'source_file', 'source_row', 'name', 'side', 'court')

    def __init__(self, **fields):
        for name in self.__slots__:
            setattr(self, name, fields.get(name))

    def keys(self):
        return [n for n in self.__slots__ if getattr(self, n) is not None or n in _CORE]

    def __getitem__(self, key):
        if key not in self.__slots__:
            raise KeyError(key)
        return getattr(self, key)

    def get(self, key, default=None):
        return getattr(self, key, default) if key in self.__slots__ else default

    def __iter__(self):
        return iter(self.keys())

    def __len__(self):
        return len(self.keys())

    def __contains__(self, key):
        return key in self.keys()

    def items(self):
        return [(k, getattr(self, k)) for k in self.keys()]

    def with_(self, **extra):
        return CaseRecord(**{**dict(self.items()), **extra})

    def __eq__(self, other):
        return dict(self.items()) == dict(other.items() if hasattr(other, 'items') else other)

    __hash__ = None

    def __repr__(self):
        return 'CaseRecord(%r)' % dict(self.items())


_CORE = frozenset(('cino', 'type_code', 'filing', 'registered', 'listing', 'decision', 'status', 'disposition', 'source_file', 'source_row'))


@dataclass
class CourtData:
    cases: dict = field(default_factory=dict)       # cino -> normalized case record
    types: dict = field(default_factory=dict)       # local type code -> (name, side)
    hearings: dict = field(default_factory=dict)    # cino -> HearingList of sorted (day, source_file, source_row)
    calendar: tuple = ()                           # sorted valid court working dates
    monthly_working_days: dict = field(default_factory=dict)  # month -> (days, source row)
    dispositions: dict = field(default_factory=dict)


class CsvStore:
    def __init__(self):
        self.lock = RLock()
        self.snapshots = {}
        self.active_districts = {}
        self.imports = []
        self.loading = False   # True while a background import is still running

    def districts(self):
        with self.lock:
            return sorted(self.active_districts, key=lambda name: (name != 'Purba Medinipur', name))

    def snapshot(self, snapshot_id):
        with self.lock:
            return self.snapshots[snapshot_id]

    def active(self, district=None):
        with self.lock:
            if district is None:
                district = next(iter(self.districts()), None)
            snapshot_id = self.active_districts.get(district)
            return self.snapshots.get(snapshot_id)

    def record_import(self, at, status, detail, district):
        with self.lock:
            self.imports.append({'id': len(self.imports) + 1, 'at': at, 'status': status,
                                 'detail': detail, 'district': district})

    def publish(self, snapshot, district):
        with self.lock:
            self.snapshots[snapshot['id']] = snapshot
            self.active_districts[district] = snapshot['id']
            self.record_import(snapshot['created_at'], 'imported', snapshot['id'], district)

    def health(self, district=None):
        with self.lock:
            district = district or next(iter(self.districts()), None)
            # If every source failed, report the failed district rather than hiding the error.
            if district is None and self.imports:
                district = self.imports[-1]['district']
            last = next((row for row in reversed(self.imports) if row['district'] == district), None)
            active = self.active(district)
            return {'status': 'loading' if self.loading else 'degraded' if last and last['status'] == 'error' else 'ok' if active else 'not_imported',
                    'district': district, 'districts': self.districts(),
                    'snapshot': active['id'] if active else None,
                    'last_import': dict(last) if last else None,
                    'quality': json.loads(active['quality']) if active else {}}
