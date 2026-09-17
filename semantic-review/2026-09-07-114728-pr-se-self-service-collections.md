# Self-service field collections for the Sales Executive app

Sales executives can now record dealer payments in the field from the mobile app. The backend adds four additive fields to `Payment` (`isFieldCollection`, `collectedBy`, `collectionLocation`, `receiptImage`) and three self-scoped endpoints under `salesExecutiveRoutes.js` gated on `se.collections.view`: list own collections, per-status stats, and dealer outstanding, plus a POST that records the collection. The design intent is that a field collection is *accounting-inert* — it lands as a `pending`, unallocated `dealer_receipt` and only touches the ledger when finance later confirms it through the existing payments module. The app side wires a Collections list, a record form with conditional cheque/UPI fields, and a dealer picker that reuses the existing `myDealers` service.

Watch for: the accounting-inert capture is implemented correctly, but the *handoff to finance is broken* — the existing confirm path cannot post these records (**confirmed**, blocking). Everything else (scoping, validation, permission isolation, sequence sharing, app data contracts) checks out.

**Verdict**: NEEDS_CHANGES

## High-level view

The capture side does exactly what it claims. The SE POST forces `status:'pending'`, writes no `againstOrders`, and never calls `applyPaymentEffects`, `postSubledgerEntry`, or `applyDealerInvoiceAllocation`. No ledger, DealerLedger, `Dealer.currentOutstanding`, or Invoice mutation happens on capture. Because the `Payment` model defaults `status` to `'confirmed'`, forcing `'pending'` explicitly is load-bearing, and the handler does it.

The finance handoff is where it breaks. The existing `PATCH /:id/confirm` re-runs `validatePaymentData` on the stored record before posting, and that validator requires a `dealer_receipt` to be fully allocated to customer invoices. A field collection is intentionally unallocated, so confirmation throws `422 "Dealer receipt amount must be fully allocated to customer invoices."` These records can be created but never verified through the intended path.

Scoping and validation hold up. All three endpoints filter by branch and `collectedBy`/`assignedSalesExecutive`, and the POST re-verifies dealer ownership server-side and takes `collectedBy` from the session rather than the body. Amount, mode, cheque-number, transaction-ref, and future-date rules are enforced on both client and server. `sales_executive` carries `se.collections.view` but not `payment`, so an SE cannot reach the confirm/bounce endpoints — the maker-checker boundary holds. The `payment` branch sequence is shared with admin-created payments through an atomic per-branch counter, so numbers stay unique across both sources.

The app contracts line up with the backend envelopes, infinite pagination and stats keys match their invalidation keys, and the record form mirrors the server's conditional-field validation with a submit guard.

<details>
<summary>Issues (2)</summary>

1. **Finance cannot confirm unallocated field collections (blocking)** — `validatePaymentData` throws 422 "must be fully allocated" for any `dealer_receipt` whose allocations don't sum to the amount, so field collections (deliberately unallocated) can never be confirmed through `PATCH /:id/confirm`. Give finance a way to confirm an unallocated field collection as an on-account credit (e.g. relax the full-allocation rule when `isFieldCollection` and allocations are empty, or add an allocation step at confirm time). `routes/paymentRoutes.js:174-177`.
2. **No idempotency on the SE POST (minor)** — `POST /me/collections` has no `sourceKey`/idempotency key, unlike the admin payments POST, so a network retry after a slow success can create a duplicate collection. The client's `disabled={mutation.isPending}` guard only covers double-taps, not retries. `routes/salesExecutiveRoutes.js` POST handler.

</details>

<details>
<summary>Details</summary>

### Capture is accounting-inert as designed

The POST handler builds the `Payment` with `paymentType:'dealer_receipt'`, no `againstOrders`, `status:'pending'`, `confirmedAt:null`, `isFieldCollection:true`. No call into `applyPaymentEffects`, `postSubledgerEntry`, or `applyDealerInvoiceAllocation` exists on this route, and no direct write to `DealerLedger`, `Dealer.currentOutstanding`, or any `Invoice`. The explicit `status:'pending'` is load-bearing because the `Payment` schema defaults `status` to `'confirmed'`: a field collection that omitted it would be born `confirmed` and, while still inert on this path (nothing posts here), would be miscategorised and invisible to any pending-verification queue.

### Finance confirm path rejects unallocated dealer receipts

The confirm endpoint re-validates the stored record before posting:

```js
// paymentRoutes.js — PATCH /:id/confirm
await validatePaymentData(current.toObject(), session, { allowLegacySalesOrder: true });
...
await applyPaymentEffects(payment, session);
```

and `validatePaymentData` enforces full allocation for dealer receipts:

```js
const hasLegacySalesOrder = againstOrders.some(a => a.orderModel === 'SalesOrder');
if (paymentType === 'dealer_receipt' && !hasLegacySalesOrder && Math.abs(amount - allocatedTotal) > 0.01) {
  throw paymentError(422, 'Dealer receipt amount must be fully allocated to customer invoices.');
}
```

A field collection has an empty `againstOrders`, so `allocatedTotal` is `0` and `amount > 0`; the check fires and confirmation throws 422. `applyPaymentEffects` itself would handle an unallocated receipt correctly — it posts the subledger credit unconditionally and then iterates `payment.againstOrders ?? []`, which is empty, yielding a clean on-account credit that reduces the dealer's ledger balance without touching any specific invoice. The block is purely the validation gate in front of it: the code is willing to post these correctly but refuses to let them through. Net effect: field collections accumulate as permanently-pending records finance has no supported way to verify. Fix with either a carve-out in `validatePaymentData` for empty-allocation field collections, or an allocate-at-confirm step so finance assigns invoices before posting.

### No idempotency on record

The admin payments POST uses an `Idempotency-Key`/`sourceKey`; the SE POST does not. The client's `disabled={mutation.isPending}` button guard covers double-taps but not a retry after a slow-but-successful request, so a duplicate collection can be created. Low severity given collections are pending and finance reviews them, but a `sourceKey` would bring it to parity. GPS capture is otherwise defensive — `getCurrentCoordinates` throws a typed `LocationError`, the screen surfaces it without blocking submission, and the server stores `collectionLocation` only when a valid `{lat,lng}` is present.

</details>

<details>
<summary>Files changed</summary>

- `models/Payment.js` — additive field-collection fields (`isFieldCollection`, `collectedBy`, `collectionLocation`, `receiptImage`); no hooks.
- `routes/salesExecutiveRoutes.js` — collections list/stats/outstanding/record endpoints (SOW 18.6), all `se.collections.view` + self-scoped.
- `config/permissions.js` — `se.collections.view` registered; granted to `sales_executive` (no `payment`).
- App `src/features/collections/{types,collectionService,CollectionsScreen,DealerPickerSheet,RecordCollectionScreen}.tsx` — feature UI + service.
- App `src/navigation/{types.ts,AppNavigator.tsx}`, `src/features/more/MoreScreen.tsx` — route params, stack screens, More menu entry.

Full diff: `git diff main` in each repo (note: the backend feature files are currently untracked/uncommitted; `git diff main --stat` will not show `salesExecutiveRoutes.js` until staged).

</details>
