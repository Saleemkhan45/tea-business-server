# Sales MongoDB integration tests

These tests execute the existing Mongoose services against MongoDB, including
commits and rollbacks. They require a replica set. A standalone MongoDB server
does not support the required transactions.

## Offline verification

Phase 33.1 Part 8 authorizes test-infrastructure changes and offline checks only.
It does not authorize connecting to Atlas or local MongoDB, starting the test
database, running the transaction probe, or executing the integration suite.

From the project root, these focused tests do not import the application, load
its private environment file, or connect to a database:

```sh
node --check server/test/mongoTestDatabase.js
node --check server/test/mongoTestDatabase.test.js
node --check server/services/saleService.integration.test.js
npm --prefix server test -- test/mongoTestDatabase.test.js test/integrationLifecycle.test.js utils/databaseDiagnostics.test.js
npm run typecheck
npm run build
```

The authorization tests use synthetic configuration and mock connection calls.
Cleanup tests use in-memory documents; the integration suite still uses real
MongoDB persistence. Do not substitute an unfiltered server test command: it
also discovers the database-backed integration suite.

## Explicit write authorization

Every integration run, including a local run, requires all of these settings:

| Variable | Required value |
| --- | --- |
| `NODE_ENV` | Any environment other than `production` |
| `SALES_INTEGRATION_MONGODB_URI` | Explicit private integration URI containing a database name |
| `SALES_INTEGRATION_APPROVED_DATABASE` | Exact administrator-approved validation database name |
| `SALES_INTEGRATION_APPROVED_HOSTS` | Exact comma-separated URI hosts, including explicitly specified ports |
| `SALES_INTEGRATION_ALLOW_WRITES` | Exactly the string `true` |
| `MONGODB_URI` | Existing private application URI with an explicit database name, used only to exclude that database |

There is no default URI fallback. `DEFAULT_TEST_MONGODB_URI` is an offline/local
sample, not authorization. A `_test` suffix or write flag alone is insufficient.
Names must satisfy `tea_business_dashboard_*_test`; `admin`, `local`, `config`
and `test` are forbidden. The validation database name must differ from the
application database name, even if the endpoints differ.

Approved database matching is exact and case-sensitive. Approved hosts are
compared as a complete, sorted, case-insensitive list; missing, extra and
duplicate approved entries are rejected. For SRV URIs, approve the URI's SRV
hostname without a port; SRV member discovery still requires administrator
review of the cluster, network rules and credential permissions.

The suite imports `server/config/env.js`, which loads private `server/.env`
before authorization. Models, the application and services are imported only
after the gate passes. Process settings are recommended for an approved run;
do not modify or disclose private environment files during an offline review.
The connection helper repeats the gate before connecting and rejects a caller
URI or connected database that differs from the approved configuration.

## Database and cleanup isolation

Use an empty, disposable validation database, reserved exclusively for one
suite process. An approved shop inside a shared database is insufficient.
Automatic collection/index creation is disabled at connection time. A read-only
preflight rejects any existing document, including documents in unrelated
collections, before the probe or explicit model/index setup. The probe deletes
only its own generated document ID. The suite rechecks emptiness after cleanup
before each test, excluding only the active run's lease document and preserving
existing whole-database rollback assertions.

Each suite run has a UUID. Fixture names include that identifier. Pass-through
wrappers on the nine fixture models' collection methods record only IDs returned
by acknowledged `insertOne`, `insertMany`, `updateOne` upsert,
`findOneAndUpdate` upsert, and `bulkWrite` results. The bulk result's operation
indexes identify inserted and upserted IDs; matched updates are never owned.
This covers model creates, raw legacy Sale inserts, service-created Sales,
ledger rows and notifications, and Mongoose model-level upsert calls. For
`findOneAndUpdate` upserts, the wrapper requests driver result metadata and
returns the same document or metadata shape the caller requested. Sessions,
other options and write errors are forwarded. A driver bulk partial-write error
retains its error while recording IDs reported in its result.

The run is marked ownership-uncertain if a write may have inserted a document
but its ID cannot be established: for example, a missing or invalid ID in an
acknowledged result, incomplete upsert metadata or bulk indexes, a partial bulk
failure without a usable result, or an indeterminate network/write-concern
failure. Valid IDs in partial results remain recorded. A definite duplicate-key
rejection and operations blocked before the write do not mark uncertainty.
The state is sticky for the run: catching the write error, draining, cleaning
known IDs, or succeeding later cannot clear it.

Unacknowledged upserts, missing or ambiguous upsert IDs, and standalone
`updateMany`, `replaceOne` and `findOneAndReplace` upserts are unsupported and
fail in the validation harness. Do not add new write APIs to integration tests
without adding ownership coverage first. The wrappers do not track writes made
through a separate raw driver collection or another process.

After exact URI, host and database authorization, an empty-database preflight
and a replica-set check, the harness atomically inserts one document with a fixed
`_id` into `__sales_integration_lease`. It binds the approved database to this
run's UUID. The unique `_id` rejects a second runner that passed the same
preflight. Lease acquisition precedes the transaction probe, model setup and
fixtures. Only a release filtered by that database and run ID may delete the
lease. No expiry or automatic takeover exists.

Cleanup uses only `_id: { $in: recordedIds }`, after authorization and lifecycle
draining. There are no unrestricted collection deletions or discovery queries
that claim records by shop/name. NotificationRead and NotificationSettings
ownership is recorded directly; neither requires a shop field. Collections
without recorded IDs are not deleted. Ownership is retained when deletion fails
or is unacknowledged. Aborted transaction IDs may match no persisted document.

Final teardown drains active work, closes HTTP, deletes owned fixtures, then
checks all collections for remaining documents. The check excludes only the
current lease after verifying its database and run ID. It reports collection
names and counts, never document contents. Unexpected residue fails validation;
the lease remains and the connection is disconnected after the drain. If the
check passes and ownership is certain, teardown releases the owned lease and
disconnects. If ownership is uncertain, teardown reports that the validation
lease was retained for manual review and safely disconnects after draining,
even when the final scan finds no other documents. A clean scan cannot prove
what happened to a write with an unknown inserted ID. A failed setup after
lease acquisition also leaves the lease for review.

The fixture registry remains process-local. Interrupted processes, partial
writes and writes outside the wrapped APIs can leave documents. A later run
refuses nonempty data. For an abandoned lease, an authorized administrator must
first confirm that no runner, application or transaction still uses the target;
inspect the exact approved database's collections and document counts; resolve
  any residual documents or ownership uncertainty through a separately approved,
  ID-scoped investigation and recovery plan. A clean scan alone does not resolve
  an ownership error. Then verify the lease document's database name and run ID
  before deleting that
single document by `_id`, database name and run ID. If ownership or data origin
is ambiguous, retain the lease and stop. Never drop the database or run broad
deletion as automatic recovery. Use separate approved databases for independent
runners.

## Manual Atlas prerequisites

Before a separately authorized live run, an Atlas administrator must:

1. Revoke or rotate the exposed credential and confirm the old credential is invalid.
2. Review assigned and inherited database-user roles.
3. Restrict network access to approved test runners.
4. Provision a separate validation credential with only the required database CRUD and index permissions, without application/production data access.
5. Create or authorize the exact validation database and cluster endpoint for exclusive testing.
6. Confirm the database is empty, disposable and contains no production/customer data.
7. Store the new secret privately without exposing credentials or full URIs in logs or reports.

The code cannot confirm rotation, Atlas roles, network policy or administrator
approval. The authorization variables record an explicit operator decision;
they do not replace those external confirmations. Setup errors redact the URI
and credential tokens and do not retain an unredacted original error cause.

## Separately authorized live run

Only after the prerequisites and explicit live-testing approval, supply private
values in place of these placeholders. Do not paste the actual values into a
report or shared shell transcript:

```powershell
$env:SALES_INTEGRATION_MONGODB_URI = '<PRIVATE_APPROVED_INTEGRATION_URI>'
$env:SALES_INTEGRATION_APPROVED_DATABASE = '<EXACT_APPROVED_VALIDATION_DATABASE>'
$env:SALES_INTEGRATION_APPROVED_HOSTS = '<EXACT_APPROVED_URI_HOSTS>'
$env:SALES_INTEGRATION_ALLOW_WRITES = 'true'
# MONGODB_URI remains privately configured for application-database exclusion.
npm --prefix server run test:integration -- -t '<APPROVED_TEST_NAME>'
```

The local `compose.test.yaml` remains available for separately approved local
testing. It binds the test replica set to loopback and uses temporary storage;
starting it and providing its URI still require explicit authorization. A
connection, authorization or transaction failure fails the suite, never a
successful skipped integration run. Existing timeout values are unchanged.

## Validation scope

All 12 Phase 9 scenarios remain. Additional tests inspect persisted Sale,
inventory movement and ledger records for tenant isolation, edit and void
rollback, customer/stock/payment-method changes, repeat purchases minus payments,
legacy records and authoritative whole-PKR amounts.
Tenant ownership is checked for any supplied customer ID, including the optional
customer on a cash sale. Customer names alone still create no ledger debt.
Concurrent sales against insufficient shared stock are also checked for a single
committed Sale, movement and ledger purchase.

The create rollback test performs all three real writes inside the transaction,
confirms they are visible in that session, then deliberately throws after ledger
creation. After abort, it reads the database outside the session and checks zero
sales, zero ledger rows and the original inventory balance. Failure injection
wraps the real ledger service; database models and persistence are not mocked.

## Edit and legacy behavior

Sale updates retain the original `createdBy` and append the prior mutable sale
values, editor (`changedBy`) and timestamp to `Sale.editHistory`. That append,
stock reconciliation and void/replacement ledger writes share one transaction.
Ledger purchase rows retain their original values and Sale ID when voided.
The current Sale document remains the latest version; prior values are available
through the existing read endpoints. History from edits made before this change
cannot be reconstructed.

Legacy sales without recorded inventory movements remain readable and voidable.
Voiding preserves the Sale, voids a linked active credit purchase if present,
and leaves stock unchanged. The empty/absent movement array means no inventory
restoration was performed. Updates to these records return HTTP 409 with an
explicit inventory-reconciliation error. There is no reliable evidence to guess
their original stock effect, so tests and services never synthesize that history.

## Sale-creation idempotency (Phase 11)

`POST /api/v1/sales` now requires a client-generated opaque `idempotencyKey`
string. Keys are trimmed, case-sensitive and limited to 128 characters. Generate
a new key for each intentional sale; retain that key and request body for retries.
Two identical sales with different keys remain independent purchases. The
frontend Sales/Inventory mock implementation is unchanged in this phase.

```json
{
  "idempotencyKey": "9ec217b7-b921-4fca-b665-1d762c4b072a",
  "businessDate": "2026-10-02",
  "teaType": "green",
  "stockLocationId": "507f1f77bcf86cd799439011",
  "quantityKg": 10,
  "unitPrice": 500,
  "paymentMethod": "cash"
}
```

Use existing shop-owned IDs and bearer authentication for an actual request.
The strict body schema rejects caller `shop`, `operator` and `createdBy` fields;
the authenticated User record supplies shop/operator even if a token shop claim
is different. Credit requests still require the existing customer ID field.

Key and SHA-256 request fingerprint live on Sale, in the same accounting
transaction as inventory and ledger writes. The named partial unique index
`sale_shop_idempotency_key_unique` enforces `{ shop: 1, idempotencyKey: 1 }` only
where the key is a string. Historical records may keep both fields absent.
New creation through the service also requires a valid key. No migration creates
keys or changes old financial records.

The fingerprint uses a versioned, fixed-order JSON representation of customer
ID, customer name, business date, tea type, stock ID, quantity in grams, unit
price, status, payment method and notes. It normalizes IDs, text and optional
defaults. Caller totals are excluded because the server calculates them. The
operator is excluded because uniqueness belongs to the shop: another currently
authorized operator in the same shop can replay the original request.

| Request | HTTP result | Accounting result |
| --- | --- | --- |
| New key and valid request | `201`, existing `{ sale }` envelope | One committed Sale and stock effect; credit adds one purchase |
| Same shop/key and equivalent normalized request | `201`, same Sale identity | No additional writes or notification evaluation |
| Same shop/key and different request | `409`, clear message | No mutation or second accounting transaction |
| Same key in another authenticated shop | `201`, separate Sale | Independent tenant-scoped operation |
| Failed accounting transaction, then same-key retry | Retry can succeed | Failed key reservation rolls back with the Sale |

The fingerprint remains immutable after edits and voids. Replaying the original
create body returns the existing Sale in its current edited/voided state, with
the same identity; it never resurrects a voided Sale. A changed create body still
conflicts with the original fingerprint. Replays validate the current operator
but do not require current stock/customer availability. Idempotency metadata is
hidden on creation responses, replays and existing read/update endpoints.

The service checks for an existing scoped request before writes and again inside
every transaction attempt. The unique database constraint protects races. After
a scoped duplicate-key error, it reads the committed winner outside the aborted
transaction and applies the same fingerprint policy. If a winner cannot be
resolved, HTTP 409 tells the client to retry the same key. Other database errors
keep the central error handling conventions.

Tests inspect MongoDB's actual index and demonstrate a raw duplicate insert
failing with `11000`; concurrency tests inspect committed Sale, stock and ledger
state. The former Phase 10 duplicate-charge characterization now verifies
legitimate identical requests with distinct keys. All other Phase 10 accounting
regressions are retained.

### Deployment

Sale creation awaits `Sale.init()` before its first accounting transaction. The
existing application uses automatic index creation. Deploy the named unique
index before accepting keyed sale requests if automatic index creation is
disabled in a deployment. `Sale.createIndexes()` builds declared Sale indexes
without dropping other indexes or rewriting records; do not use `syncIndexes()`
to remove unrelated deployment indexes. Verify the index with MongoDB
`db.sales.getIndexes()` before enabling traffic.

Keys have no expiry and remain reserved for the lifetime of their Sale, including
after void. This mechanism covers creation only; payment/update/void requests
have no new idempotency API. The test replica set validates transactional
behavior rather than production failover.
