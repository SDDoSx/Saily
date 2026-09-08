#!/usr/bin/env python3
"""Keep site/passages/index.json in step with what is actually built.

The catalogue is what boot.js reads to decide which passages the app offers. Adding one by hand is two
lines of JSON and easy to get subtly wrong, so this does it: from the passage file, pointing at the files
the build wrote.

    catalogue.py list
    catalogue.py add passages/<id>.json [--default] [--title "Short -> Name"]
    catalogue.py remove <id>
    catalogue.py check                  every entry has its files, every built passage has an entry
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, 'site')
INDEX = os.path.join(SITE, 'passages', 'index.json')


def read():
    if not os.path.exists(INDEX):
        return []
    with open(INDEX, encoding='utf-8') as f:
        return json.load(f)


def write(entries):
    os.makedirs(os.path.dirname(INDEX), exist_ok=True)
    with open(INDEX, 'w', encoding='utf-8') as f:
        json.dump(entries, f, indent=2, ensure_ascii=False)
        f.write('\n')


def entry_for(pz, title=None, default=False):
    pid = pz['id']
    return {
        'id': pid,
        'title': title or pz.get('title') or pz.get('name') or pid,
        'name': pz.get('name') or pid,
        'description': pz.get('description') or '',
        **({'default': True} if default else {}),
        'chart': f'passages/{pid}/chart-data.js',
        'passage': f'passages/{pid}/passage.js',
    }


def cmd_add(a):
    with open(a.passage, encoding='utf-8') as f:
        pz = json.load(f)
    pid = pz.get('id')
    if not pid:
        sys.exit(f'{a.passage}: no "id"')
    d = os.path.join(SITE, 'passages', pid)
    missing = [n for n in ('chart-data.js', 'passage.js') if not os.path.exists(os.path.join(d, n))]
    if missing and not a.force:
        sys.exit(f'site/passages/{pid}/ is missing {", ".join(missing)}; build it first '
                 f'(tools/build_area.py or docs/BACKEND.md), or pass --force')

    entries = [e for e in read() if e.get('id') != pid]
    new = entry_for(pz, a.title, a.default)
    if a.default:
        for e in entries:
            e.pop('default', None)
    entries.append(new)
    # the default first, then alphabetical, so the file stays readable as it grows
    entries.sort(key=lambda e: (not e.get('default'), e['id']))
    write(entries)
    print(f'catalogue: {pid} ({new["title"]}){" as the default" if a.default else ""}; {len(entries)} passage(s)')
    return 0


def cmd_remove(a):
    entries = read()
    kept = [e for e in entries if e.get('id') != a.id]
    if len(kept) == len(entries):
        sys.exit(f'{a.id} is not in the catalogue')
    if not kept:
        sys.exit('that is the only passage; the app needs at least one')
    if not any(e.get('default') for e in kept):
        kept[0]['default'] = True
    write(kept)
    print(f'catalogue: removed {a.id}; {len(kept)} passage(s)')
    return 0


def cmd_list(_a):
    entries = read()
    if not entries:
        print('the catalogue is empty')
        return 0
    for e in entries:
        mark = ' (default)' if e.get('default') else ''
        ok = all(os.path.exists(os.path.join(SITE, e[k])) for k in ('chart', 'passage'))
        print(f'{"  " if ok else "! "}{e["id"]:<28} {e.get("title", "")}{mark}{"" if ok else "   FILES MISSING"}')
    return 0


def cmd_check(_a):
    entries = read()
    problems = []
    if not entries:
        problems.append('the catalogue is empty')
    ids = [e.get('id') for e in entries]
    if len(set(ids)) != len(ids):
        problems.append(f'duplicate ids: {ids}')
    if sum(1 for e in entries if e.get('default')) > 1:
        problems.append('more than one entry is marked default')
    for e in entries:
        for k in ('id', 'title', 'chart', 'passage'):
            if not e.get(k):
                problems.append(f'{e.get("id", "?")}: missing "{k}"')
        for k in ('chart', 'passage'):
            p = e.get(k)
            if p and not os.path.exists(os.path.join(SITE, p)):
                problems.append(f'{e.get("id")}: {p} does not exist')
        if p and not str(e.get('chart', '')).startswith(f'passages/{e.get("id")}/'):
            problems.append(f'{e.get("id")}: chart path does not match the id')
    # a built passage nobody can reach is almost always a forgotten catalogue line
    base = os.path.join(SITE, 'passages')
    for d in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        full = os.path.join(base, d)
        if os.path.isdir(full) and os.path.exists(os.path.join(full, 'chart-data.js')) and d not in ids:
            problems.append(f'site/passages/{d}/ is built but not in the catalogue')
    for p in problems:
        print('catalogue: ' + p, file=sys.stderr)
    print(f'catalogue: {len(entries)} passage(s), {len(problems)} problem(s)')
    return 1 if problems else 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd')
    a = sub.add_parser('add'); a.add_argument('passage'); a.add_argument('--title'); a.add_argument('--default', action='store_true'); a.add_argument('--force', action='store_true')
    r = sub.add_parser('remove'); r.add_argument('id')
    sub.add_parser('list')
    sub.add_parser('check')
    args = ap.parse_args(argv)
    return {'add': cmd_add, 'remove': cmd_remove, 'list': cmd_list, 'check': cmd_check}.get(args.cmd, lambda _a: (ap.print_help() or 2))(args)


if __name__ == '__main__':
    sys.exit(main())
