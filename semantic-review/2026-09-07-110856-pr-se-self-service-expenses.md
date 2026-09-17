# Self-service expense claims for the Sales Executive app

Adds three self-scoped expense endpoints to `salesExecutiveRoutes.js` (list, stats, submit) gated on `sales.executive.app`, plus the React Native feature (`ExpensesScreen`, `SubmitExpenseScreen`, service/types) and navigation wiring in the SalesApp. A sales executive can now file a claim from the field with optional GPS, browse their own history with status/category filters and infinite pagination, and see pending/reimbursed rollups. The claim lands as `status: 'pending'` in the shared `Expense` collection, where the existing admin approval workflow picks it up untouched. Watch for: a "Dealer / trip reference" input on the submit screen that only ever populates `dealerRef` and silently drops `tripRef` (confirmed); no upper bound on `expenseDate`, so future-dated claims are accepted (confirmed); and unvalidated `status`/`category` list filters that fall through to an empty result rather than a 422 (confirmed, low impact).

**Verdict**: APPROVED

## High-level view

The three endpoints resolve the caller's `Employee` by `{userId, branchId}` and scope every query by `{branch, employee}`, so there is no path for one executive to read another's claims or cross a branch boundary. Absence of a linked employee profile is a clean 404 on all three.

The permission choice is correct and deliberate: the `sales_executive` role carries `sales.executive.app` but not `expense.management`. The self-service routes gate on the former, the admin routes in `expenseRoutes.js` gate on the latter, and the two mount on different base paths (`/api/v1/sales-executive` vs `/api/v1/expenses`). There is no collision and no change to the admin routes, so no regression risk to the existing approval flow.

Submit validation mirrors the model: the category allow-list is identical to the schema enum, amount must be finite and positive, description is required, and an invalid date is rejected. The claim is forced to `pending` with `createdBy` set server-side, so a client cannot self-approve or spoof ownership. The one soft spot is that `expenseDate` has no upper bound, so future-dated claims pass.

`expenseNumber` is generated through the shared atomic branch counter, backed by a unique `{branch, expenseNumber}` index, with duplicate-key errors mapped to a 409 retry. Concurrent submissions are safe.

The app contracts line up with the response envelopes, the list uses `hasMore`-driven infinite pagination with a stats refetch on pull, and submit has a double-submit guard plus cache invalidation on both query keys. GPS capture failures are caught and surfaced without blocking submission. The remaining gaps are a dropped `tripRef` and permissive list filters.

<details>
<summary>Issues (3)</summary>

1. **Dropped tripRef on submit** — `SubmitExpenseScreen` labels the reference field "Dealer / trip reference" but maps it only to `dealerRef`; `SubmitExpenseInput` has no `tripRef` field, so trip references are silently stored as dealer references. Either relabel the field to "Dealer reference" or add a separate `tripRef` input and thread it through the type and service. (`SubmitExpenseScreen.tsx`, `types.ts`)
2. **No upper bound on expenseDate** — `POST /me/expenses` accepts any parseable date, including far-future dates. Consider rejecting `expenseDate` beyond today (allowing for timezone skew). (`salesExecutiveRoutes.js`, POST handler)
3. **Unvalidated list filters** — `status`/`category` query params on `GET /me/expenses` are passed straight into the filter; an invalid value returns an empty page instead of a 422. Low impact since the query stays self-scoped, but validating against the known enums would make the API predictable. (`salesExecutiveRoutes.js`, list handler)

</details>

<details>
<summary>Details</summary>

### expenseDate has no upper bound

Submit validation matches the model in every dimension except one: `expenseDate` is rejected only when unparseable, so a future date passes. For a reimbursement claim a future date is almost always a mistake; an upper bound keyed to "today" (with a little timezone slack) would close it. The category allow-list was verified identical to the schema `enum` in `models/Expense.js` (all fourteen values), amount is rejected unless finite and `> 0`, description is required, and `gpsLocation` is sanitized through `normalizeLocation` before persistence.

### expenseNumber generation under concurrency

`generateBranchNumber(branchId, 'expense', expenseDate)` increments a per-branch, per-document-type, per-fiscal-year counter with a single atomic `findOneAndUpdate({ $inc }, { upsert: true, new: true })`. The `Expense` schema enforces `{ branch: 1, expenseNumber: 1 }` unique, and the POST handler maps error code `11000` to a 409 retry, so even a collision rejects the second write rather than duplicating. The self-service and admin submit paths share the same counter bucket, which is intended — one expense sequence per branch regardless of who files the claim.

### List filters fall through silently

`if (status) filter.status = status` and the equivalent for `category` pass raw query strings into the Mongo filter with no allow-list check. An unknown value doesn't error; it just matches nothing and returns an empty page. The blast radius is nil because the filter is already pinned to the caller's own records, but validating `status` against the five schema statuses and `category` against the category set would turn a confusing empty result into an explicit 422.

### Dropped tripRef on the submit screen

The submit screen renders a single "Dealer / trip reference (optional)" input whose value flows into `dealerRef`; `SubmitExpenseInput` has no `tripRef`, and the backend defaults `tripRef` to `''`. A user who types a trip reference there gets it stored as a dealer reference. Not a security or stability issue, but the label promises something the payload doesn't deliver — either narrow the label or add a real `tripRef` field. The rest of the app contracts match the envelopes: `data.data`/`data.pagination` line up with the `{ success, data, pagination }` responses, infinite pagination is driven by `pagination.hasMore` with a guarded `fetchNextPage`, pull-to-refresh refetches list and stats, the submit mutation is guarded against double-fire, and success invalidates both `['se','expenses','list']` and `['se','expenses','stats']`.

</details>

<details>
<summary>File map</summary>

- `BDMTILES-Backend/routes/salesExecutiveRoutes.js` — three self-scoped expense endpoints (list, stats, submit) appended after the attendance block.
- `BDMTILES-Backend/models/Expense.js` — unchanged; source of truth for the category enum, status enum, and unique `{branch, expenseNumber}` index referenced above.
- `BDMTILES-Backend/routes/expenseRoutes.js` — unchanged admin CRUD/approval routes; verified for permission and path isolation.
- `BDMTILES-SalesApp/src/features/expenses/types.ts` — response and input contracts.
- `BDMTILES-SalesApp/src/features/expenses/expenseService.ts` — API calls, category metadata, formatters.
- `BDMTILES-SalesApp/src/features/expenses/ExpensesScreen.tsx` — list with stats header and infinite pagination.
- `BDMTILES-SalesApp/src/features/expenses/SubmitExpenseScreen.tsx` — submit form with GPS capture and double-submit guard.
- `BDMTILES-SalesApp/src/features/more/MoreScreen.tsx` — entries navigating to Attendance and Expenses.
- `BDMTILES-SalesApp/src/navigation/AppNavigator.tsx` / `navigation/types.ts` — stack registration and param types for `Expenses`/`SubmitExpense`.

Reviewed from working-tree files (feature files are untracked; no PR diff available).

</details>
