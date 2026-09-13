/**
 * Build script: builds backend + frontend + Electron main, and assembles the
 * runtime layout under desktop/dist/:
 *
 *   dist/main.js, dist/preload.js   (Electron, from src/)
 *   dist/backend/**                 (compiled Express API + schema.sql)
 *   dist/frontend/**                (built React app)
 *
 * Everything under dist/ ships inside the app bundle, so `require()` from
 * dist/backend resolves desktop/node_modules in dev and packaged builds.
 *
 * Usage: node scripts/build-all.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const desktop = path.resolve(__dirname, '..');
const backendDir = path.join(root, 'backend');
const frontendDir = path.join(root, 'frontend');
const distDir = path.join(desktop, 'dist');

function run(cmd, cwd) {
  console.log(`> ${cmd}  (in ${path.relative(root, cwd || root) || '.'})`);
  execSync(cmd, { cwd: cwd || root, stdio: 'inherit', shell: true });
}

function copyDir(src, dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

console.log('\n=== Building backend ===');
run('npm run build', backendDir);

console.log('\n=== Building frontend ===');
run('npm run build', frontendDir);

console.log('\n=== Compiling Electron main/preload ===');
fs.rmSync(distDir, { recursive: true, force: true });
run('npm run build:electron', desktop);

console.log('\n=== Assembling dist/ ===');
copyDir(path.join(backendDir, 'dist'), path.join(distDir, 'backend'));
// Drop test helpers from the shipped bundle.
fs.rmSync(path.join(distDir, 'backend', 'test'), { recursive: true, force: true });
copyDir(path.join(frontendDir, 'dist'), path.join(distDir, 'frontend'));

console.log('\n=== Build complete ===');
console.log('Run:      npm start        (in desktop/)');
console.log('Package:  npm run dist     (in desktop/)  -> release/');
