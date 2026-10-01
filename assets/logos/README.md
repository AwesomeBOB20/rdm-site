# Corps logos


## Badges: use `badges.css`, never style them per page (2026-10-01)

Every corps badge in the RDM system is `<span class="logo-badge lb-<name>">` with the logo inside, styled
by `badges.css` in this folder: the circle, the 3px black ring and each corps' own background colour.
Add a corps = drop `logo-<name>.png` here and add one `.lb-<name>{background:#...}` line to badges.css.
