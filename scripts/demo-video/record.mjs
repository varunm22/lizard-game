#!/usr/bin/env node
/**
 * Record a short demo video of the game at any commit: builds it, boots it in headless Chromium,
 * plays the shot list in `shots.mjs` frame by frame with `window.__game.advance` (so the video runs
 * at real speed however slowly software WebGL renders), and stitches the frames with ffmpeg.
 *
 *   node scripts/demo-video/record.mjs [--ref <git ref>] [--label "Day 2"] [--out video.mp4]
 *                                      [--only walk,swim] [--width 1280 --height 720]
 *
 * Without --ref it records the working tree. With --ref it checks that commit out into a temporary
 * git worktree first, so e.g. `--ref 'main@{2026-10-03 23:59}'` records yesterday's last state
 * without touching your checkout.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { SHOTS } from './shots.mjs';

const FPS = 30;
const STEPS_PER_FRAME = 60 / FPS;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []),
);
const width = Number(args.width ?? 1280);
const height = Number(args.height ?? 720);
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

const tmp = mkdtempSync(join(tmpdir(), 'lizard-demo-'));
let appDir = repo;
let sha = git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain') ? '-dirty' : '');
let date = new Date().toISOString().slice(0, 10);
if (args.ref) {
  sha = git('rev-parse', '--short', `${args.ref}^{commit}`);
  date = git('show', '-s', '--format=%cs', sha);
  appDir = join(tmp, 'src');
  git('worktree', 'add', '--detach', appDir, sha);
  // Reuse this checkout's packages when the lockfile matches; otherwise install that commit's own.
  const lock = (dir) => (existsSync(join(dir, 'package-lock.json')) ? readFileSync(join(dir, 'package-lock.json'), 'utf8') : '');
  if (lock(appDir) === lock(repo)) symlinkSync(join(repo, 'node_modules'), join(appDir, 'node_modules'));
  else execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: appDir, stdio: 'inherit' });
}
const label = args.label ?? date;
const out = resolve(args.out ?? join(repo, 'test-results', 'demo', `${date}-${sha}.mp4`));
const only = typeof args.only === 'string' ? args.only.split(',') : null;
console.log(`Recording ${sha} (${date}) as "${label}" -> ${out}`);

const distDir = join(tmp, 'dist');
const vite = join(appDir, 'node_modules', '.bin', 'vite');
execFileSync(vite, ['build', '--outDir', distDir, '--emptyOutDir', '--logLevel', 'warn'], { cwd: appDir, stdio: 'inherit' });
const port = 4300 + Math.floor(Math.random() * 500);
const server = spawn(vite, ['preview', '--outDir', distDir, '--port', String(port), '--strictPort'], { cwd: appDir, stdio: 'ignore' });

const framesDir = join(tmp, 'frames');
mkdirSync(framesDir);
let browser;
try {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  for (let k = 0; ; k++) {
    try {
      await page.goto(`http://localhost:${port}/`);
      break;
    } catch (e) {
      if (k > 50) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  await page.waitForFunction(() => window.__game?.ready === true, null, { timeout: 60_000 });
  await page.evaluate(installOverlay, label);

  let frame = 0;
  for (const shot of SHOTS) {
    if (only && !only.includes(shot.name)) continue;
    const ok = await page.evaluate(
      ([setup, needs]) => {
        const g = window.__game;
        if (needs.some((n) => !(n in g))) return false;
        g.setInput(null);
        g.viewFrom(null);
        window.__demo = {};
        return (0, eval)(`(${setup})`)(g, window.__demo) !== false;
      },
      [shot.setup.toString(), shot.needs ?? []],
    );
    if (!ok) {
      console.log(`  skip ${shot.name} (not in this build)`);
      continue;
    }
    const frames = Math.round(shot.seconds * FPS);
    await page.evaluate(([caption, first]) => window.__demoOverlay(window.__demo.caption ?? caption, first), [shot.caption, frame === 0]);
    process.stdout.write(`  ${shot.name}: ${frames} frames `);
    for (let i = 0; i < frames; i++) {
      await page.evaluate(
        ([fn, i, steps]) => {
          const g = window.__game;
          (window.__demoFrame ??= {})[fn] ??= (0, eval)(`(${fn})`);
          window.__demoFrame[fn](g, window.__demo, i);
          g.advance(steps);
          window.__demoOverlayTick?.(i);
        },
        [shot.frame.toString(), i, STEPS_PER_FRAME],
      );
      await page.screenshot({ path: join(framesDir, `${String(frame++).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
      if (i % 15 === 0) process.stdout.write('.');
    }
    process.stdout.write('\n');
  }

  mkdirSync(dirname(out), { recursive: true });
  const seconds = frame / FPS;
  execFileSync(
    'ffmpeg',
    ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(framesDir, '%05d.jpg'),
      '-vf', `fade=t=in:st=0:d=0.4,fade=t=out:st=${(seconds - 0.5).toFixed(2)}:d=0.5,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-movflags', '+faststart', out],
    { stdio: 'inherit' },
  );
  console.log(`Wrote ${out} (${seconds.toFixed(1)} s)`);
} finally {
  await browser?.close();
  server.kill();
  if (args.ref) git('worktree', 'remove', '--force', appDir);
  rmSync(tmp, { recursive: true, force: true });
}

/** Runs in the page: hides the controls hint and adds a caption and a title card over the canvas. */
function installOverlay(label) {
  for (const el of document.body.querySelectorAll('div')) if (/W\/S move/.test(el.textContent ?? '')) el.remove();
  const style = document.createElement('style');
  style.textContent = `
    .demo-cap { position: fixed; left: 32px; bottom: 28px; padding: 8px 16px; border-radius: 8px;
      background: #0008; color: #fff; font: 600 26px/1.2 'DejaVu Sans', system-ui, sans-serif; }
    .demo-tag { position: fixed; right: 28px; top: 24px; padding: 6px 12px; border-radius: 8px;
      background: #0006; color: #fff; font: 600 20px 'DejaVu Sans', system-ui, sans-serif; }
    .demo-title { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center;
      justify-content: flex-start; padding-top: 9vh; color: #fff; text-shadow: 0 2px 12px #000a; font: 700 64px 'DejaVu Sans', system-ui, sans-serif; }
    .demo-title small { font-size: 30px; font-weight: 600; margin-top: 10px; }`;
  document.head.appendChild(style);
  const cap = Object.assign(document.createElement('div'), { className: 'demo-cap' });
  const tag = Object.assign(document.createElement('div'), { className: 'demo-tag', textContent: `Lizard Game · ${label}` });
  const title = Object.assign(document.createElement('div'), { className: 'demo-title' });
  title.innerHTML = `Lizard Game<small></small>`;
  title.querySelector('small').textContent = label;
  document.body.append(cap, tag, title);
  title.style.opacity = '0';
  window.__demoOverlay = (caption, first) => {
    cap.textContent = caption;
    // The title card sits over the first shot for a second and a half, then fades.
    window.__demoOverlayTick = first ? (i) => (title.style.opacity = String(Math.max(0, Math.min(1, (60 - i) / 15)))) : null;
    cap.style.opacity = first ? '0' : '1';
    if (first) {
      const show = window.__demoOverlayTick;
      window.__demoOverlayTick = (i) => {
        show(i);
        cap.style.opacity = String(Math.max(0, Math.min(1, (i - 50) / 10)));
      };
    } else title.style.opacity = '0';
  };
}
