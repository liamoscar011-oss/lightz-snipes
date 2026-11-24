---
name: lightz-snipes-raceday
description: Load and refresh Oscar's Lightz Snipes horse-racing app from Sportsbet - night-before race cards, race-morning prices and scratchings, late price checks before each race, and evening results. Use for scheduled race-day runs or when Oscar asks to load, refresh or fix Lightz Snipes cards, odds, late prices or results.
---

# Lightz Snipes race-day update

Lightz Snipes is Oscar's betting-analysis app. Its home is **https://liamoscar011-oss.github.io/lightz-snipes/** (code in the GitHub repo `liamoscar011-oss/lightz-snipes`, data in his own Supabase database). The old Claude version, artifact `9fcf2655-59c8-48ec-b4ca-91630e6045cb`, is now the backup: only write there when the new app can't be used (see Fallback).

This skill fills the app's race data from Sportsbet, which Oscar bets with, by reading Sportsbet pages in the **built-in browser** on his computer (the cloud workspace can't reach Sportsbet or Supabase). Writes go through the app itself, open and signed in, in a second tab of the same browser.

There are four jobs. Work out which one from the request or schedule prompt; if unclear, use Perth time: evening before a race day = **night**, race-day morning = **morning**, during the racing = **late**, race-day evening = **results**.

| Job | When | Writes |
|---|---|---|
| night | ~6:30pm Perth the evening before | `cards/<id>` for every race (once) + `days/<date>` |
| morning | ~8am Perth on race day | `odds/<date>` (prices, scratchings, track) |
| late | hourly, ~9am-7pm Perth on race day | `odds/<date>` for the races jumping in the next 8-70 minutes |
| results | ~8:30pm Perth on race day | `results/<date>` |

Dates are Perth dates (YYYY-MM-DD). Race ids are `<date>_<venue-slug>_r<no>`, e.g. `2026-11-21_kembla-grange_r4`.

## Ground rules

- Only read Sportsbet pages. Never log in there, click bet buttons, add to a bet slip or touch Oscar's Sportsbet account.
- Never type, read or ask for Oscar's passwords. If the app shows its sign-in screen, he has to sign in himself; use the Fallback for this run.
- Read Sportsbet data from the page as loaded (`window.__PRELOADED_STATE__`) with the stored reader script. Don't call Sportsbet's internal API URLs with `fetch`: one ordinary page load per race is enough and stays polite.
- Australian thoroughbred meetings only (the reader returns NZ too, flagged `nz: true`; skip those unless Oscar asks for NZ).
- **Cards are written once.** After the night load, don't rewrite `cards/*` for that day; later changes go in the small `odds/` and `results/` docs, which the app lays over the cards.

## 1. Set up the browser

1. Load the built-in browser tools in one ToolSearch call (`mcp__remote-devices__Claude_Browser__`, max_results 64) and read the `built-in-browser` skill if listed. If the browser can't be reached, stop: report that Oscar's computer looks asleep/offline or the Claude app is closed, and that the next run will catch up.
2. **App tab:** `preview_start` with `https://liamoscar011-oss.github.io/lightz-snipes/`, wait about 3 seconds, then run `window.lsWhoami && window.lsWhoami()` with `javascript_tool`. You need `{signedIn: true}`. Anything else: use the Fallback below for the writes (the Sportsbet reading is the same).
3. **Sportsbet tab:** `preview_start` with `https://www.sportsbet.com.au/racing-schedule/horse/today`.
4. Check the reader is installed in the Sportsbet tab: `localStorage.lsxv` must match the `lsxv` in `tools/raceday` (currently `"7"`). If not, get the setter text from the app tab with `(await window.lsGet('tools/raceday')).setter` (Fallback: `db_get tools/raceday` on the artifact) and run that text exactly, with `javascript_tool`, in the Sportsbet tab.

The reader runs in the Sportsbet tab as `new Function('mode', localStorage.lsx)(MODE)` and returns a JSON string:
- `'day'` on a schedule/results page -> `{meetings: [{date, venue, slug, races, nz, urls: [path per race]}], results: {raceId: [1st, 2nd, 3rd, ...]}}`
- `'card'` on a race page -> a full card in the app's format
- `'odds'` on a race page -> `{id, track, scr: [numbers], px: {n: [win, place]}}`
- `'result'` on a run race's page -> `{id, status, fin: [[n, place, margin, SP, name, silk], ...first four]}` (margins appear on Sportsbet a while after the race; until then they are empty)

Read many races per round trip with `browser_batch`: pairs of `navigate` (full URL `https://www.sportsbet.com.au` + path) and `javascript_tool` running the reader, about 8 races per batch. If one race returns `err`, retry it once on its own, then skip it and mention it.

**Writing (app tab, `javascript_tool`, all async):**
- `await lsGet('days/2026-11-25')` -> the doc's data, or `null`
- `await lsList('cards', 'date', '2026-11-25')` -> ids of that day's cards
- `await lsWrite([{op: 'set', path: 'cards/<id>', data: {...}}, ...])` -> `{written, deleted}`. Ops: `set` (whole doc), `merge` (fields into the existing doc), `delete`. Put about 20 cards per call; the data travels inside the script text.
- `await lsUpcoming(8, 70)` -> today's races jumping in 8-70 minutes that weren't refreshed in the last 10 minutes: `[{id, path, jumps, mins, label}]`
- `await lsLate(D, {<raceId>: {track, scr, px}, ...}, note)` -> saves fresh prices into `odds/D` (keeps the other races and a short price history per runner) and returns `{written, refreshed, bets: [{race, jumps, n, horse, bet, odds, stake, edge, isNew}], watch: [{race, jumps, horse, now, needs}]}`. `isNew` = a bet not reported by an earlier morning or late run.

## 2. Night job (load cards for date D)

1. In the Sportsbet tab, navigate to `/racing-schedule/D` (or `/racing-schedule/tomorrow`) and run `'day'`. Keep meetings with `date == D` and `nz == false`. No meetings = fields aren't out yet: stop and report that.
2. `lsGet('days/D')` and `lsList('cards', 'date', D)`. Meetings that already have cards are done: don't reload them. If every meeting is loaded, do the morning job for D instead.
3. Set states so cards are tagged correctly, in the Sportsbet tab: `localStorage.lsstates = JSON.stringify({<slug>: '<NSW|VIC|QLD|SA|WA|TAS|ACT|NT>', ...})` for every meeting (from your knowledge of Australian tracks; Ascot, Belmont, Pinjarra, Bunbury, Northam and Esperance are WA).
4. Read every race with `'card'` (batches as above).
5. Write the cards with `lsWrite` op `set` on `cards/<id>`, data = the card exactly as returned.
6. Write `days/D` with `set`: `{date: D, meetings: [{venue, slug, state, track, races}], note: "Loaded <Tue|Fri> night from Sportsbet", updatedAt: <ISO now>}`. `races` = number of cards for that meeting, `track` from its first card; sort meetings by races, most first. Keep meetings already in the old `days/D`.
7. Do the Promos step for D.

## 3. Morning job (prices and scratchings for D, usually today)

1. If `days/D` doesn't exist, run the night job for D first, then continue.
2. Navigate to `/racing-schedule/D` (today: `/racing-schedule/horse/today`) and run `'day'` to get fresh race URLs for the meetings in `days/D`.
3. Read `'odds'` for every race that hasn't started yet.
4. Save them in the app tab with `JSON.stringify(await lsLate(D, {<raceId>: {track, scr, px}, ...}, "Sportsbet prices, <day> <time> Perth"))` (drop the `id` field from each reader result; it's the key). It keeps races you didn't refresh. In the Fallback, write `odds/D` with `set` instead: `{date: D, updatedAt: <ISO now>, note, races: {<raceId>: {track, scr, px}}}`, keeping the old doc's other races.
5. Do the Promos step for D.
6. Summary: also list the day's bets from the `lsLate` result (horse, race, time, bet, stake), most edge first, up to 6.

## Late job (price check in the hour before each race)

Morning prices miss late money and late scratchings. This job refreshes only the races about to jump, so Watch horses that drift out to the price they need become bets in time. It runs hourly on race days, so each race gets one check 8-70 minutes before it jumps. It must stay quick and quiet.
1. Set up as in section 1, but the app tab **must** be signed in (no Fallback for this job): if `lsWhoami()` isn't `{signedIn: true}`, reply in one line that the app isn't signed in on his computer's Claude browser and stop.
2. In the app tab: `JSON.stringify(await lsUpcoming(8, 70))` and `JSON.stringify(await lsFinished(8))` (races that have run but have no finish saved). Both empty: reply "No races in the next hour" and stop. Don't open Sportsbet and don't notify.
3. In the Sportsbet tab (reader check as in section 1), read `'odds'` for each race: navigate to `https://www.sportsbet.com.au` + `path`, then run the reader (use `browser_batch` for several races). If a `path` is empty, get the race URLs from `'day'` on `/racing-schedule/horse/today`.
4. Save with `JSON.stringify(await lsLate(D, {<raceId>: {track, scr, px}, ...}, "Late Sportsbet prices, <time> Perth"))` in the app tab, D = today's Perth date.
   For each race from `lsFinished`, read `'result'` on its `path` (only keep it when `status` is `RESULTED`) and save them all with `JSON.stringify(await lsResults(D, {<raceId>: {fin}, ...}, "Sportsbet results, <time> Perth"))`. This puts the finish line (first four, silks, margins) on each run race straight away; mention the count in the one-line reply.
5. Bets with `isNew: true` are the point of this job. If there are any, send one push notification (the `PushNotification` tool, if this session has it) under 200 characters, e.g. `New bet: Starward #4, Rosehill R8 12:50pm, Win $9.80, bet $3` (up to 2 bets, then "+N more in the app"), and start the reply with the same lines. Otherwise reply in one line, e.g. "Refreshed 3 races, no new bets", and don't notify.
6. Never place, suggest placing or add bets anywhere: Oscar places them himself.

## Promos step (end of the night and morning jobs)

Bookies only show promos inside an account, so the app's Promos tab uses a public daily list of racing offers. Only read the page: no sign-ups, logins or clicks on any offer.
1. `preview_start` with `https://www.justhorseracing.com.au/promotions`.
2. Run this with `javascript_tool` in that tab (it reads list pages 1-3 of the same public site, about 60 offers):
   `const pick = doc => [...doc.querySelectorAll('article.postcontent')].map(a => { const l = a.querySelector('h2 a'), img = a.querySelector('.bologo img'), src = img ? img.getAttribute('src') || '' : ''; return { title: l ? l.textContent.trim() : '', url: l ? new URL(l.getAttribute('href'), location.origin).href : '', book: (src.match(/bmlogos\/([a-z0-9]+)/i) || [])[1] || '', text: ((a.querySelector('p') || {}).textContent || '').trim().slice(0, 400) }; }).filter(x => x.title); let all = pick(document); for (const n of [2, 3]) { try { const h = await (await fetch('/promotions/page/' + n + '/')).text(); all = all.concat(pick(new DOMParser().parseFromString(h, 'text/html'))); } catch (e) {} } const seen = new Set(); JSON.stringify(all.filter(x => x.url && !seen.has(x.url) && seen.add(x.url)).slice(0, 90))`
3. Write `promos/D` with `set`: `{date: D, updatedAt: <ISO now>, source: "justhorseracing.com.au", items: <the array>}`. The app drops offers for other weekdays and sorts them into bet returns, boosts and other. If the page fails or returns nothing, skip this step and say so in the summary.

## 4. Results job (date D, usually today)

1. Navigate to `/racing-schedule/results/today` (a past day: `/racing-schedule/results/D`; Sportsbet only keeps about 9 days) and run `'day'`.
2. Keep results whose id starts with `D_` and whose venue slug is in `days/D`.
3. `lsGet('results/D')`, then write `results/D` with `set`, merging old and new entries:
   `{date: D, updatedAt: <ISO now>, note: "Sportsbet results, <day> <time> Perth", r: {<raceId>: [1st, 2nd, 3rd]}}`
   Dead heats come through flattened (e.g. `6,[7,5],1` -> `[6,7,5,1]`); that's fine.
   Then the finishes: `JSON.stringify(await lsFinished(0, D, true))` lists the run races with no finish saved or no margins yet. Read `'result'` on each `path` (about 8 races per `browser_batch`) and save with `lsResults(D, {<raceId>: {fin}, ...}, note)`. It keeps the `r` entries and adds `f`.
4. Catch-up: if the previous race day (Wed or Sat) has `days/` but no `results/` doc and is under 9 days old, do it too.
5. The app settles Oscar's logged bets from these results automatically.

## Fallback: the old Claude version

If the app tab isn't signed in or won't load, do the same job against the artifact `9fcf2655-59c8-48ec-b4ca-91630e6045cb` database instead: `db_get` in place of `lsGet`, `db_write` op `set` in place of `lsWrite` (up to 25 ops per call, one call at a time, ~2s apart; an existing doc needs the `ifVersion` from its `db_get`; on `version_mismatch`, `db_get` it again and retry). Then say in the summary that the new app wasn't signed in on his computer's Claude browser, so this update went to the old Claude version, and he should open https://liamoscar011-oss.github.io/lightz-snipes/ in the Claude app's browser and sign in once.

## 5. Finish

Reply with 2-4 lines: what was loaded (meetings, races, results count), anything skipped or failed, and when the next run is (the late job replies in one line unless there's a new bet). Don't keep retrying Sportsbet if pages keep failing: report and stop.

## Data shapes the app reads

- `days/<date>`: `{date, meetings: [{venue, slug, state, track, races}], note, updatedAt}`
- `cards/<id>`: `{id, date, venue, state, track, no, dist, name, start (ISO UTC), status: 'open', jump: null, result: null, url, tips: [n], onpace: [n], scr: ["n Name"], runners: [{n, name, bar, wt, form, j, t, flucs, win, place, tags, fu?, ks?, silk?, esp?, cm?, ls?, prep?, spd?}], updatedAt}` (`ks`: the form guide's key stats, e.g. `{"Track": "2:1-0-1", "Distance": "5:2-1-0"}`; `silk`: Sportsbet's silks image URL; `esp`: expected settling position for the speed map; `cm`: the form comment, which the app reads for last-start trouble such as slow away, held up or raced wide; `ls`: last race start, trials skipped, `{d, tk, pl, of, mg, cl}` (`cl` = its class, e.g. BM58, Cls 1, Mdn); `prep`: runs this campaign before today (0 = first-up); `spd`: Sportsbet's early-speed figure; all optional)
- `odds/<date>`: `{date, updatedAt, note, races: {id: {track, scr: [n], px: {"n": [win, place]}, h?: {"n": [[minute, win], ...]}, at?}}}` (`h` and `at` come from `lsLate`: price history and when that race was last refreshed)
- `results/<date>`: `{date, updatedAt, note, r: {id: [n, n, n]}, f?: {id: [[n, place, margin, SP, name, silk], ...first four]}}` (`f` feeds the finish line on each run race)
- `tools/raceday`: `{setter, lsxv}` - the one-line script that installs the Sportsbet reader into the browser (`localStorage.lsx`, version `lsxv = "7"`). The app hands out the newest setter when the saved one is older.
- `promos/<date>`: `{date, updatedAt, source, items: [{title, url, book, text}]}` - bookie offers from the public list, shown on the Promos tab.
- `calendar/<date>` is an old week-view index; optional.
