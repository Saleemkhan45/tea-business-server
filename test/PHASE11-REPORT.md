# Phase 11: Scoped sale-creation idempotency

Validated on 2026-10-02 against MongoDB `8.0.17`, replica set `sales-test-rs`,
database `tea_business_dashboard_phase10_test` on `127.0.0.1:27018`.

MongoDB integration tests executed successfully against a real transaction-capable test database.

## A. Files changed

- `server/models/Sale.js`: optional immutable key/fingerprint fields, shared maximum length, named partial unique index.
- `server/services/saleService.js`: required create key, normalized fingerprint, scoped replay and transaction race handling.
- `server/schemas/salesSchemas.js`: required create-only Zod key validation; edit schema still rejects create metadata.
- `server/controllers/salesController.js`: HTTP 409 conflict mapping and service key validation errors.
- `server/services/saleService.integration.test.js`: 36 new real MongoDB/HTTP scenarios; existing fixture inputs now supply independent request keys.
- `server/test/README.md`: current API contract, lifecycle, deployment and retry documentation.
- `server/test/PHASE11-REPORT.md`: this validation record.

No dependency, production connection, authentication, route, payment or frontend
implementation was changed. The existing sales controller still derives shop
and creator from the authenticated User and returns `{ sale }`.

## B. Idempotency design

Each intentional creation supplies an opaque trimmed, case-sensitive string key,
1-128 characters. The key is stored directly on Sale. A SHA-256 fingerprint of
the normalized original create request accompanies it. It includes normalized
customer ID/name, business date, tea type, stock ID, quantity in grams, unit price,
status, payment method and notes, with a fixed version and field order.

Server-derived totals and authenticated operator are excluded. The same request
can be retried by another authorized operator in the same shop without changing
the original creator. Customer aliases, ID casing, trimmed text and optional
defaults normalize consistently. Key values are not derived from business fields.

Both fields are optional for historical Sale documents, immutable after creation
and hidden from normal query results and creation/replay responses. They are
persisted inside the existing Sale/inventory/ledger transaction. There is no
separate persistence structure, lock service or generic idempotency framework.

## C. Database index used

Actual MongoDB index inspection returned:

```json
{
  "key": { "shop": 1, "idempotencyKey": 1 },
  "name": "sale_shop_idempotency_key_unique",
  "unique": true,
  "partialFilterExpression": { "idempotencyKey": { "$type": "string" } }
}
```

The integration test also bypassed application lookups and attempted a raw
duplicate insert. MongoDB rejected it with `code: 11000` and the scoped key
pattern. The original Sale/accounting state remained unchanged. Separate keys
and the same key in different shops both persisted independently. Multiple
historical Sales without keys persisted under the same index.

The partial uniqueness behavior follows the
[MongoDB partial index documentation](https://www.mongodb.com/docs/manual/core/index-partial/).

## D. Request lifecycle

1. Existing authentication resolves the current active User and shop. Strict Zod validation requires the key and rejects caller shop/operator fields.
2. The service validates the key, normalizes the sale and computes its authoritative amount and original-request fingerprint.
3. It waits for `Sale.init()`, validates the current operator and checks the scoped key for an existing successful Sale.
4. If absent, the transaction rechecks the key on every attempt, validates current references, adjusts stock, creates the keyed Sale and adds the credit purchase where applicable.
5. After commit, only a newly created Sale evaluates the existing stock notification flow. A replay returns without new accounting or notification effects.
6. A scoped duplicate-key race aborts the losing transaction. The service reads the winner outside the failed transaction and applies the same replay/conflict policy.

Other errors preserve the central handler. If a duplicate winner cannot be
resolved, HTTP 409 explicitly instructs the client to retry the same key.

## E. Same-key retry behavior

PASS. An equivalent normalized request in the same shop returned the same Sale
identity and existing HTTP `201 { sale }` contract. The tests compared complete
persisted tenant state before/after replay and found no additional writes.
Idempotency metadata and sessions were absent from response bodies.

The original fingerprint survives edits and voids. A replay returns that Sale's
current state, rather than recreating the original accounting effects. Current
stock/customer inactivity cannot invalidate an already committed operation;
the replaying operator must still be active and belong to the shop.

## F. Same-key/different-payload behavior

PASS. Changed quantity returned HTTP 409 with:

```json
{ "message": "Idempotency key was already used for a different sale request." }
```

Separate tests rejected changed rate, business date, payment method, status,
notes, customer name, customer ID, stock ID and tea type. Original Sale, inventory
and ledger records remained unchanged. Invalid request bodies still follow the
existing HTTP 400 validation convention.

## G. Concurrent request behavior

PASS. Simultaneous same-key cash and credit requests with only enough stock for
one sale both resolved to the same Sale. The database contained one Sale, one
movement and one stock decrement; credit had one active ledger purchase.

Simultaneous different-stock requests under one key returned one HTTP 201 and
one HTTP 409, never an unexplained duplicate-key HTTP 500. Only the winner's
stock decreased; the other item retained its original stock. The unique index,
not an in-memory lock or timing assumption, is the database protection.

## H. Failed transaction/retry behavior

PASS. The test wrote the keyed Sale, stock effect and real ledger row, then
deliberately failed. It confirmed zero Sales, zero ledger rows and original stock
after rollback. The exact same key/request then succeeded and could be replayed
without further effects. The failed transaction left no permanent reservation.
Fault injection wrapped the real ledger service; database persistence was not mocked.

## I. Credit sale result

PASS. Initial request and retries persisted one Sale, one movement and one active
purchase. A `10kg x PKR 500` sale charged the derived balance exactly PKR `5000`,
not twice. Different keys still created separate legitimate purchases.

## J. Cash sale result

PASS. Initial request and retries persisted one Sale and one movement with zero
customer ledger purchases. Cash remains independent of customer debt.

## K. Tenant isolation result

PASS. Identical keys worked independently in two shops. Scoped replays returned
only the local Sale. Internal and HTTP foreign read/update/void attempts failed.
Caller body shop/operator/creator fields were rejected, and a spoofed token shop
claim did not override the User record. The other tenant's persisted state did
not change. Unauthenticated creation returned HTTP 401.

## L. Legacy sale compatibility

PASS. Historical Sales without key/fingerprint remained readable and voidable,
and multiple such documents coexisted under the partial unique index. No keys or
historical stock effects were fabricated. Phase 10's explicit legacy-edit
inventory-reconciliation restriction remains intact.

## M. Tests added

36 integration scenarios were added. All 35 accounting regression scenarios
remain; the old duplicate-charge characterization now checks independent
identical requests with different keys, matching the newly required contract.

| Required scenario | Result |
| --- | --- |
| 1. Same key and same request: one Sale | PASS |
| 2. Same key and credit request: one ledger purchase | PASS |
| 3. Same key and cash request: one Sale, no ledger purchase | PASS |
| 4. Same key and different payload: conflict | PASS |
| 5. Different keys: independent Sales | PASS |
| 6. Same key across shops: independent Sales | PASS |
| 7. Concurrent same-key requests: one Sale | PASS, cash and credit |
| 8. Failed transaction: key reusable | PASS |
| 9. Successful-sale retry: no duplicate movement | PASS |
| 10. Successful-credit retry: no duplicate ledger | PASS |
| 11. Voided Sale replay: no recreation | PASS |
| 12. Tenant isolation | PASS, service and HTTP |

Additional checks cover all fingerprint business fields, actual index creation
and duplicate rejection, competing stock payloads, edits retaining the original
fingerprint, inactive current resources, active operator enforcement, metadata
privacy, key trimming/case/length/type, customer alias normalization and legacy
compatibility. No MongoDB model operation was mocked.

## N. Integration test result

`npm --prefix server run test:integration`: PASS, 1 file, **71/71 tests**, zero
failures and zero skips. MongoDB reported `8.0.17`, replica set `sales-test-rs`,
and a committed transaction probe. Post-suite direct database inspection found
zero documents in the fixture and probe collections; the unique index remained.

## O. Full server test result

`npm --prefix server test -- --run`: PASS, **9 files, 160/160 tests**, zero failures
and zero skips. This includes 71 database integration tests and 89 existing
unit/contract tests; the latter are not described as database integration tests.

## P. Build/syntax result

`node --check` passed on all server JavaScript. `npm run build` passed the existing
client TypeScript and Vite production build. There is no configured server
typecheck/build script. Existing non-fatal Notification index, Mongoose update
option and frontend bundle-size warnings remain outside Phase 11's scope.

## Q. Remaining limitations

- API callers must now send a new key for each intentional sale and retain it across retries. The existing mock frontend has not been integrated.
- Keys have no expiry and remain reserved while their Sale exists, including after void.
- Replays return the same Sale in its current state after edits/voids; they do not return a stored historical HTTP response snapshot.
- Deployments that disable automatic index creation must provision and verify the named unique index before accepting keyed writes.
- Idempotency applies only to sale creation. Payments, updates and voids have no new idempotency mechanism.
- The single-node test replica set does not validate production failover or long-duration load behavior.

## R. Recommended next phase

Define the frontend/API-client key lifecycle and retry behavior, then authorize
that integration separately. Preserve one key per user intent and generate a new
key only for a new intentional sale. No Phase 12 work was started.
