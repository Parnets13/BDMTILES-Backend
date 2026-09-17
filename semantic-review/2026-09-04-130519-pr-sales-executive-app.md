# Phone + OTP login and Sales Executive field app

Adds a phone-number + OTP login path for a new React Native field app (`BDMTILES-SalesApp`) and the backend surface it consumes. On the server this is a new `OtpChallenge` model (hashed codes, TTL expiry), two new auth endpoints (`/auth/otp/request`, `/auth/otp/verify`) that reuse the existing refresh-session and access-token issuance, and a new `/api/v1/sales-executive` router exposing dealer list, dealer insights, dashboard counters, and route plan — all self-scoped to the signed-in executive. The app implements the phone → OTP → token-in-MMKV → session flow, an axios 401 interceptor that drops the session, react-query data loading, and an auth/app navigation split. The approach reuses existing primitives (rate limiters, `createRefreshCredential`, `boundedSessions`, `getDealerCreditExposure`) rather than reinventing them.

Watch for: complaint counts are not branch-scoped on either SE endpoint even though `Complaint` carries a `branch` field and the rest of the metrics are branch-scoped — a confirmed cross-branch count leak. The "pending orders" metric is defined differently on the dashboard versus the insights screen (confirmed). The OTP verify screen can fire two verify requests for one code entry (likely). `OTP_EXPOSE_CODE` fails open — the code is returned in the API response unless the env var is explicitly `false` (confirmed).

**Verdict**: NEEDS_CHANGES

## High-level view

The OTP security posture holds up: codes are stored only as SHA-256 with the user id and JWT secret mixed in, challenges expire via a TTL index, per-challenge attempt caps and both request/verify rate limiters are wired, phone lookup is normalized on trailing digits, and login is restricted to the `sales_executive` role at both challenge creation and verification. Token issuance goes through the same path as password login, and the password `/login` handler is untouched, so the existing password flow does not regress. The deliberate gap is `OTP_EXPOSE_CODE` defaulting to `true`, which echoes the code in the response until SMS is provisioned — documented, but fail-open and easy to forget before production.

The SE endpoints scope reads to the executive for the dealer-owned data (`assignedSalesExecutive: req.user._id`) and reuse `getDealerCreditExposure` with the full lean dealer object. The branch-scoping is where the inconsistency lives: ledger, orders, and quotations are filtered by `req.branchId`, but complaint counts are queried by `dealer` alone. Because dealers are global and only ledger/orders/quotations/complaints are branch-scoped, a dealer active in more than one branch will have complaints from other branches counted into a single executive's view.

There is also a definitional mismatch in "pending orders": the dashboard counts orders where `salesExecutive` equals the current user, while the insights screen counts all open orders for the dealer regardless of who created them. The same-named metric means two different things across screens.

On the app side the data contracts line up with the backend response shapes and the infinite-scroll pagination and debounced search are correctly keyed. The notable app-side risk is the OTP verify screen invoking `verify()` from both the auto-submit-on-6th-digit path and the manual button without an in-flight guard.

<details>
<summary>Issues (5)</summary>

1. **Complaint counts ignore branch** — `salesExecutiveRoutes.js` counts complaints by `dealer` only on both `/me/dealers/:id/insights` and `/me/dashboard`; add `branch: req.branchId` to match the branch-scoped ledger/order/quotation queries.
2. **"Pending orders" defined two ways** — dashboard filters orders by `salesExecutive: req.user._id`; insights filters by `dealer: dealer._id`. Pick one definition so the count is consistent across screens.
3. **OTP verify double-submit** — `OtpVerifyScreen.verify()` can run twice (auto-submit on 6th digit plus the button) because it does not bail when already loading; guard the entry.
4. **`OTP_EXPOSE_CODE` defaults to on** — the generated code is returned in the API response unless the env var is explicitly `false`; ensure it is disabled in production before SMS goes live.
5. **Dashboard `totalOutstanding` vs list `branchOutstanding` naming** — the dashboard sums branch ledger into `totalOutstanding` while the list calls the same computation `branchOutstanding`; harmless but worth aligning to avoid confusion.

</details>

<details>
<summary>Details</summary>

### Complaint counts escape branch scope

Both SE endpoints treat every metric except complaints as branch-scoped, then query complaints globally by dealer:

```js
// insights
SalesOrder.countDocuments({ branch: req.branchId, dealer: dealer._id, status: {...} }),
Quotation.countDocuments({ branch: req.branchId, dealer: dealer._id, status: {...} }),
Complaint.countDocuments({ dealer: dealer._id, status: { $nin: TERMINAL_COMPLAINT_STATUSES } }),
```

`Complaint` carries `branch: { ref: 'Branch', index: true }` and is indexed on `{ branch, dealer, status }`, so the branch filter is both available and cheap. Dealers are global while complaints are branch-scoped, so a dealer transacting in two branches produces complaints under each branch; an executive scoped to one branch will see the union. The dashboard has the same omission (`Complaint.countDocuments({ dealer: { $in: dealerIds }, status: {...} })`). Add `branch: req.branchId` to both to align complaints with the orders/quotations/ledger scoping.

### "Pending orders" means different things per screen

The dashboard counts orders the executive personally owns:

```js
SalesOrder.countDocuments({ branch: req.branchId, salesExecutive: req.user._id, status: { $in: OPEN_ORDER_STATUSES } }),
```

The insights screen counts all open orders for the dealer, regardless of author:

```js
SalesOrder.countDocuments({ branch: req.branchId, dealer: dealer._id, status: { $in: OPEN_ORDER_STATUSES } }),
```

The dashboard uses `salesExecutive`; the per-dealer view uses `dealer`. Sharing the "pending orders" label across screens means a dealer's insights can show more pending orders than the executive would expect from their dashboard, or vice versa. Quotations scope by dealer on both screens, so those agree. Decide whether "pending orders" is "orders I created" or "open orders for this dealer" and apply it consistently.

### OTP verify can double-submit one code

`onChange` auto-submits when the input reaches six digits, and the "Verify & continue" button calls the same function:

```js
const onChange = (value: string) => {
  const next = value.replace(/[^\d]/g, '').slice(0, OTP_LENGTH);
  setCode(next);
  if (error) setError(undefined);
  if (next.length === OTP_LENGTH) verify(next);   // auto path
};
// ...
<Button label="Verify & continue" onPress={() => verify(code)} ... />  // manual path
```

`verify()` sets `loading` but never checks it on entry, so a fast tap on the button as the sixth digit lands sends two `/auth/otp/verify` requests for the same code. The second request lands after the first has consumed the challenge (`consumedAt` set, active challenges deleted), so it returns "invalid or expired", flips the screen into an error state, and clears the field even though login actually succeeded. `signIn` on the first response swaps the navigator to the app stack, so the user may briefly see the error before the switch. Guard `verify` with an `if (loading) return;` or disable the auto-path once a request is in flight.

### OTP_EXPOSE_CODE fails open

`OTP_EXPOSE_CODE` defaults to `'true'`, so `/auth/otp/request` returns `devOtp` and `expiresInSeconds` in the response body until the env var is explicitly set to `'false'`. It is documented in-code as interim behavior until DLT/SMS is provisioned, and the app surfaces it as a "Development OTP" banner, so the trade-off is deliberate. The risk is operational: a fail-open default means forgetting to set the flag in production ships an app where anyone who knows a registered phone number can read the OTP from the response. Track flipping this as a release gate.

### Password-login regression check

`/auth/otp/verify` mirrors the password login tail exactly — `createRefreshCredential`, `boundedSessions`, `user.save({ validateBeforeSave: false })`, `generateToken(user._id, user.role, user.tokenVersion || 0)`, `buildAuthUser`, `setRefreshCookie`. The password `/login` handler is untouched and the new endpoints are additive, so the OTP work does not alter existing password authentication.

### SE self-scoping

The insights query requires the dealer id to belong to the executive (`Dealer.findOne({ _id, assignedSalesExecutive: req.user._id })`) and returns 404 otherwise, so one executive cannot read another's dealer by guessing an id. `getDealerCreditExposure` receives the full populated lean `dealer` and `req.branchId`, matching the fields it reads (`dealer.creditDays`, `dealer._id`). The dashboard aggregates outstanding only over `myDealerIds(req.user._id)`. The list search escapes regex metacharacters before building the `RegExp`, so a term like `a.*` is matched literally rather than as a catch-all.

</details>

<details>
<summary>File map</summary>

- `models/OtpChallenge.js` — new: hashed OTP challenge with TTL expiry, attempt cap, and phone/consumed indexes.
- `routes/authRoutes.js` — new `/auth/otp/request` and `/auth/otp/verify` handlers plus their rate limiters; password login untouched.
- `routes/salesExecutiveRoutes.js` — new: SE dealer list, dealer insights, dashboard, and route-plan endpoints, self-scoped by user and branch.
- `server.js` — mounts `/api/v1/sales-executive`.
- `BDMTILES-SalesApp/src/lib/api.ts` — axios instance, request auth header, 401 interceptor.
- `BDMTILES-SalesApp/src/lib/storage.ts` — MMKV token/user/lastPhone stores.
- `BDMTILES-SalesApp/src/features/auth/*` — auth service, context/bootstrap, phone + OTP screens.
- `BDMTILES-SalesApp/src/features/dealers/*` — dealer service, list screen (infinite + search), insights screen.
- `BDMTILES-SalesApp/src/navigation/*` — auth/app split and stacks.

Full backend diff: `git diff main`.

</details>
