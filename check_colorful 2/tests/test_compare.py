"""District comparison: figures must equal the single-court panels for the same filters."""
import pytest
from fastapi.testclient import TestClient
from app.main import create_app


@pytest.fixture(scope='module')
def client():
    with TestClient(create_app()) as c:
        yield c


def test_compare_covers_both_districts_and_all_courts(client):
    d = client.get('/api/v1/compare?court=CJM&start=2010-01&end=2026-06').json()
    assert {e['district'] for e in d['districts']} == {'Purba Medinipur', 'Bankura'}
    assert all(len(rows) == 4 for rows in d['courts'].values())
    assert [m['key'] for m in d['metrics']][0] == 'filings'


def test_compare_filings_match_single_court_kpis(client):
    d = client.get('/api/v1/compare?court=DJ&start=2015-01&end=2020-12').json()
    for district, rows in d['courts'].items():
        row = next(r for r in rows if r['court'] == 'DJ')
        kpi = client.get('/api/v1/components/kpis', params={'district': district, 'court': 'DJ', 'start': '2015-01', 'end': '2020-12'}).json()
        assert row['filings'] == kpi['total']


def test_compare_rejects_bad_input(client):
    assert client.get('/api/v1/compare?court=XX&start=2010-01&end=2026-06').status_code == 404
    assert client.get('/api/v1/compare?court=CJM&start=2026-06&end=2010-01').status_code == 422


def test_compare_accepts_chosen_districts_and_lists_all(client):
    d = client.get('/api/v1/compare?court=CJM&start=2010-01&end=2026-06&districts=Bankura,Purba%20Medinipur').json()
    assert [e['district'] for e in d['districts']] == ['Bankura', 'Purba Medinipur']
    assert set(d['all_districts']) == {'Purba Medinipur', 'Bankura'}
    assert client.get('/api/v1/compare?court=CJM&start=2010-01&end=2026-06&districts=Bankura,Nowhere').status_code == 404
    assert client.get('/api/v1/compare?court=CJM&start=2010-01&end=2026-06&districts=Bankura').status_code == 422


def test_compare_measure_pairs_any_two_courts_and_matches_panels(client):
    q = {'metric': 'disposal', 'start': '2015-01', 'end': '2020-12', 'a_district': 'Purba Medinipur', 'a_court': 'DJ', 'b_district': 'Bankura', 'b_court': 'CJM'}
    d = client.get('/api/v1/compare/measure', params=q).json()
    assert d['a']['label'] == 'Purba Medinipur · DJ' and d['b']['label'] == 'Bankura · CJM'
    assert [r['case_type'] for r in d['a']['rows']] == [r['case_type'] for r in d['b']['rows']]
    panel = client.get('/api/v1/components/disposal', params={'district': 'Purba Medinipur', 'court': 'DJ', 'start': d['start'], 'end': d['end']}).json()
    by_name = {r['case_type']: r for r in panel['rows']}
    for r in d['a']['rows']:
        if r['case_type'] in by_name:
            assert r['median'] == by_name[r['case_type']]['median'] and r['p90'] == by_name[r['case_type']]['p90']


def test_pair_comparison_uses_same_cutoff_intersection_for_both_courts(client):
    q = {'metric': 'disposal', 'start': '2010-01', 'end': '2020-12',
         'a_district': 'Purba Medinipur', 'a_court': 'DJ',
         'b_district': 'Bankura', 'b_court': 'CJM'}
    d = client.get('/api/v1/compare/measure', params=q).json()
    assert d['start'] == d['a']['start'] == d['b']['start'] == '2017-01'
    assert d['end'] == d['a']['end'] == d['b']['end'] == '2020-12'
    assert d['comparison_cutoff'] == '2017-01-01'
    assert any('Common comparison period: 2017-01–2020-12' in note for note in d['notes'])
    gap = client.get('/api/v1/compare/measure', params={**q, 'metric': 'gap'}).json()
    assert gap['start'] == gap['a']['start'] == gap['b']['start'] == '2017-01'
    assert gap['end'] == gap['a']['end'] == gap['b']['end'] == '2020-12'
    assert gap['comparison_cutoff'] == '2017-01-01'
    later = client.get('/api/v1/compare/measure', params={**q, 'start': '2018-01'}).json()
    assert later['start'] == later['a']['start'] == later['b']['start'] == '2018-01'
    assert later['comparison_cutoff'] is None


def test_filing_flow_uses_same_cutoff_intersection_for_both_courts(client):
    q = {'start': '2010-01', 'end': '2020-12',
         'a_district': 'Purba Medinipur', 'a_court': 'DJ',
         'b_district': 'Bankura', 'b_court': 'CJM'}
    d = client.get('/api/v1/compare/filing-flow', params=q).json()
    assert d['labels'][0] == '2017-01' and d['labels'][-1] == '2020-12'
    assert d['a']['start'] == d['b']['start'] == '2017-01'
    assert d['a']['end'] == d['b']['end'] == '2020-12'
    assert d['comparison_cutoff'] == '2017-01-01'
    assert any('Common comparison period: 2017-01–2020-12' in note for note in d['notes'])


def test_compare_measure_rejects_bad_input(client):
    base = {'metric': 'disposal', 'start': '2015-01', 'end': '2020-12', 'a_district': 'Bankura', 'a_court': 'DJ', 'b_district': 'Bankura', 'b_court': 'CJM'}
    assert client.get('/api/v1/compare/measure', params={**base, 'metric': 'nope'}).status_code == 404
    assert client.get('/api/v1/compare/measure', params={**base, 'b_court': 'XX'}).status_code == 404
    assert client.get('/api/v1/compare/measure', params={**base, 'start': '2020-12', 'end': '2015-01'}).status_code == 422
