# Customer Storefront API (`/api/v1/shop`)

Public, customer-facing API for the BDM Tiles website (`bdm-tiles-web`). Fully
isolated from the staff/CRM/warehouse APIs — a customer token can never reach a
staff route, and no existing route was modified.

## What was added (backend)

| File | Purpose |
|---|---|
| `routes/shop/index.js` | Mounts the shop sub-routers at `/api/v1/shop`. |
| `routes/shop/shopAuthRoutes.js` | Phone + OTP customer login, `me`, profile update, logout. |
| `routes/shop/shopProductRoutes.js` | Public catalog: list, detail (+availability), filter options. Online-visible products only. |
| `routes/shop/shopOrderRoutes.js` | Place order (`orderType:'online'`), list/track my orders. |
| `middleware/customerAuth.js` | `protectCustomer` — verifies `type:'customer'` JWT only. |
| `utils/customerJwt.js` | Issue/verify the customer JWT (separate from staff `utils/jwt.js`). |
| `utils/customerOtp.js` | OTP store (fixed dev OTP; SMS hook for prod). |
| `utils/onlineBranch.js` | Resolves the branch online orders/stock belong to. |

`server.js` mounts one line: `app.use('/api/v1/shop', shopRoutes)`.

## Endpoints

### Auth (no token needed to log in)
- `POST /shop/auth/request-otp` — `{ phone }` → sends OTP. In dev, response `data.devOtp` echoes the OTP.
- `POST /shop/auth/verify-otp` — `{ phone, otp, name? }` → finds/creates a `Customer`, returns `{ token, data.customer }`.
- `GET /shop/auth/me` (Bearer) — current customer.
- `PUT /shop/auth/profile` (Bearer) — update name/email/address fields.
- `POST /shop/auth/logout` — stateless.

### Products (public, no auth)
- `GET /shop/products` — query: `page, limit, search, category, subcategory, brand, tileSize, finish, tileType, colour, applicationArea, sortBy, order`. Returns only `status:'active'` + `onlineVisible:true`. Never exposes cost/dealer/wholesale prices — only `price` (= `retailRate`, fallback `mrp`) and `mrp`.
- `GET /shop/products/filter-options` — distinct sizes/finishes/types/colours/areas for the filter UI.
- `GET /shop/products/:id` — one product + `availableQty`/`inStock` (summed from `Stock` at the online branch).

### Orders (Bearer / customer token)
- `POST /shop/orders` — `{ items:[{ productId, quantity }], deliveryAddress, name?, notes? }`. Server re-prices via the same `deriveOrderPricing` engine the CRM uses (scope `walk_in`, `orderType:'online'`), creates a **confirmed** `SalesOrder`, reserves inventory, and sets `paymentStatus:'pending'` (COD at delivery). Bypasses the staff-only `POST /sales-orders` 405 cleanly for online orders.
- `GET /shop/orders` — this customer's online orders (scoped by phone) with delivery status.
- `GET /shop/orders/:orderNumber` — single order tracking: SalesOrder status + Delivery status + delivery OTP (shown while assigned/in_transit/reached).

## Config (`.env`)
```
FRONTEND_URL=http://localhost:5173,http://localhost:5175   # add storefront origin
ONLINE_BRANCH_ID=                                          # branch for online orders (blank = first active)
CUSTOMER_OTP_FIXED=1234                                    # blank in prod → random OTP + wire SMS
CUSTOMER_JWT_EXPIRE=30d
```

## CRM (BDMTILES-Fronted)
No changes required — online orders appear in existing Sales Order screens as
`orderType:'online'`. Optional enhancement: add an "Online / Website" filter
(`orderType=online`) and a dashboard widget.

## Storefront (bdm-tiles-web)
API layer added under `src/api/` (`client.ts`, `products.ts`, `auth.ts`,
`orders.ts`, `types.ts`). Controlled by `.env`:
```
VITE_API_BASE_URL=http://localhost:5000/api/v1
VITE_USE_API=false   # flip to true to use the live backend; false = bundled mock data
```
Wiring the screens to these services (behind the `VITE_USE_API` flag, with mock
fallback) is the next step and preserves every existing storefront feature.

## Production notes
- Set `CUSTOMER_OTP_FIXED=` (empty) and implement the SMS send in `utils/customerOtp.js`.
- Add the deployed storefront origin (Netlify/Firebase URL) to `FRONTEND_URL`.
- Online payment is COD-at-delivery (matches the existing Delivery model). A
  gateway (e.g. Razorpay) would be a separate, additive change.
