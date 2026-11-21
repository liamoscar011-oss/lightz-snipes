# Lightz Snipes

Race-day picks, prices and a bet tracker, as an installable web app.

- `index.html` - the app
- `standalone.js` - sign-in, data sync with Supabase, backup import, and the hooks the race-day updates use
- `config.js` - the Supabase project address and publishable key (safe to publish; the database only lets each signed-in user see their own rows)
- `sw.js`, `manifest.webmanifest`, `icons/` - install to home screen and open without signal
- `vendor/supabase.js` - supabase-js 2.119.2
