"""Explicit calculations for the four-quadrant filing/disposal comparison."""
import calendar
import json
import math

from app.domain.statistics import months
from app.domain.comparison_period import shared_comparison_period

DISPOSAL_CONTOUR_LEVELS = (
    {'label': '6 months', 'months': 6},
    {'label': '1 year', 'months': 12},
    {'label': '2 years', 'months': 24},
    {'label': '2.5 years', 'months': 30},
    {'label': '3 years', 'months': 36},
    {'label': '5 years', 'months': 60},
)
WORKING_DAYS_PER_MONTH = 21


def _join_contour_segments(segments):
    """Join marching-squares segments into ordered polylines."""
    def point_key(point):
        return (round(point['x'], 9), round(point['y'], 9))

    connected = {}
    for index, (start, end) in enumerate(segments):
        connected.setdefault(point_key(start), []).append(index)
        connected.setdefault(point_key(end), []).append(index)
    remaining = set(range(len(segments)))
    lines = []
    while remaining:
        first = min(remaining)
        start, end = segments[first]
        if len(connected[point_key(end)]) == 1 and len(connected[point_key(start)]) != 1:
            start, end = end, start
        line = [start, end]
        remaining.remove(first)
        while True:
            candidates = [index for index in connected.get(point_key(line[-1]), ()) if index in remaining]
            if not candidates:
                break
            segment = segments[candidates[0]]
            next_point = segment[1] if point_key(segment[0]) == point_key(line[-1]) else segment[0]
            remaining.remove(candidates[0])
            line.append(next_point)
        lines.append(line)
    return lines


def _contour_lines(xs, ys, fitted, level):
    """Extract level curves from a rectangular smooth surface (marching squares)."""
    segments = []
    for row in range(len(ys) - 1):
        for column in range(len(xs) - 1):
            if any(
                fitted[grid_row][grid_column] is None
                for grid_row, grid_column in (
                    (row, column), (row, column + 1),
                    (row + 1, column + 1), (row + 1, column),
                )
            ):
                continue
            corners = [
                (xs[column], ys[row], fitted[row][column]),
                (xs[column + 1], ys[row], fitted[row][column + 1]),
                (xs[column + 1], ys[row + 1], fitted[row + 1][column + 1]),
                (xs[column], ys[row + 1], fitted[row + 1][column]),
            ]
            crossings = []
            for edge in range(4):
                first = corners[edge]
                second = corners[(edge + 1) % 4]
                if (first[2] < level <= second[2]) or (second[2] < level <= first[2]):
                    fraction = (level - first[2]) / (second[2] - first[2])
                    crossings.append((edge, {
                        'x': first[0] + fraction * (second[0] - first[0]),
                        'y': first[1] + fraction * (second[1] - first[1]),
                    }))
            if len(crossings) == 2:
                segments.append((crossings[0][1], crossings[1][1]))
            elif len(crossings) == 4:
                # Resolve a saddle from the bilinear center value. Pairing by
                # crossing-list order alone can join the wrong branches and
                # create spurious loops in otherwise smooth fitted contours.
                edge_points = {edge: point for edge, point in crossings}
                center_value = sum(corner[2] for corner in corners) / 4
                if (corners[0][2] < level) == (center_value < level):
                    edge_pairs = ((0, 1), (2, 3))
                else:
                    edge_pairs = ((0, 3), (1, 2))
                segments.extend((edge_points[first], edge_points[second]) for first, second in edge_pairs)
    return _join_contour_segments(segments)


def fit_empirical_disposal_contours(points, max_x, max_y, grid_size=41, bandwidth_fraction=0.16):
    """Fit case-count-weighted Gaussian-smoothed disposal contours.

    At each grid location, observed disposal times are averaged using Gaussian
    distance weights multiplied by each case type's disposed-case count.
    Marching squares turns each equal-duration level into plot polylines.
    """
    observations = []
    for point in points:
        sizes = point.get('sample_sizes') or {}
        weight = sizes.get('disposal', point.get('weight', 0))
        values = (point.get('x'), point.get('y'), point.get('disposalMean'), weight)
        try:
            x, y, disposal, weight = (float(value) for value in values)
        except (TypeError, ValueError):
            continue
        if all(math.isfinite(value) for value in (x, y, disposal, weight)) and weight > 0:
            observations.append((x, y, disposal, weight))
    if len(observations) < 4 or max_x <= 0 or max_y <= 0:
        return []

    min_x, max_observed_x = min(p[0] for p in observations), max(p[0] for p in observations)
    min_y, max_observed_y = min(p[1] for p in observations), max(p[1] for p in observations)
    bandwidth_x = max((max_observed_x - min_x) * bandwidth_fraction, max_x * 0.025, 1e-9)
    bandwidth_y = max((max_observed_y - min_y) * bandwidth_fraction, max_y * 0.025, 1e-9)
    xs = [max_x * index / (grid_size - 1) for index in range(grid_size)]
    ys = [max_y * index / (grid_size - 1) for index in range(grid_size)]
    fitted = []
    for y in ys:
        fitted_row = []
        for x in xs:
            weighted_total = 0.0
            weighted_disposal = 0.0
            for case_x, case_y, disposal, case_count in observations:
                distance = ((x - case_x) / bandwidth_x) ** 2 + ((y - case_y) / bandwidth_y) ** 2
                gaussian_weight = case_count * math.exp(-0.5 * distance)
                weighted_total += gaussian_weight
                weighted_disposal += gaussian_weight * disposal
            fitted_row.append(weighted_disposal / weighted_total if weighted_total else None)
        fitted.append(fitted_row)

    contours = []
    for duration in DISPOSAL_CONTOUR_LEVELS:
        # Disposal time is measured in observed court working days. Use a clear,
        # consistent approximation of 21 working days per calendar month.
        level = duration['months'] * WORKING_DAYS_PER_MONTH
        contours.append({
            'label': duration['label'],
            'value': level,
            'lines': _contour_lines(xs, ys, fitted, level),
        })
    return contours


def calculate_filing_comparison(repo, start, end, a, b, names=()):
    """Count calendar-month events, not disposals limited to the filing cohort.

    F[m] = cases whose filing date is in month m.
    D[m] = cases whose valid decision date is in month m, including older filings.
    Cumulative case load[m] = cumulative sum of F[m] - D[m], starting at zero.
    This is backlog change in the range, not the absolute number of pending cases.
    The two courts are matched by exact printed case-type name, not local codes.
    """
    period = shared_comparison_period(repo, start, end, (a, b))
    start, end = period['start'], period['end']
    labels = months(start, end) if start <= end else []
    sides = []
    volume = {}
    for district, court in (a, b):
        snapshot = repo.active(district)
        config = json.loads(snapshot['config'])
        court_meta = next(c for c in config['courts'] if c['id'] == court)
        first_month, last_month = max(start, config['start']), min(end, config['end'])
        counts = {}
        data = snapshot['courts'][court]
        known_names = {name for name, side in data.types.values() if side in ('Civil', 'Criminal')}
        if first_month <= last_month:
            first_day = first_month + '-01'
            year, month = map(int, last_month.split('-'))
            last_day = f'{last_month}-{calendar.monthrange(year, month)[1]}'
            # The CSV loader keeps one record per court/cino. Combine duplicate
            # local type codes sharing a printed name, exactly as for matching courts.
            for case in data.cases.values():
                name, side = data.types[case['type_code']]
                if side not in ('Civil', 'Criminal'):
                    continue
                filing, decision = case['filing'], case['decision']
                if filing and first_day <= filing <= last_day:
                    monthly = counts.setdefault(name, {'filings': {}, 'disposals': {}})['filings']
                    month = filing[:7]
                    monthly[month] = monthly.get(month, 0) + 1
                # No filing-window restriction: include older filings disposed in range.
                if filing and decision and filing <= decision and first_day <= decision <= last_day:
                    monthly = counts.setdefault(name, {'filings': {}, 'disposals': {}})['disposals']
                    month = decision[:7]
                    monthly[month] = monthly.get(month, 0) + 1
        for name, events in counts.items():
            volume[name] = volume.get(name, 0) + sum(events['filings'].values()) + sum(events['disposals'].values())
        sides.append({'district': district, 'court': court,
                      'label': f"{district} · {court_meta['label']}",
                      'start': first_month, 'end': last_month,
                      'known_names': known_names, 'counts': counts})

    ordered = sorted(volume, key=lambda name: (
        not all(name in s['known_names'] for s in sides), -volume[name], name))
    selected = [name for name in dict.fromkeys(names) if name in volume][:3] if names else ordered[:3]
    if not selected:
        selected = ordered[:3]
    options = [{'case_type': name, 'in_both': all(name in s['known_names'] for s in sides)} for name in ordered]
    notes = [
        'Filings are counted by filing month; disposals by decision month, including cases filed before the displayed range. Only Civil and Criminal cases with valid event dates are included.',
        'Cumulative case-load change = cumulative sum(monthly filings − monthly disposals), starting at 0. No opening pending count is added. The curve measures change in backlog, not the absolute pending total; negative values mean cumulative disposals exceed cumulative filings.',
        'Changing the date range resets the cumulative baseline to 0. Only available months are accumulated; unavailable months remain blank.',
        'Types are matched by exact printed name (duplicate codes with the same name are combined). Blank segments mean an unavailable month or a type not present at that court; zero means no events in an available month.',
    ]
    if period['comparison_cutoff']:
        notes.append(f"Common comparison period: {start}–{end}. Monthly filing and disposal counts are not cutoff-filtered; both courts are shown over the same months.")
    for side in sides:
        side['series'] = []
        for name in selected:
            events = side['counts'].get(name, {'filings': {}, 'disposals': {}})
            available = [side['start'] <= m <= side['end'] and name in side['known_names'] for m in labels]
            filings = [events['filings'].get(m, 0) if valid else None for m, valid in zip(labels, available)]
            disposals = [events['disposals'].get(m, 0) if valid else None for m, valid in zip(labels, available)]
            net_change = [f - d if f is not None and d is not None else None for f, d in zip(filings, disposals)]
            baseline = 0 if any(available) else None
            running_load = 0
            cumulative_load = []
            for change in net_change:
                if change is None:
                    cumulative_load.append(None)
                else:
                    running_load += change
                    cumulative_load.append(running_load)
            side['series'].append({'case_type': name, 'filings': filings, 'disposals': disposals,
                                   'net_change': net_change, 'baseline': baseline, 'cumulative_load': cumulative_load})
        if side['start'] > side['end']:
            notes.append(side['label'] + ': no data in the selected months.')
        elif (side['start'], side['end']) != (start, end):
            notes.append(f"{side['label']}: available months {side['start']}–{side['end']} only.")
        del side['known_names'], side['counts']
    return {'labels': labels, 'a': sides[0], 'b': sides[1], 'selected': selected,
            'case_type_options': options, 'notes': notes, 'units': 'events: cases / month; cumulative change: cases',
            'requested_start': period['requested_start'], 'requested_end': period['requested_end'],
            'comparison_cutoff': period['comparison_cutoff']}
