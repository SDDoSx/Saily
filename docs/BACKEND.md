# The chart service

Saily is a static page and stays one. This is the single exception: building a chart for a **new area** means
fetching a coastline from Overpass and polygonising it, which a browser cannot do. Everything else — drawing a
route, checking it against land and the traffic scheme, exporting a passage — happens in the app with no
server at all.

You only need this if you are adding a passage somewhere Saily has no chart for yet. If you are editing a
route inside an area that already has one, close this page.

## Everything at once, locally

```
npm run dev
```

The app on `:8080`, the chart service on `:8787`, one ctrl-c stops both. The service is skipped with a note
if Python does not have shapely, because the app does not need it to run.

Then in the app: Setup → **Charts for new areas** → `http://localhost:8787` → **Test the service**. Draw a
route (map menu, the pencil), then **Passage JSON** → **Build a chart for this area**. The passage appears in
the picker when it is done.

## Everything in the cloud, without hosting anything

If you would rather not run a service at all, GitHub Actions already is one. Actions tab →
**Build a passage chart** → Run workflow → paste the JSON from the editor. It fetches the coastline, builds
the chart, checks every leg against it, commits the result and updates the catalogue; GitHub Pages redeploys
and the passage is in the app a couple of minutes later. Nothing to deploy, nothing to pay for.

A pull request that touches `passages/` gets the same treatment without committing: **Check a passage**
validates the data, builds the chart for real, and prints every leg's distance to land in the run summary.

## Run it yourself

```
pip install -r server/requirements.txt      # shapely, jsonschema, gunicorn
python3 -m server                            # http://127.0.0.1:8787
curl http://127.0.0.1:8787/health
```

`python3 -m server` uses the standard library and is meant for one person on a laptop. For anything exposed,
run the same application under a real WSGI server:

```
gunicorn --bind 0.0.0.0:8787 --workers 1 --threads 8 --timeout 120 server.wsgi:app
```

**One worker, on purpose.** Builds run as subprocesses tracked in the job directory, and a single worker keeps
the concurrency cap honest without a shared lock. Threads carry the polling, which is all the traffic there
is. To build more at once raise `SAILY_MAX_RUNNING`, do not add workers.

## Deploy it

The image is the whole deployment. Nothing else: no database, no queue, no object store.

```
docker build -f server/Dockerfile -t saily-chart-service .
docker run --rm -p 8787:8787 -v saily-jobs:/jobs saily-chart-service
# or
docker compose -f server/compose.yaml up --build
```

That image runs as-is on Fly.io, Render, Railway, Cloud Run, Scaleway, a Raspberry Pi or a VPS. Two of them
have a config in this repository already:

```
fly launch --config server/fly.toml --dockerfile server/Dockerfile --no-deploy
fly volumes create saily_jobs --size 1
fly deploy --config server/fly.toml --dockerfile server/Dockerfile
```

For Render, point a new Blueprint at the repository: it reads `server/render.yaml`. Both are configured to
scale to zero, because a build service is idle almost all the time; the first request after a sleep just
takes longer.

Whichever you pick, put the resulting URL into the app: Setup → Charts for new areas. It listens on
`$PORT` (default 8787), which is what every one of those platforms sets. Give it a writable volume at `/jobs`
if you want builds to survive a restart; without one they are simply lost, which costs a rebuild and nothing
else.

Sizing: 1 shared vCPU and 512 MB of RAM is enough for the bundled passage's area. Memory scales with the
bounding box, because polygonisation holds the coastline in memory. A build is 20 seconds to a few minutes,
almost all of it waiting on Overpass.

## Configuration

Every one is optional and has a sane default.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | Port for `python3 -m server` and the container |
| `SAILY_JOBS_DIR` | `./.jobs` | Where jobs and their output live |
| `SAILY_ALLOW_ORIGIN` | `*` | `Access-Control-Allow-Origin`. Set it to your app's origin once you know it |
| `SAILY_MAX_BBOX_DEG2` | `4.0` | Largest bounding box accepted, in square degrees. The bundled Strait passage is 0.92 |
| `SAILY_MAX_RUNNING` | `1` | Builds at once. Keep it low: every build is an Overpass query, and the mirrors are donated |
| `SAILY_MAX_QUEUED` | `4` | Jobs waiting before new ones are refused |
| `SAILY_MAX_BODY` | `1048576` | Largest request body |
| `SAILY_MAX_PLACES` | `12` | Places per passage; each one costs a detail polygon |
| `SAILY_MAX_WAYPOINTS` | `200` | Waypoints across all routes |
| `SAILY_BUILD_TIMEOUT` | `600` | Seconds before a build is killed |
| `SAILY_JOB_TTL` | `86400` | Seconds a finished job is kept before it is swept |

## The API

A build takes far too long to hold a request open, so it is a job: submit, poll, collect.

```
POST /v1/builds
     {"passage": {...}, "tss": {...}, "mirrors": ["https://..."]}
  -> 202 {"id": "…32 hex…", "state": "queued", "poll": "/v1/builds/<id>"}

GET  /v1/builds/<id>                 {"state": "queued|running|done|failed", "error": null, ...}
GET  /v1/builds/<id>/log             what the builder printed, including every leg's distance to land
GET  /v1/builds/<id>/chart-data.js   the chart
GET  /v1/builds/<id>/passage.js      the passage
GET  /v1/builds/<id>/bundle.json     both as one JSON, for the app to load in a single request
GET  /health                         liveness, current queue, and the limits above
```

`tss` is required when the passage names one. Both are checked by `tools/validate_passage.py` — the same
validator the build and CI run — before a job is created, so the service never accepts what the builder would
reject.

Worked example:

```
ID=$(curl -sS -X POST localhost:8787/v1/builds -H 'Content-Type: application/json' \
       -d "{\"passage\": $(cat passages/my-passage.json)}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

until [ "$(curl -sS localhost:8787/v1/builds/$ID | python3 -c 'import json,sys;print(json.load(sys.stdin)["state"])')" != running ]; do sleep 5; done

mkdir -p site/passages/my-passage
curl -sS -o site/passages/my-passage/chart-data.js localhost:8787/v1/builds/$ID/chart-data.js
curl -sS -o site/passages/my-passage/passage.js    localhost:8787/v1/builds/$ID/passage.js
```

Then add it to `site/passages/index.json` (`docs/ADAPTING.md` step 5) and the app offers it.

## Without the service

The service is a convenience, not a dependency. The same build, locally:

```
python3 tools/build_area.py passages/my-passage.json site/passages/my-passage
```

That is `tools/fetch_osm.py` followed by `tools/build_chart.py`, which is what the service runs in a
subprocess. If the service is down, or you would rather not run one, nothing is lost.

## What it does not do

- **No authentication.** It builds public data from public data. If you expose it, the bounding-box cap and
  the queue limits are what stand between you and an expensive afternoon; tighten them, and put it behind
  whatever your platform gives you.
- **It does not store your passage.** Jobs are swept after `SAILY_JOB_TTL`. Copy the output somewhere.
- **It does not verify your route.** The build prints every leg's distance to land and refuses nothing; the
  app's own check, and your eyes on a real chart, are what verify a route.

## Licensing

What comes back is derived from OpenStreetMap and is **ODbL 1.0**: attribution and share-alike apply, and a
chart built this way may only be redistributed under the ODbL. `/health` and `bundle.json` both say so. Read
`docs/LICENSING.md` before publishing one.

Be a good citizen of the Overpass mirrors: they are donated infrastructure. The defaults here are deliberately
conservative, and `tools/fetch_osm.py` identifies itself and backs off. Do not raise the limits to run a
scraper.
