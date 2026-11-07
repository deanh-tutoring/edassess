# DESIGN.md — student + class surfaces

Source: the app's existing tokens (`--ink`, `--paper`, `--hl`, Hanken Grotesk). Swap the `:root` block marked `/* DESIGN tokens */` in index.html if you have a different file.

## Tokens
- Accent (the only chromatic color): `--accent #FFD84A` (the app's highlighter yellow). Used for: primary action fill (ink text on it), "New"/"needs grading" markers, active-tab underline. Nothing else is colored.
- Neutrals: `--ink #16181D`, `--text-2 #4B5563`, `--muted #6B7280`, `--rule #D1D5DB`, `--bg #F9FAFB`, `--surface #FFFFFF`.
- Status is text + glyph only: `✓ Submitted`, `Missing`, `In progress`. No red/green/blue, no dots, no pills.

## Type
- One family: Hanken Grotesk. Tabular numerals for scores.
- Page title: 40px / 1.05 / 700 / tracking -0.035em
- Section label: 12px / 700 / uppercase / tracking +0.09em
- Body: 15px / 1.5 / 400. Meta: 13px / 400, `--muted`.

## Structure
- Max container depth 2: page > panel (1px rule border, no radius > 4px, no shadow) > plain divided rows.
- Content column max 1040px; lists are rows, not card grids (class data is heterogeneous).
- No decorative left rules, no avatars, no icons (type-only), no gradients, no hover lift, no shadows.
- Motion: none except focus/hover color. `prefers-reduced-motion` honored.
