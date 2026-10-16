"""Find one month-aligned filing window shared by two court comparisons."""
import json


def _first_full_month_after(cutoff):
    """Return the first complete month in which all filings meet an ISO-date cutoff."""
    year, month, day = map(int, cutoff.split('-'))
    if day == 1:
        return f'{year:04}-{month:02}'
    month += 1
    if month == 13:
        year += 1
        month = 1
    return f'{year:04}-{month:02}'


def shared_comparison_period(repo, start, end, specs):
    """Intersect requested/data ranges, then align both courts after their latest cutoff.

    Comparison windows are whole calendar months. If a cutoff falls mid-month, the
    comparison begins the following month so both courts contribute the same months.
    """
    base_starts, ends, eligible_starts, cutoffs = [], [], [], []
    for district, court in specs:
        snapshot = repo.active(district)
        config = json.loads(snapshot['config'])
        base_starts.append(max(start, config['start']))
        ends.append(min(end, config['end']))
        cutoff = (config.get('listing_cutoffs') or {}).get(court)
        if cutoff:
            cutoffs.append(cutoff)
            eligible_starts.append(_first_full_month_after(cutoff))

    base_start = max(base_starts)
    common_start = max([base_start, *eligible_starts])
    common_end = min(ends)
    cutoff_applied = common_start > base_start and bool(cutoffs)
    comparison_cutoff = max(cutoffs, key=_first_full_month_after) if cutoff_applied else None
    return {
        'start': common_start,
        'end': common_end,
        'requested_start': start,
        'requested_end': end,
        'comparison_cutoff': comparison_cutoff,
    }
