# loa-slide-render

Slide deck → PNG carousel renderer for Loa pipeline (Foodquest brand).

## Architecture

```
VM auto_draft → push deck markdown → CI render Slidev → PNG release artifact → VM download → fb_post
```

## Local dev

```bash
npm install
npm run dev               # live preview at localhost:3030
npm run export-png        # output: dist/*.png
```

## CI render

Trigger: push commit touching `decks/*.md`.

Workflow: `.github/workflows/render.yml`
- install slidev
- export each deck to PNG
- upload artifacts (download via gh CLI from VM)

## Theme

`themes/foodquest-editorial/` — Vue components apply skill `cover-design-principles`.

Skill ref: `NC9/skills/02-voice-craft/cover-design-principles.md`.

## Decks

Each deck = 1 post. Filename = post slug. Frontmatter declares voice + meta.

```yaml
---
theme: ./themes/foodquest-editorial
voice: food
slug: pansy-vien-keo-cua-bua-an
size: 1080x1350
---
```
