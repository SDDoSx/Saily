# Native packaging (optional)

The PWA is the primary target. A native wrapper is only worth it for two things iOS Safari cannot do:
GPS updates with the screen off, and reliable background audio. If you need them:

1. `npm i -D @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android`
2. `npx cap init Saily org.saily.app --web-dir site`
3. Add `@capacitor-community/background-geolocation` and replace `navigator.geolocation.watchPosition` in
   `site/app.js` (`startGps`) with the plugin's watcher when `window.Capacitor` is present; keep the web path as fallback.
4. `npx cap add ios && npx cap open ios`, set the Location "Always" usage strings and the audio background mode.

Keep the web build working; the wrapper must not fork the app.
