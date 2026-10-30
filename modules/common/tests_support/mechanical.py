"""Deterministic observed-time fixtures, with no hardware claims."""
EPOCH = 'd669e2b4-0b92-4c92-9110-17a840e66c11'
SPAN = '154d214f-c095-4aa0-80d5-dc97665b39df'


def quiet_snapshot(now, start=1_699_999_000_000, end=None, span=SPAN):
    end = now if end is None else end
    return {'state': {'version': 'mechanical-context-v1', 'epoch': EPOCH,
        'publishedAtMs': now, 'confirmedThroughMs': end, 'validUntilMs': end + 10000,
        'blockedUntilMs': 0, 'cleanSinceMs': start, 'spanId': span, 'reasons': [],
        'commandAtMs': None, 'commandUntilMs': 0},
        'spans': [{'id': span, 'epoch': EPOCH, 'startMs': start, 'endMs': end}]}
