# Control Panel

Status: Implemented
Date: 2026-06-11

A web control panel for the Hubolt server, served at `/ui` by the same
Fastify process. It is plain HTML, CSS, and native ES modules with no build
step, no framework, and no external assets (system font stacks, hand-written
SVG-free components), so it works offline and ships inside the npm package.

## Access

```bash
hubolt server
# open http://127.0.0.1:3000/ui
```

The panel asks for an organization API key on first load (create one with
`hubolt server bootstrap`). The key is held in browser localStorage and sent
as a Bearer token to the same-origin API; Disconnect clears it. A 401 from
any request returns the panel to the connect screen.

## Views

| View | Backed by | Shows |
|---|---|---|
| Overview | /health, /history/reviews, /budgets, /gateway/status | Server health, uptime, stored review count, monthly spend, gateway queue, recent reviews |
| Reviews | /history/reviews, /history/reviews/:id | Filterable paginated list; detail with findings, analyzer signals, model usage |
| Budgets | /budgets CRUD | Per-provider usage bars with alert thresholds; create, update, remove |
| Gateway | /gateway/status, /gateway/credentials | Configured providers (store or remove encrypted keys), queue counters, model catalog |
| Audit log | /audit/export | Filterable paginated audit events |
| Organization | /orgs/current | Org info, members, API keys (metadata only) |

## Design

The design language is drawn from the tool's own domain - code review.
IBM Plex Mono and Plex Sans (self-hosted woff2, ~116 KB total), a
phosphor-on-ink terminal palette, and elements that mean something here:
tables carry editor-style line-number gutters, severities are colored the
way compilers color diagnostics, section titles read as code comments
("// findings"), focal headings end in a blinking block cursor, the health
indicator is a tmux-style statusline segment, and the background is a
vignetted engineering dot grid. Motion is limited to staggered page-load
reveals, metric count-up, and the cursor blink; all of it stills under
prefers-reduced-motion.

## Security notes

- All data is rendered through element creation and textContent; API
  responses can never inject markup.
- No external requests: fonts, styles, and scripts are same-origin, which
  keeps the server's helmet CSP (default-src 'self') intact.
- Provider API keys submitted through the Gateway view go straight to the
  existing encrypted credential store and are never echoed back.
- The panel holds the org API key in localStorage for convenience on a
  developer machine; on shared machines, use Disconnect when done.

## Files

- `web/index.html`, `web/styles.css` - shell and design system
- `web/js/api.js` - fetch client (auth header, error normalization)
- `web/js/dom.js` - element helpers, formatting
- `web/js/views/*.js` - one module per view
- `web/js/app.js` - hash router, auth guard, health polling
- `src/server/routes/ui.ts` - static serving at /ui via @fastify/static
