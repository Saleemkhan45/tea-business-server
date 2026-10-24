# Authentication Setup

The application uses the existing email-based User records. There is no public registration or default administrator password. Existing records need an explicitly authorized password setup before they can sign in. Nothing below has been executed against a live database.

## Controlled Existing-User Password Setup

An authorized administrator must confirm the exact database, existing shop ID and existing user email. The command uses the existing server configuration; it never switches databases, creates accounts or initializes indexes. It sets only that user's password hash and revokes their sessions in a MongoDB transaction. The helper reads a hidden password and passes it over stdin, not a command-line argument.

From the repository root, after authorization, replace these placeholders:

```powershell
$env:AUTH_SETUP_APPROVED_DATABASE = '<exact-approved-database>'
$env:AUTH_SETUP_APPROVED_SHOP_ID = '<existing-approved-shop-object-id>'
$env:AUTH_SETUP_USER_EMAIL = '<existing-approved-user-email>'
$env:AUTH_SETUP_ALLOW_WRITES = 'true'
& .\server\scripts\set-user-password.ps1
```

Remove the four authorization variables after use. Do not run this command without approval of the target. An error is not confirmation of success; verify the account before retrying an uncertain result.

The setup CLI emits one sanitized JSON report, which the PowerShell wrapper validates before displaying selected fields. Reports identify validation, connection, transaction read/write, commit and cleanup stages. Error messages, stack traces, account details, connection strings and password data are never included. Numeric error codes, approved system codes and known MongoDB transaction labels are retained.

Exit code `0` means the commit was acknowledged, including when cleanup produced warnings. Exit code `1` means failure before any commit attempt. Exit code `2` means the commit outcome is uncertain. A missing or inconsistent report is also uncertain. Cleanup warnings cannot reverse a confirmed commit result. The existing MongoDB driver's transaction retry behavior is preserved; the wrapper adds no retry or activation flow.

For an uncertain result, stop writes. The next step is separately authorized read-only inspection of the selected user's `authVersion`, `updatedAt`, status and a computed password-hash-present boolean, compared with an earlier baseline where available. Do not print the hash or use login as a read-only probe: successful login creates an authentication-session record. These reports do not resolve the outcome of earlier attempts that discarded their diagnostics.

## Deployment

- Render: configure `NODE_ENV=production`, a stable random `JWT_SECRET` of at least 32 characters, and `CLIENT_ORIGIN=https://<exact-vercel-frontend-host>` with no path or trailing slash. The existing MongoDB connection is unchanged.
- Vercel: configure `VITE_API_BASE_URL=https://<render-backend-host>/api/v1`. Never configure a JWT secret or notification token on the frontend. Configure an SPA rewrite to `index.html` for direct `/login` and dashboard navigation.
- Separate Vercel and Render sites: `SESSION_COOKIE_SAMESITE=none` uses a Secure, HttpOnly, host-only `__Host-` cookie. Unsafe cookie-authenticated requests also require the exact trusted Origin and the session CSRF header. CORS grants credentials only to the configured origin. Preview deployments are not automatically trusted.
- Browsers may block third-party cookies across Vercel/Render hostnames. Same-site custom domains for frontend/backend are preferred for reliable cookie persistence; then `SESSION_COOKIE_SAMESITE=lax` is appropriate. Verify the actual deployment in supported browsers.
- Development allows the configured localhost/127.0.0.1 pair on the same port. Use the same hostname for frontend and API. Cookies are HttpOnly and SameSite=Lax over local HTTP.
- Legacy demo JWTs are rejected, and the demo-token endpoint no longer exists. Old integration fixtures that issue demo tokens need approved session fixtures before a future live integration run.
- Logout revokes the current session on the server. Other independent sessions remain valid. Password setup revokes all sessions for that user. REST access checks revocation on every request. Sockets disconnect on local-server logout and expiry, and revalidate session and shop ownership before delivering each notification.
- The login limiter is process-local. Multiple backend replicas require a shared rate-limit store and Socket.IO adapter before deployment at that scale.

## Validation Boundary

Offline authentication tests use mocked persistence. They do not establish MongoDB persistence, deployment cookie behavior or live access to a particular shop. Run live validation only against an explicitly approved isolated database.

Security references: [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html) and [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html).
