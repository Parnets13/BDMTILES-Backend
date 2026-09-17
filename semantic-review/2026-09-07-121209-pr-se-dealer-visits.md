# Self-service dealer visits / route execution (SOW 18.2)

A new `DealerVisit` model plus four self-scoped executive endpoints let a sales executive check in at an assigned dealer, see their current open visit, browse their visit history, and check out with notes/outcome/next-follow-up. On the app side a Visits screen (list + active-visit banner), a check-in sheet driven from the dealer insights page, and a check-out screen wire the flow together over React Query. The design mirrors the existing attendance/collections self-service routes: `protect` + `requireBranch` + `requirePermission('se.route.plan')` on every endpoint, branch and `salesExecutive` scoping on every query, and dealer ownership asserted through `Dealer.assignedSalesExecutive`. The one-open-visit rule is enforced only in the route layer.

Watch for: the one-open-visit guard is a read-then-write with no unique index, so two concurrent check-ins can both open a visit and orphan one of them (**confirmed**, low likelihood but permanent bad state). Everything else — scoping, state guards, duration math, validation, navigation contracts — checks out.

**Verdict**: APPROVED

## High-level view

Scoping is consistent. Every read filters on `{ branch: req.branchId, salesExecutive: req.user._id }`, check-out additionally matches `_id` so an executive can never touch another executive's visit, and check-in resolves the dealer through `assertMyDealer` which requires `assignedSalesExecutive === req.user._id`. This is a separate model from LeadVisit and reuses no LeadVisit code, so there is no cross-system regression surface.

The one-open-visit invariant is the one soft spot. It is enforced by reading for an existing `checked_in` visit and returning 409 `VISIT_IN_PROGRESS` before creating a new one, with no partial unique index backing it, so the guard is racy under concurrent requests. The blast radius is small (a single executive double-tapping or a retry storm) and the app has a double-submit guard, but a stuck orphan visit is only recoverable by checking it out.

Duration, state guards, and validation hold up: check-out rejects any non-`checked_in` visit with 409, `durationMinutes` is floored at zero and rounded from the check-in timestamp, purpose is validated against the enum, and GPS is required on check-in (optional on check-out, matching the app UI). `req.user.name` is populated by `buildAuthUser` (User.name is required and not deselected), so transition `byName` is reliable.

The app data contracts line up with the response envelopes, cache invalidation hits both `['se','visits','list']` and `['se','visits','active']` on check-in and check-out, navigation params are typed, and every screen is registered.

<details>
<summary>Issues (2)</summary>

1. **Check-in race with no unique index** — two concurrent check-ins both pass the read-then-write guard and open two `checked_in` visits; the active banner only surfaces the newest, orphaning the other. Add a partial unique index on `{ salesExecutive, status }` where `status: 'checked_in'` and handle the resulting E11000 as a 409, matching the collections idempotency pattern already in this file. (low likelihood, permanent bad state — `routes/salesExecutiveRoutes.js` check-in handler; `models/DealerVisit.js`)
2. **Orphaned open visit is only self-recoverable** — check-out is scoped to a single `_id` and there is no path to close an executive's other open visits, so an executive left with two open visits (from the race above, or a client that lost the visit id) can only clear them one at a time. Minor; worth noting if the race is left unaddressed. (`routes/salesExecutiveRoutes.js` check-out handler)

</details>

<details>
<summary>Details</summary>

### Self, branch, and dealer scoping

Every endpoint is gated by `requirePermission('se.route.plan')` (registered in `config/permissions.js` and in the SE role default set) behind `protect` + `requireBranch` applied at the router root. The two list endpoints filter on `{ branch: req.branchId, salesExecutive: req.user._id }`; `active` adds `status: 'checked_in'`; check-out matches `{ _id, branch, salesExecutive }` so a forged visit id belonging to another executive resolves to 404 rather than leaking or mutating. Check-in resolves the target dealer through `assertMyDealer`, which requires `assignedSalesExecutive === req.user._id`, and stores the visit under the current branch context.

### One-open-visit guard and the check-in race

The guard reads for an existing `checked_in` visit and, if found, returns 409 with `code: 'VISIT_IN_PROGRESS'` and the open visit in `data`. The model comment is explicit that this is route-layer only — there is no unique index. Two check-ins racing (double-tap, offline retry, flaky network) can both observe "no open visit" and both `create`, leaving the executive with two `checked_in` rows. `GET /me/visits/active` sorts `checkInAt` descending and returns one, so the older visit becomes invisible in the banner and can only be closed by navigating to it directly.

The collections endpoint in this same file already demonstrates the fix: a unique key plus an E11000 catch that returns the winner. A partial unique index here —

```js
dealerVisitSchema.index(
  { salesExecutive: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'checked_in' } },
);
```

— makes the invariant real, with the existing 409 branch handling the duplicate-key error. Left as-is the window is small and a single user's problem, but the resulting state is not self-healing.

### Check-out state guard and duration

Check-out validates the object id, loads the visit under the self+branch filter, and rejects anything not `checked_in` with a 409 (`This visit is already ${status}`), so a completed or cancelled visit cannot be checked out twice and someone else's visit 404s. `durationMinutes` is `Math.max(0, Math.round((now - checkInAt) / 60000))`, flooring negatives (clock skew) at zero and rounding to whole minutes. `notes`, `outcome`, `nextFollowUpDate`, and `location` are optional; `nextFollowUpDate` returns 422 if it fails to parse. There is no upper bound or future-date check on `nextFollowUpDate` and no cap on an absurdly long open visit — neither breaks correctness, flagging only for completeness.

### Validation and GPS

`purpose` defaults to `sales` and is validated against `VISIT_PURPOSES`, which matches the model enum and the app's `VisitPurpose` union exactly. Check-in requires a valid `{lat,lng}` through `normalizeLocation` (accepts `lat/lng` or `latitude/longitude`, rejects non-finite) and returns 422 otherwise; only `lat`/`lng` are persisted to `checkInLocation`, dropping the `accuracy` the app sends, consistent with the schema. Check-out location is optional, matching the app's "(optional)" capture.

### App data contracts and cache invalidation

`VisitRecord`, `CheckInInput`, and `CheckOutInput` in `types.ts` match the `visitView` envelope and the two request bodies field-for-field, including the `dealer` union (`populated object | id | null`) that `visitView` can emit. Check-in (in `DealerInsightsScreen`) and check-out (in `VisitCheckOutScreen`) both invalidate `['se','visits','list']` and `['se','visits','active']`, so the banner and history refresh after either transition. The active-visit banner in `VisitsScreen` navigates to `VisitCheckOut` with `{ visitId, dealerName }`, typed in `AppStackParamList`; both screens are registered in `AppNavigator`.

### GPS error handling and double-submit on check-in

The check-in mutation calls `getCurrentCoordinates()` inside `mutationFn`, so a denied/timed-out fix throws `LocationError` and lands in `onError`, which checks `error instanceof LocationError` before the axios branch and shows a location-specific alert; the 409 `VISIT_IN_PROGRESS` branch offers a "Go to visits" action. The check-in sheet's submit is `disabled={submitting}` and the sheet closes on both success and error, and check-out guards with `disabled={mutation.isPending}`. The client-side guard narrows but does not close the server-side race above, since a network retry can still produce two in-flight check-ins.

</details>

<details>
<summary>File map</summary>

- `models/DealerVisit.js` — new model: lifecycle enum, purpose enum, check-in/out timestamps + locations, duration, transitions; three non-unique indexes. No unique index on the open-visit invariant.
- `routes/salesExecutiveRoutes.js` — four new endpoints appended (SOW 18.2 section): `GET /me/visits`, `GET /me/visits/active`, `POST /me/dealers/:id/visits/check-in`, `PATCH /me/visits/:id/check-out`; reuses existing `assertMyDealer` and `normalizeLocation`.
- `BDMTILES-SalesApp/src/features/visits/types.ts` — visit/pagination/input contracts.
- `BDMTILES-SalesApp/src/features/visits/visitService.ts` — API calls + purpose/label/format helpers.
- `BDMTILES-SalesApp/src/features/visits/VisitsScreen.tsx` — history list, infinite query, active-visit banner.
- `BDMTILES-SalesApp/src/features/visits/CheckInSheet.tsx` — purpose picker bottom sheet.
- `BDMTILES-SalesApp/src/features/visits/VisitCheckOutScreen.tsx` — notes/outcome/next-follow-up + optional location.
- `BDMTILES-SalesApp/src/features/dealers/DealerInsightsScreen.tsx` — "Check in" button, GPS capture, 409 + LocationError handling.
- `BDMTILES-SalesApp/src/navigation/{types.ts,AppNavigator.tsx}`, `src/features/more/MoreScreen.tsx` — nav params, screen registration, More entry.

Full diff: files are new/untracked; `git status --short` in each repo lists them (`?? models/DealerVisit.js`, `?? routes/salesExecutiveRoutes.js`, `src/features/visits/*`).

</details>
