#!/usr/bin/env python3
"""Regenerate site/passage.js from a passage JSON file, without the chart.

tools/build_chart.py rebuilds the chart and the passage together, which needs the OpenStreetMap extracts
in a scratch directory. Passage metadata -- titles, notes, time zones, checklists, route legs -- needs
none of that, so editing a label should not mean re-fetching a coastline.

Usage: build_passage.py [passage.json] [site/passage.js]
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    build_chart = _load('build_chart', 'tools/build_chart.py')
    validate_passage = _load('validate_passage', 'tools/validate_passage.py')

    passage_file = argv[0] if argv else build_chart.DEFAULT_PASSAGE
    out = argv[1] if len(argv) > 1 else os.path.join(ROOT, 'site', 'passage.js')

    reports = validate_passage.validate_files(passage_file)
    bad = False
    for rep in reports:
        for line in rep.lines():
            print(line)
        if rep.errors:
            bad = True
    if bad:
        sys.exit('validation failed; passage.js not written')

    import json
    with open(passage_file, encoding='utf-8') as f:
        PZ = json.load(f)
    passage_out = dict(PZ)
    passage_out['routes'] = build_chart.build_routes(PZ)
    passage_out['labels'] = PZ.get('labels', [])
    pjs = build_chart.render_passage_js(passage_out)
    with open(out, 'w', encoding='utf-8') as f:
        f.write(pjs)
    print(f'wrote {out}: {len(pjs)} bytes, {len(passage_out["routes"])} route(s)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
