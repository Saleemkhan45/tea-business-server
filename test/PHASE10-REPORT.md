# Phase 10: Real MongoDB integration validation

Validated on 2026-10-02.

MongoDB integration tests executed successfully against a real transaction-capable test database.

## A. Test database approach

Reused installed Docker Desktop and the existing Vitest/Mongoose stack. Docker
was initially stopped; it was started and the official MongoDB image was pulled.
No MongoDB memory-server package, new database framework or npm dependency was
installed. The repository initially had no Docker, Vitest configuration or CI
configuration files; Vitest used its existing defaults.

## B. MongoDB and replica-set configuration

- Image and confirmed server version: `mongo:8.0.17`, MongoDB `8.0.17`.
- Replica set: `sales-test-rs`, one writable primary at `localhost:27018`.
- Host binding: `127.0.0.1:27018`; temporary data/config filesystems.
- Dedicated database: `tea_business_dashboard_phase10_test`.
- URI: `mongodb://127.0.0.1:27018/tea_business_dashboard_phase10_test?replicaSet=sales-test-rs&directConnection=true`.
- MongoDB `hello`, `rs.status()` and a committed transaction probe verified readiness.

Production connection utilities and application `MONGODB_URI` behavior were not
modified. Test URI validation occurs before connection/cleanup; fixture cleanup
also verifies the connected database name. A post-suite database query confirmed
all fixture collections and the transaction-probe collection had zero documents.
The dedicated test container remains available for another test run. Cleanup is
`npm --prefix server run test:db:down`.

## C. Files changed

- `compose.test.yaml`: isolated replica-set startup and primary health check.
- `server/package.json`: database up/down and direct integration commands.
- `server/.env.example`: test URI documented separately from application URI.
- `server/test/mongoTestDatabase.js`: dedicated-name checks and transaction probe.
- `server/test/mongoTestDatabase.test.js`: eight database-isolation checks.
- `server/services/saleService.integration.test.js`: retained 12 original scenarios, strengthened persistence checks and added 23 scenarios.
- `server/models/Sale.js`: embedded prior-value edit history.
- `server/services/saleService.js`: original-creator preservation, atomic edit snapshots, explicit legacy-edit rejection and optional cash-customer tenant validation.
- `server/controllers/salesController.js`: HTTP 409 mapping for legacy edit rejection.
- `server/test/README.md`: reproducible commands, isolation, edit/legacy behavior and scoped future idempotency proposal.
- `README.md`: link to database test setup.
- `server/test/PHASE10-REPORT.md`: this validation record.

## D. Integration tests executed

All 35 scenarios executed against the real database, with zero failures and zero
skips. These include all 12 existing Phase 9 tests and 23 additional integrity
checks. Database persistence was not mocked. Rollback fault injection wrapped
the actual ledger service and threw only after real transactional writes.

## E. Individual test results

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Cash sale: stock decreases without customer debt | PASS |
| 2 | Credit sale: one linked ledger purchase and derived balance | PASS |
| 3 | Repeat credit sales retain separate purchases and add balance | PASS |
| 4 | Payment after purchase reduces balance without another sale | PASS |
| 5 | Payment leaves inventory and Sale/movement records unchanged | PASS |
| 6 | Credit sale void preserves records and restores stock | PASS |
| 7 | Cash sale void restores stock without ledger rows | PASS |
| 8 | Failed credit sale rolls back Sale, inventory and inserted ledger row | PASS |
| 9 | Cross-shop credit customer is rejected without side effects | PASS |
| 10 | Cross-shop Sale update and void are rejected | PASS |
| 11 | Duplicate submission currently creates separate accounting entries | PASS |
| 12 | Credit edit retains ledger audit and reconciles inventory | PASS |
| 13 | Cross-shop stock is rejected; both tenants retain their state | PASS |
| 14 | Foreign credit Sale/ledger access rejected; valid local operations leave other tenant unchanged | PASS |
| 15 | Separate 100kg and 50kg purchases minus payment derive correct balance | PASS |
| 16 | Customer reassignment voids old debt and charges only new customer | PASS |
| 17 | Credit-to-cash edit updates debt without another stock effect | PASS |
| 18 | Cash-to-credit edit creates debt without another stock effect | PASS |
| 19 | Quantity reduction and subsequent void restore correct remaining stock | PASS |
| 20 | Item reassignment and subsequent void reconcile both items | PASS |
| 21 | Replacement ledger failure rolls back the entire edit | PASS |
| 22 | Insufficient replacement stock rolls back prior stock restoration | PASS |
| 23 | Stock restoration failure rolls back ledger void | PASS |
| 24 | Repeated void cannot restore stock twice | PASS |
| 25 | Legacy cash Sale remains readable/voidable without fake restoration | PASS |
| 26 | Legacy credit Sale void retains ledger history without fake restoration | PASS |
| 27 | Legacy edit with unknown original stock effect is rejected | PASS |
| 28 | Cash edit preserves original creator and prior financial values | PASS |
| 29 | Fractional kilograms yield correct whole-PKR total despite client amount | PASS |
| 30 | Fractional-PKR create is rejected without persisted changes | PASS |
| 31 | Fractional-PKR update is rejected without persisted changes | PASS |
| 32 | Credit requires customer ID; cash customer name creates no debt | PASS |
| 33 | Foreign customer ID is rejected on cash create and edit | PASS |
| 34 | Successive tea/date/rate edits retain snapshots and valid Sale links | PASS |
| 35 | Concurrent sales cannot oversell shared stock | PASS |

## F. Transaction rollback result

PASS. The failure test first verified one Sale, one ledger row and stock `90`
inside the transaction. After deliberate failure and abort, independent reads
found zero Sales, zero ledger rows and restored stock `100`. Since movements are
embedded in Sale, no movement record survived. Edit and void failure scenarios
also compared complete persisted tenant state before and after abort.

## G. Credit sale atomicity result

PASS. A successful `10kg x PKR 500` credit sale persisted exactly one Sale, one
`sale_decrease` movement (`100 -> 90`), and one active linked ledger purchase for
PKR `5000`. A competing sale with insufficient shared stock produced no partial
or duplicate accounting state.

## H. Payment integrity result

PASS. PKR `2000` payment against a PKR `5000` purchase persisted a payment row and
reduced the derived balance to PKR `3000`. Separate persisted-state checks proved
payment left stock, Sale count and the entire Sale/movement record unchanged.

## I. Void integrity result

PASS. Credit Sale and purchase moved from completed/active to voided, retained
timestamps/operators/reasons and history, and restored stock from `90` to `100`.
Cash void created no ledger row. Repeated void had no second stock effect.
Failed restoration aborted the earlier ledger void. No financial records were
hard-deleted by a business operation; fixture deletion is test cleanup only.

## J. Repeat purchase result

PASS. Separate `100kg` and `50kg` purchases at PKR `500/kg` persisted PKR `50000`
and `25000` rows. A PKR `10000` payment produced a derived balance of PKR `65000`.
The legacy Customer balance cache was deliberately set to `999999` and did not
control this result.

## K. Tenant isolation result

PASS. Two shops were used to reject foreign customer/stock/Sale/ledger operations.
Valid local creation, edit and payment left the other shop's persisted data
unchanged. Testing found and corrected cash-sale optional customer IDs bypassing
ownership validation; both create and edit now validate any supplied customer ID.

## L. Duplicate submission and idempotency status

No current request/client identifier or idempotency mechanism exists. Repeating
the same request persists two Sales, two movements and two ledger purchases, and
charges both. This is a documented current limitation, not deduplication success.
The scoped future proposal is an optional `idempotencyKey`, partial uniqueness on
`shop + idempotencyKey`, canonical payload comparison and transaction-aware
handling of concurrent retries. No idempotency API/framework was implemented.

## M. Sale edit/update result

PASS after two reproduced defects were corrected. A legacy edit had incorrectly
deducted the full new quantity (`90 -> 78` for a 12kg edit), and a cash edit had
overwritten the original creator and discarded the old amount. Legacy edits now
fail explicitly; audited Sale edits preserve `createdBy` and append prior values,
editor and timestamp atomically. Tests also prove customer, item, tea, quantity,
date and payment-method changes keep exactly one active purchase for a credit
Sale, retain old voided rows and preserve stable Sale IDs.

## N. Legacy sale result

PASS. Raw historical records with no movement array and an unmapped legacy stock
identifier remained readable and voidable. Void left stock unchanged, generated
no movement and retained the Sale/ledger records. Updates return HTTP 409 until
the historical inventory effect can be reconciled from actual evidence.

## O. Amount authority result

PASS. Client `totalAmount` and `amountPkr` did not override stored server amounts.
`0.125kg x PKR 800 = PKR 100` persisted consistently in Sale and ledger.
`0.001kg x PKR 501` was rejected for fractional PKR on both create and edit, with
no database changes. The existing strict HTTP schema also excludes caller amount
fields; these override tests exercise the service boundary directly.

## P. Commands and results

| Command | Result |
| --- | --- |
| `npm --prefix server run test:db:up` | PASS: MongoDB container healthy; writable replica-set primary |
| `npm --prefix server test -- --run` | PASS: 9 files, 124 tests, zero skips |
| `npm --prefix server run test:integration` | PASS: 1 file, 35 tests, zero skips |
| `node --check` on all server JavaScript, then on changed production files | PASS |
| `npm run build` | PASS: TypeScript and Vite production build |

There is no configured server typecheck/build script. The root build checks the
existing client. Existing non-fatal warnings remain: duplicate Notification
`dedupeKey` schema index, Mongoose `new` update-option deprecation, and a large
frontend bundle warning.

## Q. Remaining risks

- Duplicate requests still create separate charges until scoped idempotency is implemented.
- Historical inventory effects and pre-change edit values cannot be reconstructed without evidence.
- The database setup is a single-node test replica set; failover and production deployment behavior were not validated.
- Test cleanup requires separate dedicated database names for simultaneous suite runs.
- Existing notification/model and build warnings remain outside this phase's scope.

## R. Recommended next phase

Review the scoped sale-creation idempotency proposal and authorize its API/tests
separately. Frontend Sales/Inventory integration remains a later phase. Phase 11
was not started.
