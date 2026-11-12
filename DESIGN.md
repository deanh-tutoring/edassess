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

## Lantern River theme
Inspired by the Lantern River template: a night river with floating lanterns. **Light is the default** — moonlit pearl paper (`#F2F6F5`), white plates, night-teal ink (`#0C2428`), hairline borders. The sidebar and the login/name-entry art stay night-teal in both modes. Night mode (Appearance → Dark mode, or "Night mode" in the student menu) swaps the tokens under `body.fx-ui-dark`.
One accent only: lantern-glow cobalt (`#2F5BEA` light / `#4C78FF` night). Swap `--accent`/`--hl` in the first `:root` block to re-colour everything (the template used amber).
Type: Cormorant Garamond for display headings and numerals (lining figures), Albert Sans for UI; both embedded as woff2.
Signature motion: a nav glow that glides between links on a spring, slow lanterns drifting behind the app (canvas; off under prefers-reduced-motion and when the tab is hidden), a "Lighting the lanterns" boot screen, a small lamp beside the wordmark.

## Restraint
Keep the Lantern River look (glow, gradients, soft motion). Remove only what does not help: helper copy, redundant pills and labels.

## Exam shell (AP Classroom style)
Navy top bar with red rule; timer + Hide live only inside the bar and toggle in place. Tools: Highlights & Notes, Line Reader (spotlight strip: drag, resize, Alt+arrows, dim, follow-mouse), Notepad (per-question + whole test, private, saved on device), Text size. Shortcuts: arrows navigate, A-D select, N notepad, Esc closes line reader.
