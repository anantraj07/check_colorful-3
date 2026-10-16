from app.components.calculations import fit_empirical_disposal_contours
from app.components.complexity import calculate
from app.components.types import Options


def _case_type_points():
    points = []
    for x in (1.0, 2.0, 3.0, 4.0, 5.0):
        for y in (1.0, 2.0, 3.0, 4.0, 5.0):
            points.append({
                'x': x,
                'y': y,
                'disposalMean': 100 + 120 * (x - 3) ** 2 + 80 * (y - 3) ** 2,
                'sample_sizes': {'disposal': int(10 + x * 5 + y * 2)},
            })
    return points


def test_fits_weighted_equal_disposal_contour_polylines():
    contours = fit_empirical_disposal_contours(_case_type_points(), 5.75, 5.75)

    assert [contour['label'] for contour in contours] == ['6 months', '1 year', '2 years', '2.5 years', '3 years', '5 years']
    assert [contour['value'] for contour in contours] == [126, 252, 504, 630, 756, 1260]
    assert all(contour['value'] > 100 for contour in contours)
    assert all(len(line) >= 2 for contour in contours for line in contour['lines'])
    assert all(
        0 <= point['x'] <= 5.75 and 0 <= point['y'] <= 5.75
        for contour in contours for line in contour['lines'] for point in line
    )


def test_returns_no_contours_when_too_few_case_types_can_support_a_surface():
    assert fit_empirical_disposal_contours(_case_type_points()[:3], 5.75, 5.75) == []


def test_uses_case_type_disposal_sample_size_as_the_case_weight():
    points = _case_type_points()
    unweighted = [dict(point, sample_sizes={'disposal': 1}) for point in points]
    original_fit = fit_empirical_disposal_contours(points, 5.75, 5.75)
    equal_weight_fit = fit_empirical_disposal_contours(unweighted, 5.75, 5.75)

    assert original_fit != equal_weight_fit


def test_component_keeps_the_fit_based_on_all_case_types_when_bubbles_are_filtered():
    points = _case_type_points()
    arrivals = [
        {'code': str(index), 'case_type': f'Type {index}', 'side': 'Civil', 'filings': 100 - index}
        for index in range(len(points))
    ]
    measures = {
        'hearings': [
            {'code': code, 'mean': point['x'], 'n': 20}
            for code, point in zip((row['code'] for row in arrivals), points)
        ],
        'case_rate_mo': [
            {'code': code, 'mean': point['y'], 'n': 20}
            for code, point in zip((row['code'] for row in arrivals), points)
        ],
        'monthly_rate': [
            {'code': row['code'], 'mean': point['x'] + point['y'], 'n': 20}
            for row, point in zip(arrivals, points)
        ],
        'disposal': [
            {'code': row['code'], 'mean': point['disposalMean'], 'n': point['sample_sizes']['disposal']}
            for row, point in zip(arrivals, points)
        ],
    }

    class Context:
        def __init__(self):
            self.arrivals = arrivals

        def measure(self, metric):
            return measures[metric]

    result = calculate(Context(), Options(types=('0',)))
    all_fit_points = [
        {
            'x': point['x'], 'y': point['y'], 'disposalMean': point['disposalMean'],
            'sample_sizes': point['sample_sizes'],
        }
        for point in points
    ]

    assert [point['code'] for point in result['points']] == ['0']
    assert result['max_x'] > result['points'][0]['x']
    assert result['max_y'] > result['points'][0]['y']
    assert result['contours'] == fit_empirical_disposal_contours(all_fit_points, result['max_x'], result['max_y'])
