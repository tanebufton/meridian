# Security

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private
vulnerability reporting (Security tab → *Report a vulnerability*) on this repository.

## Deploying your own copy safely

Meridian ships with sensible defaults, but a few things are yours to get right:

- **`SESSION_SECRET`** – `scripts/setup.sh` generates a random one. If you create `.env` by hand, use
  `openssl rand -hex 32`. It encrypts 2FA secrets, so keep it private and don't change it casually.
- **The admin panel (`ADMIN_PORT`, default 3002) is plain HTTP and binds to `0.0.0.0` by default.**
  Never expose it directly to the internet. Either set `ADMIN_HOST=127.0.0.1` and reach it through a
  TLS-terminating tunnel/proxy, or keep it on a private network (LAN/Tailscale) behind a firewall.
- **Turn on two-factor authentication** (Settings → My account), especially if the admin panel is
  reachable through a tunnel.
- **Behind a reverse proxy or Cloudflare Tunnel**, set `TRUST_CF_HEADERS=true` (proxy on the same
  machine) or `TRUSTED_PROXIES=<ip,…>`. Without it, every visitor appears to come from the proxy's
  address and shares one login-throttle bucket.
- **`METRICS_TOKEN`** must be a long random string (16+ characters, or the endpoint stays disabled).
- **The public dashboard is read-only but shows every enabled target's name, host and notes.** Don't
  monitor anything whose hostname or IP is sensitive, or put it in a disabled target.
- **Probe targets are trusted input.** Admins can add HTTP/TCP/ping targets that reach internal
  addresses from the server running Meridian, so only give admin access to people you'd trust with that.
- **Back up `data/`.** Database snapshots (`*.pre-migrate-*`, `*.pre-import-*`) contain password hashes;
  they are created with mode `0600` and `data/` is git-ignored. Never commit it.

## What the application does for you

Hashed (bcrypt) passwords, hashed session tokens, CSRF protection, failed-login throttling per IP and
per username, optional TOTP 2FA with replay protection, an audit log, strict CSP/security headers,
parameterised SQL throughout, validated probe hosts (never parsed as command-line options), and
refusal of link-local/cloud-metadata addresses as notification targets.
