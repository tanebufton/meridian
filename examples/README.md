# Example target sets

`nz-rsp-targets.json` — a starter set for an **NZ retail service provider**, built from verified,
reachable hosts and classified by who actually hosts them (so CDN-fronted sites aren't mistaken for
domestic routing). Import with **Settings → Data → Import config → "Add what's missing"**; existing
groups and targets are left alone.

Tips for building your own set:
- A foreign site that answers in ~2 ms is sitting behind a CDN edge near you: it measures the CDN,
  not that country. Check the hop AS (or the traceroute) before trusting a target as "regional".
- Prefer datacentre ping hosts (Vultr `*-ping.vultr.com`, OVH `*.smokeping.ovh.net`, looking glasses),
  national research networks, registries and in-country carriers.
- Keep CDN-fronted "popular services" in their own group so they're read as customer experience.
