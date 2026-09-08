#!/usr/bin/env python3
"""Work out what the "Build a passage chart" workflow was asked to build.

Either a passage pasted into the form (which is written into passages/ so the build and the commit have a
real file), or one already in the repository. Writes `passage` and `id` to $GITHUB_OUTPUT.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ID_RE = re.compile(r'^[a-z0-9][a-z0-9-]{1,48}$')


def fail(msg):
    print(f'::error::{msg}')
    sys.exit(1)


def main():
    pasted = (os.environ.get('PASSAGE_JSON') or '').strip()
    tss_pasted = (os.environ.get('TSS_JSON') or '').strip()
    path = (os.environ.get('PASSAGE_FILE') or '').strip()

    if pasted:
        try:
            pz = json.loads(pasted)
        except ValueError as e:
            fail(f'the pasted passage is not JSON: {e}')
        pid = pz.get('id')
        if not isinstance(pid, str) or not ID_RE.match(pid):
            fail(f'"id" must be lower-case letters, digits and hyphens; got {pid!r}')
        path = os.path.join('passages', pid + '.json')
        with open(os.path.join(ROOT, path), 'w', encoding='utf-8') as f:
            json.dump(pz, f, indent=2, ensure_ascii=False)
            f.write('\n')
        print(f'wrote {path} from the pasted JSON')
        if tss_pasted:
            try:
                tss = json.loads(tss_pasted)
            except ValueError as e:
                fail(f'the pasted traffic scheme is not JSON: {e}')
            tname = os.path.basename(pz.get('tss') or (pid + '.tss.json'))
            with open(os.path.join(ROOT, 'passages', tname), 'w', encoding='utf-8') as f:
                json.dump(tss, f, indent=2, ensure_ascii=False)
                f.write('\n')
            print(f'wrote passages/{tname} from the pasted JSON')
        elif pz.get('tss'):
            fail('the passage names a "tss" file, so paste it into the traffic scheme box too')
    elif path:
        # only inside passages/, and only a real file: this input becomes a shell argument
        norm = os.path.normpath(path)
        if not norm.startswith('passages' + os.sep) or not norm.endswith('.json') or '..' in norm.split(os.sep):
            fail(f'passage_file must be a .json inside passages/; got {path!r}')
        path = norm
        if not os.path.exists(os.path.join(ROOT, path)):
            fail(f'{path} does not exist in this repository')
        with open(os.path.join(ROOT, path), encoding='utf-8') as f:
            pz = json.load(f)
        pid = pz.get('id')
        if not isinstance(pid, str) or not ID_RE.match(pid):
            fail(f'{path}: "id" must be lower-case letters, digits and hyphens; got {pid!r}')
    else:
        fail('give either passage_json (pasted) or passage_file (already in the repository)')

    bbox = pz.get('bbox')
    if not (isinstance(bbox, list) and len(bbox) == 4):
        fail('"bbox" must be [south, west, north, east]')
    s, w, n, e = bbox
    area = (n - s) * (e - w)
    print(f'building {pid}: bbox {bbox} ({area:.2f} square degrees), '
          f'{len(pz.get("routes") or [])} route(s), {len(pz.get("places") or {})} place(s)')
    if area > 25:
        fail(f'that bounding box covers {area:.1f} square degrees. Overpass will refuse it and it would '
             f'take a very long time; split the passage.')

    out = os.environ.get('GITHUB_OUTPUT')
    if out:
        with open(out, 'a', encoding='utf-8') as f:
            f.write(f'passage={path}\nid={pid}\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
