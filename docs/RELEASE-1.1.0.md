# OpenAdmin 1.1.0 — UX, accessibility and scale

Release date: **2026-11-20**

This release focuses on making everyday hosting work easier without changing
the security model, API surface or data layout.

## Highlights

- Mobile-safe mailbox, customer-domain and Security Center cards.
- Labelled action menus and consistent Polish UI on high-traffic screens.
- One-page quick customer creation; the full five-step wizard remains available.
- Package presets (Starter/Business/Unlimited), collapsible sections and sticky summary.
- File manager search, sorting, quota, multi-selection, bulk download/delete and preview.
- E-mail “all domains” view, search and bulk suspend/delete.
- Command palette now finds users, domains, mailboxes, tickets and recent pages.
- Server-side account pagination and scoped pagination for domains, mailboxes and files.
- Dirty-form guard, password reveal/copy, contextual help and inline mailbox validation.
- Dashboard, statistics, health and automation use collapsible sections.

## Upgrade

1. Deploy the `1.1.0` tree over `/usr/local/openadmin`.
2. Restart `openadmin.service`.
3. Open **Admin → System information**; the panel reports `1.1.0` automatically.
4. No database migration is required. Existing packages, domains, mail and files
   are preserved; `panel_version` is refreshed on boot.

## Verification

- `node --test`: **327/327 pass**.
- QA: **54/54**, **405 route/width checks**, 0 issues, 14/14 security checks,
  29 axe pages, 69 screenshots at 390/768/1024/1280/1440 px.
- Security Center: **100% (6/6)** on the live instance.
- Archive: `openadmin-1.1.0.tar.gz` with published SHA-256.

## Known scope limits

- Some advanced protocol screens retain technology names such as SMTP, PHP and
  nftables; these are intentional technical terms.
- Log browsing is a bounded tail viewer (2,000 lines); backup tables show bounded
  recent runs rather than a full historical pager.
- Legacy forms outside the high-traffic path still need the inline-error pattern.
