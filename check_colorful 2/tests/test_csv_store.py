"""Direct CSV loading, atomic publication, isolation and database-free startup."""
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from app.data_store import CsvStore
from app.ingestion.raw import import_snapshot
from app.main import create_app


def test_stores_are_isolated(source):
    repo, *_ = source
    fresh = CsvStore()
    assert repo.districts()
    assert fresh.districts() == []
    assert fresh.snapshots == {} and fresh.imports == []


def test_app_loads_csvs_without_sql_or_generated_data_files(source, monkeypatch, tmp_path):
    repo, root, config, result, write = source
    monkeypatch.setattr('app.bootstrap.district_configurations', lambda: [{**config, 'source_folder': '.'}])
    monkeypatch.chdir(tmp_path)
    def forbidden_database(*args, **kwargs):
        raise AssertionError('CSV mode must never open a database')
    monkeypatch.setattr(sqlite3, 'connect', forbidden_database)
    # A leftover deployment variable must not cause the CSV app to read/write SQL files.
    monkeypatch.setenv('COURTS_DB_PATH', str(tmp_path / 'should-not-exist.sqlite3'))
    before = set(tmp_path.rglob('*'))
    with TestClient(create_app(source_dir=root)) as client:
        assert client.get('/api/v1/health').json()['status'] == 'ok'
        params = {'court': 'CJM', 'start': '2017-01', 'end': '2017-01'}
        assert client.get('/api/v1/components/kpis', params=params).json()['total'] == 5
        with ThreadPoolExecutor(8) as pool:
            totals = list(pool.map(lambda _: client.get('/api/v1/components/kpis', params=params).json()['total'], range(24)))
        assert totals == [5] * 24
        assert client.get('/api/v1/exports/register', params={**params, 'format': 'xlsx'}).status_code == 200
    assert set(tmp_path.rglob('*')) == before


def test_bad_source_does_not_publish_partial_district(source, monkeypatch):
    repo, root, config, result, write = source
    (root / 'cjm' / 'daily_proc_a.csv').write_text('wrong,columns\nx,y\n')
    with pytest.raises(ValueError):
        import_snapshot(repo, root, config)
    assert repo.active()['id'] == result['snapshot']
    assert len(repo.snapshots) == 1
    assert repo.health()['status'] == 'degraded'
    monkeypatch.setattr('app.bootstrap.district_configurations', lambda: [{**config, 'source_folder': '.'}])
    with TestClient(create_app(source_dir=root)) as client:
        assert client.get('/api/v1/health').json()['status'] == 'degraded'
        assert client.get('/api/v1/metadata').status_code == 503


def test_source_changes_during_read_are_rejected(source, monkeypatch):
    import app.ingestion.raw as raw
    repo, root, config, result, write = source
    original_rows = raw.rows
    def changing_rows(path):
        yield from original_rows(path)
        if path.name == 'daily_proc_a.csv':
            path.write_text(path.read_text() + 'A,2017-01-10\n')
    monkeypatch.setattr(raw, 'rows', changing_rows)
    with pytest.raises(ValueError, match='source changed'):
        import_snapshot(repo, root, {**config, 'revision': 2})
    assert repo.active()['id'] == result['snapshot']
    assert len(repo.snapshots) == 1


def test_case_and_hearing_provenance_retained(source):
    repo, root, config, result, write = source
    data = repo.snapshot(result['snapshot'])['courts']['CJM']
    assert data.cases['A']['source_file'] == 'civil_t_a.csv'
    assert data.cases['A']['source_row'] == 2
    assert data.hearings['A'][0] == ('2017-01-01', 'daily_proc_a.csv', 3)
    assert data.hearings['A'][1] == ('2017-01-03', 'daily_proc.csv', 2)
    assert len(data.hearings['A']) == 4  # Includes out-of-window dates until cohort slicing.


def test_metadata_requests_do_not_mutate_stored_config(source):
    repo, root, config, result, write = source
    stored = repo.active()['config']
    with TestClient(create_app(store=repo)) as client:
        client.get('/api/v1/metadata').raise_for_status()
        client.get('/api/v1/components/kpis?court=CJM').raise_for_status()
    assert repo.active()['config'] == stored
