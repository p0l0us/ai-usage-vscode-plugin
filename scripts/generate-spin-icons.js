// Generates media/spin-icons.ttf and its `contributes.icons` entries in package.json: the Claude, Codex and Copilot logos,
// each rotated through FRAMES steps of one full turn. VS Code animates `~spin` only on a few built-in icons (sync,
// loading, gear), so `$(claude~spin)` stays still; the status bar instead cycles these frames while a reading loads
// (see SPIN_FRAMES in src/statusItem.ts, which must match FRAMES).
//
// The logo outlines in media/icons/ are the `claude`, `openai` and `copilot` icons of @vscode/codicons
// (https://github.com/microsoft/vscode-codicons), CC BY 4.0, © Microsoft Corporation; rotation is the only change.
// Run with `node scripts/generate-spin-icons.js` after changing the outlines or the frame count. Idempotent.
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const FRAMES = 24;
const LOGOS = [{ id: 'claude', title: 'Claude' }, { id: 'openai', title: 'Codex' }, { id: 'copilot', title: 'Copilot' }];
const FIRST_CODEPOINT = 0xe000;
const FONT = 'media/spin-icons.ttf';
const PREFIX = 'ai-usage-spin-';
const root = path.resolve(__dirname, '..');

async function main() {
  const { SVGIcons2SVGFontStream } = require('svgicons2svgfont');
  const svg2ttf = require('svg2ttf');
  const font = new SVGIcons2SVGFontStream({ fontName: 'ai-usage-spin', fontHeight: 1000, normalize: false, log: () => {} });
  const chunks = [];
  font.on('data', (chunk) => chunks.push(chunk));
  const done = new Promise((resolve, reject) => { font.on('end', resolve); font.on('error', reject); });
  const icons = {};
  let codepoint = FIRST_CODEPOINT;
  for (const logo of LOGOS) {
    const source = fs.readFileSync(path.join(root, 'media/icons', `${logo.id}.svg`), 'utf8');
    const outline = /<path[^>]*\sd="([^"]+)"/.exec(source)[1];
    for (let frame = 0; frame < FRAMES; frame++) {
      const name = `${PREFIX}${logo.id}-${frame}`;
      const angle = (360 / FRAMES) * frame;
      const glyph = Readable.from([`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">`
        + `<path transform="rotate(${angle} 8 8)" d="${outline}"/></svg>`]);
      glyph.metadata = { name, unicode: [String.fromCodePoint(codepoint)] };
      font.write(glyph);
      icons[name] = {
        description: `${logo.title} logo rotated ${angle}°, shown while a reading loads`,
        default: { fontPath: `./${FONT}`, fontCharacter: `\\${codepoint.toString(16).toUpperCase()}` }
      };
      codepoint++;
    }
  }
  font.end();
  await done;
  const ttf = svg2ttf(chunks.map(String).join(''), { ts: 0 });
  fs.writeFileSync(path.join(root, FONT), Buffer.from(ttf.buffer));

  const manifestPath = path.join(root, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const existing = manifest.contributes.icons ?? {};
  for (const key of Object.keys(existing)) if (key.startsWith(PREFIX)) delete existing[key];
  manifest.contributes.icons = { ...existing, ...icons };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${FONT} and ${Object.keys(icons).length} icon contributions`);
}

main().catch((error) => { console.error(error); process.exit(1); });
