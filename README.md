# Lizard Game

A small toon-styled 3D exploration game: a cute lizard exploring a miniature natural world. Three.js + TypeScript + Rapier, built with Vite.

```sh
npm install
npm run dev
```

`npm test` builds the game, runs it in headless Chromium and saves screenshots to `test-results/screenshots/`.

`npm run demo -- --ref <commit> --label "Day 2" --out video.mp4` records a ~20 s demo video of the game at any commit (shot list in `scripts/demo-video/shots.mjs`; needs ffmpeg).
