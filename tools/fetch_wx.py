#!/usr/bin/env python3
"""Fetch an Open-Meteo forecast snapshot for the passage weather points.

The snapshot is what tools/build_single.py embeds in the single-file build, so a boat that opens
dist/saily.html with no network still sees a forecast (marked as of its fetch time, and stale once old).

Usage: fetch_wx.py <passage.json> <out.json> [--days 5]

Weather data by Open-Meteo.com, CC BY 4.0 (https://open-meteo.com/). Keep the attribution.
"""
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FC_VARS = ('wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,precipitation,'
           'temperature_2m,weather_code,cloud_cover')
MARINE_VARS = ('wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,'
               'swell_wave_period,wind_wave_height,ocean_current_velocity,ocean_current_direction,'
               'sea_level_height_msl')
# The five points and the timezone default to weather.js's own defaults when the passage omits them.
DEFAULT_POINTS = [
    {'id': 'soto', 'name': 'Sotogrande offing', 'lat': 36.27, 'lon': -5.24, 'routeNm': 0.5},
    {'id': 'europa', 'name': 'Europa Point / Strait east', 'lat': 36.08, 'lon': -5.36, 'routeNm': 12.5},
    {'id': 'tarifa', 'name': 'Tarifa', 'lat': 35.97, 'lon': -5.62, 'routeNm': 27.3},
    {'id': 'cross', 'name': 'Mid-crossing (TSS)', 'lat': 35.92, 'lon': -5.70, 'routeNm': 34.5},
    {'id': 'tangier', 'name': 'Tangier Bay', 'lat': 35.81, 'lon': -5.77, 'routeNm': 43.0},
]
DEFAULT_TZ = 'Europe/Madrid'


def get_json(url, timeout=20, retries=3):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'saily-fetch-wx/1.0', 'Accept': 'application/json'})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            last = e
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
    raise SystemExit(f'{url}\n  failed after {retries} tries: {last}')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('passage')
    ap.add_argument('out')
    ap.add_argument('--days', type=int, default=5)
    a = ap.parse_args(argv)

    with open(a.passage, encoding='utf-8') as f:
        pz = json.load(f)
    points = pz.get('weatherPoints') or DEFAULT_POINTS
    tz = (pz.get('tz', {}).get('from', {}) or {}).get('zone') or DEFAULT_TZ

    snap = {'fetchedAt': int(time.time() * 1000), 'points': {}}
    for p in points:
        fc = get_json('https://api.open-meteo.com/v1/forecast?' + urllib.parse.urlencode({
            'latitude': p['lat'], 'longitude': p['lon'], 'hourly': FC_VARS, 'daily': 'sunrise,sunset',
            'wind_speed_unit': 'kn', 'timezone': tz, 'forecast_days': a.days}))
        mar = get_json('https://marine-api.open-meteo.com/v1/marine?' + urllib.parse.urlencode({
            'latitude': p['lat'], 'longitude': p['lon'], 'hourly': MARINE_VARS,
            'cell_selection': 'sea', 'timezone': tz, 'forecast_days': a.days}))
        snap['points'][p['id']] = {'fc': fc, 'mar': mar}
        hours = len(fc.get('hourly', {}).get('time', []))
        print(f"{p['id']}: {hours} hourly rows, {fc['hourly']['time'][0]} .. {fc['hourly']['time'][-1]}")

    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(snap, f, separators=(',', ':'))
    print(f"wrote {a.out}: {len(snap['points'])} points")
    return 0


if __name__ == '__main__':
    sys.exit(main())
