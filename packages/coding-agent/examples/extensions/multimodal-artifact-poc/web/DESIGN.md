# Analytica Light Workspace Design

Source reference: `VoltAgent/awesome-design-md/design-md/vercel/DESIGN.md` at commit
`8147538b4226ae41e2487a9179e3bcc1f68e8554` (MIT). This is an adaptation for
Analytica's dense application workspace, not a copy of Vercel branding.

## Visual direction

Analytica is a quiet, technical, light workspace. The interface should feel
closer to a native productivity tool than a marketing dashboard: neutral
surfaces, crisp type, one blue interaction accent, restrained borders, and
almost no decorative effects. Project data, graph state, review state, and
artifacts remain the visual protagonists.

## Tokens

```text
canvas            #ffffff
canvas-soft       #f7f7f8
canvas-muted      #f1f1f2
surface-hover     #ececee
hairline          #e6e6e8
hairline-strong   #d3d3d7
ink               #171719
body              #45454a
muted             #77777f
faint             #9a9aa1
accent            #2563eb
accent-hover      #1d4ed8
accent-soft       #eaf1ff
success           #16794a
success-soft      #e8f5ee
warning           #9a6700
warning-soft      #fff5d6
error             #c9362b
error-soft        #fff0ee
review            #7551a6
review-soft       #f4effb
radius-sm         6px
radius-md         8px
radius-lg         10px
```

## Typography

- Use the native system stack: `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`,
  `PingFang SC`, and sans-serif fallbacks.
- Default body: 14px / 1.5, weight 400.
- Navigation and buttons: 13px, weight 500.
- Page titles: 20-22px, weight 600, slight negative tracking.
- Section titles: 15-16px, weight 600.
- Monospace is reserved for identifiers, hashes, capabilities, and events.

## Layout

- Desktop app shell: 228px navigation, flexible content, 376px inspector.
- Navigation uses the soft canvas; primary content uses white; the inspector
  uses a slightly muted surface to separate context without a heavy border.
- Use a 4px base grid. Default content spacing is 16 or 24px.
- Dense cards use 12-14px padding and 10px radius.
- Avoid large empty hero regions: this is an operational product.

## Components

- Primary button: dark ink fill, white label, 8px radius; blue is reserved for
  links, selected states, and focus.
- Cards: white surface, subtle hairline, no shadow at rest. Hover uses a slightly
  stronger border and a very small stacked shadow.
- Tabs: flat text with a blue underline or soft-blue selected surface.
- Inputs: white surface, neutral hairline, blue focus ring.
- Status badges: tinted semantic background plus text label; status is never
  encoded only by color.
- Graph nodes: white cards on a soft canvas. State colors appear primarily in
  the node border and status text.
- Tables: white rows, soft header surface, quiet row separators.

## Do

- Keep the main content visually dominant.
- Use blue sparingly for navigation selection, focus, and links.
- Use whitespace and typography before adding borders.
- Keep interactions compact and predictable.
- Preserve complete keyboard focus and responsive behavior.

## Do not

- Do not add gradients, glass effects, neon glows, or dark panels.
- Do not make every card appear elevated.
- Do not use multiple competing accent colors outside semantic status.
- Do not turn app controls into marketing-style pills.
- Do not change data contracts, routes, graph state, or governance behavior for visual reasons.
