# Security Policy

## Scope

This policy covers security vulnerabilities in the Conduit application itself — its server code, API, authentication system, and client.

**Out of scope:**
- Risks that are explicitly documented as accepted (Discord selfbot, Twitter cookie auth)
- Security of third-party services Conduit connects to (Slack, Telegram, Google, etc.)
- Vulnerabilities requiring physical access to the host machine
- Issues arising from running Conduit with no authentication on a public network (the README explicitly warns against this)

---

## Reporting a Vulnerability

Report security issues by opening a [GitHub Issue](https://github.com/conduit-app/conduit/issues) with the label **security**. If the issue is sensitive, you may instead contact the maintainers directly via the contact information in the GitHub profile.

Please include:
- A clear description of the vulnerability
- Steps to reproduce
- Potential impact
- A suggested fix if you have one

We aim to acknowledge reports within **72 hours** and to provide a fix or mitigation plan within **14 days** for confirmed issues.

---

## Known Accepted Risks

These risks are documented, understood, and accepted by users who choose to connect these platforms:

| Risk | Status |
|---|---|
| **Discord selfbot** — uses a personal user token, which Discord's ToS may prohibit for automated use | Documented; user accepts risk on connection |
| **Twitter cookie auth** — uses browser session cookies, not an official API key | Documented; user accepts risk on connection |
| **Unencrypted credentials at rest** — all platform tokens stored in the local SQLite database | Mitigated by filesystem permissions and optional disk encryption; full encryption not implemented |
| **No TLS in the server** — the server runs on plain HTTP | Intended for local/LAN use; users are advised to add a reverse proxy with TLS for remote access |

---

## Security Controls

Conduit implements the following security measures:

- **Authentication:** Optional password login (bcrypt, cost 12) + TOTP 2FA with in-memory rate limiting (10 attempts/minute per IP)
- **Session management:** Single active session per user; session invalidated on password change; `httpOnly` + `sameSite=lax` session cookies; 7-day expiry
- **API key auth:** SHA-256 hashed storage; per-key, per-service permission grants; full revocation support
- **CSRF protection:** Double-submit cookie pattern (`conduit-csrf` cookie + `X-CSRF-Token` header) enforced on all UI session state-changing requests
- **SSRF protection:** Outbound webhook and git remote URLs validated against private IP ranges (configurable in Settings → Security)
- **WebSocket auth:** Connections require a valid API key or UI session token; unauthenticated connections rejected when login is enabled
- **SSH security:** Strict host key checking on vault sync (configurable); stored `known_hosts` used on subsequent connections
- **Security headers:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `Content-Security-Policy`
- **TOTP secret isolation:** TOTP secrets held in memory during setup; only written to DB after successful verification
- **Audit log:** All actions logged with actor, service, timestamp, and detail

---

## Responsible Use

Conduit is designed to run on a machine and network you own and control. Running it with no authentication on a public IP is explicitly not a supported or recommended configuration.

If you choose to expose Conduit to the internet, you should:
- Enable password + 2FA login (Settings → Security)
- Run behind a TLS-terminating reverse proxy (nginx, Caddy, Traefik)
- Set `TRUST_PROXY=true` if behind a proxy
- Restrict access with firewall rules or VPN where possible
