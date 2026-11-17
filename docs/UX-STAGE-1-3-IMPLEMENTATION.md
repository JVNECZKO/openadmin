# UX audit implementation — stages 1–3

Implemented from `AUDYT UX / PRODUCT` in commits:
- stage 1: mobile cards, Security Center spacing, automation action sizing, reseller action menu, Polish topbar/help, confirmations
- stage 2: quick account, package builder presets/collapsible sections/unlimited, file search/sort/quota/bulk/preview, all-domain e-mail + bulk, entity/recent command palette
- stage 3: terms dictionary + language regression test, duplicate-title cleanup, pagination, direct bulk selection, dirty-form guard, password reveal/copy, contextual help links, collapsible dashboard/statistics/health/automation sections

## Evidence

- `node --test`: **327/327 pass**
- QA: **54/54**, **405 route/width checks**, 0 route issues, 14/14 security checks, 29 axe pages, 69 screenshots
- widths: 390, 768, 1024, 1280, 1440
- live build is deployed from the commit that contains this document.

## Deliberate scope limits

- Server-side account pagination/filtering uses SQL LIMIT/OFFSET and COUNT. Customer domains, mailboxes and files paginate their scoped result sets; log browsing remains capped at the last 2,000 lines because it is a tail viewer, and backup tables show bounded recent runs.
- The language dictionary and regression test cover the high-traffic panel screens. Advanced technical screens may still contain necessary protocol/technology names (`SMTP`, `nftables`, `PHP`, `mod_security`).
- Inline server validation preserves values on the quick-account and mailbox-create paths and uses accessible field errors in the shared field component; every legacy form still needs the same treatment in a future pass.
- The shared page header is used through `page()` and duplicate card titles were removed from the main create forms; a full mechanical pass over every legacy template remains.
