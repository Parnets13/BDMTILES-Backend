# Self-service GPS attendance for the sales-executive app

Adds an employee-facing attendance flow: the app reads the current GPS fix and calls four new endpoints under `/api/v1/sales-executive/me/attendance` to view today's status, list recent history, and punch in/out. Punch-in derives lateness from the branch's `HrmsSettings` shift start plus grace, and when the punch lands past grace the server rejects with `422 LATE_REASON_REQUIRED` so the app can collect a reason and retry with the same coordinates. Records are written to the existing `Attendance` collection with `source: 'App'`, guarded by the existing unique `{branch, employee, date}` index. The admin HRMS attendance handlers are untouched.

Watch for: lateness and the daily record key are computed from the **server's local clock** (`new Date()` + `setHours`), so a server running in a non-IST timezone will miscompute `lateMinutes` and bucket punches under the wrong `date` (confirmed in code; impact depends on deploy TZ). Punch-out silently accepts a missing/invalid location while punch-in requires one — an intentional-looking asymmetry worth a second look (confirmed).

**Verdict**: NEEDS_CHANGES

## High-level view

The employee is resolved on every request from `req.user._id` plus `req.branchId` via `Employee.findOne({ userId, branchId })`, returning 404 when no profile is linked. All four routes sit behind `protect`, `requireBranch`, and `se.attendance.view`, and every query is scoped by both `branch` and the resolved `employee._id`; no id is ever accepted from the client, so an executive can only reach their own branch-local record.

Lateness is computed by parsing `HrmsSettings.defaultShiftStart` ("HH:MM", default 09:00), adding `graceMinutes` (default 15), and diffing against the punch time. The threshold is built with `Date.setHours`, which uses the server's local timezone rather than the branch's — the one substantive correctness risk in this change.

The double-punch guards are layered: an in-code `findOne` check returns 409 when `punchIn`/`punchOut` already exist, and the unique index backstops the race by turning a concurrent duplicate insert into a 409 via the `11000` handler.

On the app side, the `LATE_REASON_REQUIRED` round-trip reuses the exact coordinates captured on the first attempt (stored in `lateSheet.coords`) rather than re-reading GPS, and the mutation/button state prevents double submits. Query invalidation uses `['se','attendance','today']`, matching the dashboard card's key, so punching in or out refreshes the dashboard.

<details>
<summary>Issues (3)</summary>

1. **Server-timezone lateness and date bucketing** — `computeLateMinutes` and `startOfToday` use `new Date()`/`setHours`, i.e. server local time, not the branch timezone. On a UTC server serving IST branches, `lateMinutes` and the `date` key are wrong. Anchor both to a defined timezone at `routes/salesExecutiveRoutes.js:231` (`computeLateMinutes`) and `:206` (`startOfToday`).
2. **Punch-out location asymmetry** — punch-in requires a valid location (422 when absent) but punch-out stores location only `if (location)` and never rejects a missing/garbage fix (`routes/salesExecutiveRoutes.js:343`). If punch-out location is meant to be captured, enforce it symmetrically; if optional by design, confirm that's intended.
3. **Late-retry collides with the race backstop** — if a concurrent request creates the record between the first punch-in (which returned `LATE_REASON_REQUIRED`, `:311`) and the retry, the retry's `findOne` sees `punchIn` set and returns 409 "already punched in" (`:304`) instead of applying the reason. Narrow window, benign outcome, noted for awareness.

</details>

<details>
<summary>Details</summary>

### Lateness computation is anchored to server local time

```js
const punchInAt = new Date();                    // server clock
const threshold = new Date(punchInAt);
threshold.setHours(Number(match[1]), Number(match[2]), 0, 0);   // local TZ
threshold.setMinutes(threshold.getMinutes() + grace);
const diffMinutes = Math.floor((punchInAt.getTime() - threshold.getTime()) / 60000);
```

`defaultShiftStart` is a wall-clock string with no timezone, and `setHours` interprets it in the process timezone. A Node process on a UTC host will treat "09:00" as 09:00 UTC = 14:30 IST, so an IST executive punching in at 09:10 local (03:40 UTC) computes as *hours early* and never trips the grace check, while genuinely late punches may be missed or misreported. `startOfToday()` has the same dependency: the unique `{branch, employee, date}` key is a local-midnight `Date`, so the day boundary also shifts with server TZ. Both should be anchored to the branch's timezone (or a fixed business offset) so behavior doesn't change with where the server runs. This is the one finding that can produce wrong data rather than just a UX rough edge.

### Double-punch guards and the unique-index race

Punch-in rejects with 409 if `punchIn` is already set; punch-out rejects with 409 both when there is no punched-in record and when `punchOut` already exists. Under two truly concurrent punch-ins both can pass the in-code check, but only one `save` succeeds against the unique index — the loser throws `11000`, which the catch translates to `409 "Attendance already recorded for today."`

The late-reason retry is a *second* punch-in request. If some other request creates the day's record in the gap between the first attempt (which returned `LATE_REASON_REQUIRED` without saving) and the retry, the retry's `findOne` now sees `punchIn` set and returns 409 rather than persisting the reason. The window is small and the outcome (already punched in) is benign, so this is informational rather than blocking.

### Punch-out accepts a missing location

Punch-in calls `normalizeLocation` and returns `422` when it yields `undefined`. Punch-out calls the same normalizer but only stores the result `if (location)` and never rejects — a punch-out with no body, or with non-numeric `lat`/`lng`, succeeds and records `totalHours` with no `punchOutLocation`. The app always sends coordinates on punch-out, so this isn't reachable from the happy path, but the server contract is asymmetric with punch-in. Worth confirming whether punch-out geolocation is required (enforce it) or optional (leave as is); either is defensible, but it should be a decision rather than an accident.

### App round-trip, double-submit, and cache keys

The `LATE_REASON_REQUIRED` handler stores the coordinates from the failed attempt in `lateSheet.coords` and the sheet's submit path calls `punchInMutation.mutate({ location: lateSheet.coords, lateReason })` — the same fix is reused, so the retry can't drift to a new location or trigger a second GPS read. Double-submit is covered on both surfaces: the main buttons pass `loading={busy}` where `busy = locating || punchInMutation.isPending || punchOutMutation.isPending`, and the shared `Button` sets `disabled` whenever `loading` is true; the sheet's `Button` disables on `submitting` and its `submit()` early-returns while submitting. Both `AttendanceScreen.refresh()` and the dashboard read `['se','attendance','today']`, so a punch performed on the screen invalidates the dashboard card's cache. Location failures surface as typed `LocationError`s (permission/unavailable/timeout) shown via `Alert` without firing a mutation, so a denied or failed fix never sends a punch request.

</details>

<details>
<summary>File map</summary>

- `models/Attendance.js` — adds `lateReason` string field; `source` enum already includes `'App'`, unique `{branch,employee,date}` index already present.
- `routes/salesExecutiveRoutes.js` (new, untracked) — four `/me/attendance/*` endpoints plus helpers (`resolveEmployee`, `normalizeLocation`, `computeLateMinutes`, `attendanceView`, `startOfToday`).
- `server.js` — mounts `salesExecutiveRoutes` at `/api/v1/sales-executive`.
- `src/lib/location.ts` (app) — Android permission request + `getCurrentCoordinates` with typed `LocationError`.
- `src/features/attendance/{types,attendanceService,LateReasonSheet,AttendanceScreen}.tsx` (app) — types, API client, late-reason modal, main screen.
- `src/features/home/DashboardScreen.tsx` (app) — attendance quick-action card keyed on `['se','attendance','today']`.
- `src/navigation/AppNavigator.tsx` (app) — registers the `Attendance` stack screen.

Full diff: backend tracked changes via `git diff` (`models/Attendance.js`, `server.js`); `routes/salesExecutiveRoutes.js` is untracked, read in full. App files read in full (SalesApp shares a git root with unrelated projects, so `git diff` is not a usable scope here).

</details>
