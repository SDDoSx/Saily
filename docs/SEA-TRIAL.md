# The first sea trial

Everything in Saily has been verified in simulation: a replay harness drives every route through the real
guards at 3, 5 and 22 knots and checks the alert sequence. Nothing has been on the water. This is the page
for changing that, and for making the trip produce something you can use afterwards.

## The day before, on wifi

1. Open the app **from the Home Screen icon**, not from Safari. The installed app has its own storage; a
   preload done in Safari does not help it.
2. **Plan, Before you go**: run **Preload everything**. About 1300 tiles, roughly 25 MB, a few minutes.
3. Watch **Ready for sea** on the same page go green: app cached, tiles cached, forecast age, location
   permission, wake lock, sound.
4. **Airplane mode, then open the app.** It must show the chart, the route and the hazards. If it does not,
   the preload did not finish — do it again before you go anywhere.
5. **Setup, Boat**: set your cruise speed, fuel burn and draft. The archetypes are a starting point, not
   your boat, and every ETA and fuel figure comes from these.
6. **Weather**: check the verdict and the departure windows. The header now says if any forecast points came
   from the cache rather than the network.

## On the day

- Phone on deck with a clear view of the sky, plugged in, screen on. iOS only delivers GPS while the page is
  in front.
- Take a paper copy: **Plan, Briefing** has a printable pilotage card with courses, distances, dangers,
  lights and VHF channels.
- Tell someone ashore your plan and your ETA. The app is not a person.

## What to watch, and write down

This is the trial. The app now records each completed leg by itself — distance, time, the speed you actually
made, the speed it expected in those conditions, and the conditions — but the things it cannot see are worth
a note on your phone:

- **Alerts.** Did a lane, zone or hazard alert fire when you wanted it, or too late to act on? Was anything
  spoken that you could not hear, or that talked over something more important?
- **The screen.** Readable in sunlight? At night, did the red mode preserve your night vision? Could you
  read the numbers at a glance from where the phone was mounted?
- **Anything that surprised you.** An alert that made no sense where you were is more useful to me than a
  hundred that did.
- **The GPS.** Any dropouts, jumps, or a position that lagged the boat.

## Afterwards

**Plan, Log.** Every leg you sailed is there, with what the app expected beside what you did. If the boat was
consistently off the prediction, there is a button to correct your cruise speed from the passage itself,
weighted by leg distance. That single number feeds the route planner, the departure ranking, every ETA and
the fuel estimate, so it is the most valuable thing the trial produces.

Legs are only recorded when the boat could plausibly have sailed them: a GPS jump, a phone that slept
through the middle of a leg, or a waypoint skipped by hand are dropped rather than averaged in, because
calibration data that lies is worse than none.

**Copy as text** puts the whole log on the clipboard.

## Please keep in mind

Saily is an aid. It is built on an OpenStreetMap coastline, which is a shoreline and not a chart: no
soundings, no depth areas, no official buoyage, no legal standing. The traffic scheme is transcribed from
the IMO circular but the scheme in force is the one on the official chart. Carry the chart, keep a lookout,
and obey the COLREGs. For a first trial, pick a short passage in daylight and fair weather in water you
already know — you are testing the app, not the sea.
