# DESIGN.md — student + class surfaces

Source: the app's existing tokens (`--ink`, `--paper`, `--hl`, Hanken Grotesk). Swap the `:root` block marked `/* DESIGN tokens */` in index.html if you have a different file.

## Tokens
- Accent (the only chromatic color): `--accent #2F5BEA` (the app's highlighter cobalt blue). Used for: primary action fill (ink text on it), "New"/"needs grading" markers, active-tab underline. Nothing else is colored.
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


## Accent update
Accent is now cobalt `#2F5BEA` (hover `#2346C4`), with `#E3EAFF` as the only tint for hovers/notes and `#CBD9FF` for title markers. Solid accent fills carry white type. Status tags are square-cornered outlines, never pills. Motion: ease `cubic-bezier(.25,.8,.25,1)`, 0.45–0.7s, transform/opacity only; highlighted areas get a slow white sheen on hover; disabled under prefers-reduced-motion.

## Lantern River theme (supersedes the light theme above)
Inspired by the Lantern River template: a night river with floating lanterns. Surfaces are night-teal (`#071A1D` → `#0D272C` plates, hairline `rgba(242,246,245,.11)` borders); text is pearl `#F2F6F5`. One accent only: lantern-glow cobalt `#4C78FF` (hover `#3A5FE0`, tint `rgba(76,120,255,.16)`). Swap `--accent`/`--hl` in the final `:root` block to re-colour everything (the original template used amber).
Type: Cormorant Garamond for display headings and numerals (lining figures), Albert Sans for UI; both embedded as woff2.
Signature motion: a nav glow that glides between links on a spring, slow lanterns drifting up behind the app (canvas, off under prefers-reduced-motion and when the tab is hidden), a "Lighting the lanterns" boot screen, a small lamp beside the wordmark. The test-taking screen (`#student-page`) deliberately stays a light paper page.
