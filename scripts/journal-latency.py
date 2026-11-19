#!/usr/bin/env python3
"""Per-route request latency from Agent Tower's JSON request logs.

Usage:

    timeout 120 journalctl -u agent-tower -o cat --since "-2 hours" --no-pager \\
        | python3 -I scripts/journal-latency.py [--pid PID] [--top N] [--markdown]

Input:
    The server's Fastify (pino) JSON log lines on standard input, one object
    per line. Lines that are not JSON objects are skipped. An "incoming
    request" line and a "request completed" line are joined by (pid, reqId);
    Fastify restarts its reqId counter with every process, so the pid is part
    of the key. Requests whose other half lies outside the input are counted
    as unmatched and left out.

Options:
    --pid PID     Only use lines from this server process.
    --top N       Print the N routes with the most total time (default 40,
                  0 prints all).
    --markdown    Print Markdown tables instead of aligned text.

Report 1, per route:
    Count, share of all joined requests, p50, p90, p99, max and total time.
    The time is Fastify's responseTime in milliseconds. Percentiles use the
    nearest-rank method; p90 needs at least 10 requests and p99 at least 100,
    otherwise "-" is printed.

Report 2, interference:
    The latency of plain requests, split by what else was in flight at any
    moment between their start and their end:
      - process-starting requests: /api/git/*, /api/workspaces/:id/git-status,
        /api/providers and below;
      - log-heavy requests: /api/sessions/:id/logs, any .../translations, and
        /api/message-deliveries with scopeType=SESSION.
    Plain requests are GET and HEAD requests outside both classes, without
    the preview proxy (/view/*), static assets (/assets/*) and long waits
    (.../wait). Some plain routes may still start a process now and then, so
    the split shows interference; it does not prove its cause.

Route normalisation and privacy:
    - UUIDs and 8-character hex ids become ":id", numbers become ":n".
    - Free-form path parts become placeholders: service names (":name"),
      visualisation files (":file"), provider ids (":id"), the preview proxy
      ("/view/:id/*") and static assets ("/assets/*"). Any other path segment
      that is not a plain route word becomes ":param".
    - Query strings are dropped, with three exceptions that only ever print
      known enumeration values: scopeType and filter for /message-deliveries,
      type for /git/diff, and first versus later page for .../translations.
    - No other query value, host name, address or request id is printed.

Read-only, standard library only. Bound the journal read with timeout.
"""

import argparse
import bisect
import json
import math
import re
import sys
from datetime import datetime
from urllib.parse import parse_qs

UUID_RE = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
HEX8_RE = re.compile(r'^[0-9a-fA-F]{8}$')
DIGITS_RE = re.compile(r'^[0-9]+$')
ROUTE_WORD_RE = re.compile(r'^[A-Za-z][A-Za-z0-9_-]{0,47}$')

# The segment after these literal segments is a name chosen by a user or an agent.
NAME_AFTER = {'services': ':name', 'visualizations': ':file'}
# Literal sub-routes of /api/providers; any other segment there is a provider id.
PROVIDER_LITERALS = {'backup', 'capabilities', 'import', 'preview', 'reload', 'test'}

# Query values that may be printed, per route, and only these values.
DELIVERY_SCOPE_TYPES = {'SESSION', 'CONVERSATION', 'TEAM_TASK'}
DELIVERY_FILTERS = {'pending', 'sent'}
DIFF_TYPES = {'uncommitted', 'committed'}


def allowed(value, choices):
    return value if value in choices else 'other'


def first_value(query, name):
    values = query.get(name)
    return values[0] if values else None


def normalise_path(path):
    segments = path.split('/')
    if len(segments) > 2 and segments[1] == 'view':
        return '/view/:id/*'
    if len(segments) > 2 and segments[1] == 'assets':
        return '/assets/*'
    out = []
    previous = ''
    for index, segment in enumerate(segments):
        if segment == '':
            norm = ''
        elif UUID_RE.match(segment) or HEX8_RE.match(segment):
            norm = ':id'
        elif previous in NAME_AFTER:
            norm = NAME_AFTER[previous]
        elif previous == 'providers' and index == 3 and segments[1] == 'api' and segment not in PROVIDER_LITERALS:
            norm = ':id'
        elif DIGITS_RE.match(segment):
            norm = ':n'
        elif ROUTE_WORD_RE.match(segment):
            norm = segment
        else:
            norm = ':param'
        out.append(norm)
        previous = segment
    return '/'.join(out) or '/'


def normalise(method, url):
    """Return the printable route label for one request."""
    path, _, raw_query = url.partition('?')
    path = path.split('#', 1)[0]
    route = normalise_path(path)
    label = f'{method} {route}'
    if not raw_query:
        query = {}
    else:
        query = parse_qs(raw_query, keep_blank_values=True)
    if route == '/api/message-deliveries':
        parts = []
        scope_type = first_value(query, 'scopeType')
        if scope_type is not None:
            parts.append('scopeType=' + allowed(scope_type, DELIVERY_SCOPE_TYPES))
        delivery_filter = first_value(query, 'filter')
        if delivery_filter is not None:
            parts.append('filter=' + allowed(delivery_filter, DELIVERY_FILTERS))
        if parts:
            label += '?' + '&'.join(parts)
    elif route == '/api/git/diff':
        diff_type = first_value(query, 'type')
        if diff_type is not None:
            label += '?type=' + allowed(diff_type, DIFF_TYPES)
    elif route.endswith('/translations'):
        label += ' (later page)' if first_value(query, 'cursor') else ' (first page)'
    return route, label


def is_process_starting(route):
    return (route.startswith('/api/git/')
            or route.endswith('/git-status')
            or route == '/api/providers'
            or route.startswith('/api/providers/'))


def is_log_heavy(route, label):
    return (route == '/api/sessions/:id/logs'
            or route.endswith('/translations')
            or (route == '/api/message-deliveries' and 'scopeType=SESSION' in label))


def is_plain(method, route):
    if method not in ('GET', 'HEAD'):
        return False
    if route.startswith('/view/') or route == '/assets/*' or route.endswith('/wait'):
        return False
    return True


def percentile(sorted_values, q, minimum):
    if len(sorted_values) < max(1, minimum):
        return None
    rank = max(0, math.ceil(q * len(sorted_values)) - 1)
    return sorted_values[rank]


def fmt_ms(ms):
    if ms is None:
        return '-'
    if ms < 10:
        return f'{ms:.1f} ms'
    if ms < 1000:
        return f'{ms:.0f} ms'
    if ms < 100_000:
        return f'{ms / 1000:.1f} s'
    return f'{ms / 1000:,.0f} s'


def fmt_total(ms):
    seconds = ms / 1000
    return f'{seconds:.1f} s' if seconds < 10 else f'{seconds:,.0f} s'


def fmt_time(epoch_ms):
    return datetime.fromtimestamp(epoch_ms / 1000).astimezone().isoformat(timespec='seconds')


def summary_row(durations, share_of):
    values = sorted(durations)
    return [
        f'{len(values):,}',
        f'{100 * len(values) / share_of:.1f}%' if share_of else '-',
        fmt_ms(percentile(values, 0.50, 1)),
        fmt_ms(percentile(values, 0.90, 10)),
        fmt_ms(percentile(values, 0.99, 100)),
        fmt_ms(values[-1] if values else None),
        fmt_total(sum(values)),
    ]


def print_table(headers, rows, markdown, right_from=1):
    if markdown:
        print('| ' + ' | '.join(headers) + ' |')
        print('|' + '|'.join('---' if i < right_from else '---:' for i in range(len(headers))) + '|')
        for row in rows:
            print('| ' + ' | '.join(cell.replace('|', '\\|') for cell in row) + ' |')
        return
    widths = [max(len(str(r[i])) for r in [headers] + rows) for i in range(len(headers))]
    for row in [headers] + rows:
        cells = []
        for i, cell in enumerate(row):
            cells.append(str(cell).ljust(widths[i]) if i < right_from else str(cell).rjust(widths[i]))
        print('  '.join(cells).rstrip())


def read_requests(stream, pid_filter):
    incoming = {}
    completed = {}
    skipped_lines = 0
    pids = {}
    for line in stream:
        line = line.strip()
        if not line.startswith('{'):
            skipped_lines += 1
            continue
        try:
            record = json.loads(line)
        except ValueError:
            skipped_lines += 1
            continue
        if not isinstance(record, dict):
            continue
        msg = record.get('msg')
        if msg not in ('incoming request', 'request completed'):
            continue
        pid = record.get('pid')
        if pid_filter is not None and pid != pid_filter:
            continue
        req_id = record.get('reqId')
        time_ms = record.get('time')
        if req_id is None or not isinstance(time_ms, (int, float)):
            continue
        key = (pid, req_id)
        if msg == 'incoming request':
            req = record.get('req') if isinstance(record.get('req'), dict) else {}
            method = req.get('method')
            url = req.get('url')
            if not isinstance(method, str) or not isinstance(url, str):
                continue
            incoming[key] = (time_ms, method.upper(), url)
            pids[pid] = pids.get(pid, 0) + 1
        else:
            response_time = record.get('responseTime')
            completed[key] = (time_ms, response_time if isinstance(response_time, (int, float)) else None)
    requests = []
    for key, (start, method, url) in incoming.items():
        done = completed.get(key)
        if done is None:
            continue
        end, response_time = done
        duration = response_time if response_time is not None else max(0, end - start)
        route, label = normalise(method, url)
        requests.append({
            'start': start,
            'end': max(end, start + duration) if response_time is None else start + duration,
            'duration': duration,
            'method': method,
            'route': route,
            'label': label,
        })
    unmatched_incoming = sum(1 for key in incoming if key not in completed)
    unmatched_completed = sum(1 for key in completed if key not in incoming)
    return requests, pids, skipped_lines, unmatched_incoming, unmatched_completed


def overlap_index(intervals):
    """Sorted starts plus a running maximum of ends, for fast overlap checks."""
    intervals = sorted(intervals)
    starts = [start for start, _ in intervals]
    running_max = []
    highest = float('-inf')
    for _, end in intervals:
        highest = max(highest, end)
        running_max.append(highest)
    return starts, running_max


def overlaps(index, start, end):
    starts, running_max = index
    position = bisect.bisect_left(starts, end) - 1
    return position >= 0 and running_max[position] > start


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--pid', type=int, help='only use lines from this server process')
    parser.add_argument('--top', type=int, default=40, help='routes to print, by total time (0 = all)')
    parser.add_argument('--markdown', action='store_true', help='print Markdown tables')
    args = parser.parse_args()

    requests, pids, skipped, unmatched_in, unmatched_out = read_requests(sys.stdin, args.pid)
    if not requests:
        print('No joined requests found. Check the journal command and --pid.', file=sys.stderr)
        return 1

    first = min(r['start'] for r in requests)
    last = max(r['end'] for r in requests)
    print(f'Window: {fmt_time(first)} to {fmt_time(last)} ({(last - first) / 3_600_000:.2f} h)')
    print('Server processes: ' + ', '.join(f'pid {pid}: {count:,} requests' for pid, count in sorted(pids.items(), key=lambda item: str(item[0]))))
    print(f'Joined requests: {len(requests):,}; unmatched: {unmatched_in:,} without completion, '
          f'{unmatched_out:,} without start; non-JSON lines skipped: {skipped:,}')
    if len(pids) > 1 and args.pid is None:
        print('Note: several server processes; use --pid to look at one of them.')
    print()

    by_route = {}
    for request in requests:
        by_route.setdefault(request['label'], []).append(request['duration'])
    ranked = sorted(by_route.items(), key=lambda item: sum(item[1]), reverse=True)
    if args.top > 0:
        shown = ranked[:args.top]
    else:
        shown = ranked
    print(f'Per route, by total time ({len(shown)} of {len(ranked)} routes)')
    headers = ['Route', 'Count', 'Share', 'p50', 'p90', 'p99', 'Max', 'Total']
    rows = [[label] + summary_row(durations, len(requests)) for label, durations in shown]
    print_table(headers, rows, args.markdown)
    print()

    spawn_index = overlap_index([(r['start'], r['end']) for r in requests if is_process_starting(r['route'])])
    logs_index = overlap_index([(r['start'], r['end']) for r in requests if is_log_heavy(r['route'], r['label'])])
    groups = {'nothing heavy': [], 'process-starting only': [], 'log-heavy only': [], 'both': []}
    plain_count = 0
    for request in requests:
        if is_process_starting(request['route']) or is_log_heavy(request['route'], request['label']):
            continue
        if not is_plain(request['method'], request['route']):
            continue
        plain_count += 1
        spawn = overlaps(spawn_index, request['start'], request['end'])
        logs = overlaps(logs_index, request['start'], request['end'])
        if spawn and logs:
            groups['both'].append(request['duration'])
        elif spawn:
            groups['process-starting only'].append(request['duration'])
        elif logs:
            groups['log-heavy only'].append(request['duration'])
        else:
            groups['nothing heavy'].append(request['duration'])
    print(f'Plain requests by what was in flight at the same time ({plain_count:,} plain requests)')
    headers = ['In flight', 'Count', 'Share', 'p50', 'p90', 'p99', 'Max', 'Total']
    rows = [[name] + summary_row(durations, plain_count) for name, durations in groups.items()]
    print_table(headers, rows, args.markdown)
    return 0


if __name__ == '__main__':
    sys.exit(main())
