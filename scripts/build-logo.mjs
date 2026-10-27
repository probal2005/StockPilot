#!/usr/bin/env node
/**
 * Writes the StockPilot brand files into public/.
 *
 * The artwork is authored once in src/brand-art.js; this script is the only
 * thing that turns it into files on disk, so brand.jsx and public/ can never
 * disagree. SVG output is dependency-free. Raster app icons (PNG) are produced
 * only when @resvg/resvg-js is installed:
 *
 *   npm install --no-save @resvg/resvg-js && npm run build:logo
 *
 * The committed PNGs in public/ were generated exactly that way.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BRAND, MARK, markSvg, fullLogoSvg, wireframeLayers } from '../src/brand-art.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public')

/** Full-bleed variant for app icons: the light plate fills the whole square. */
const appIconSvg = (size) =>
  markSvg({ size }).replace(
    /(<svg[^>]*>)/,
    `$1<rect x="0" y="0" width="128" height="128" fill="${BRAND.colors.chip}"/>`,
  )

/** Standalone outline mark (the emblem the watermark draws live in the app). */
const wireframeFile = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.viewBox}" width="256" height="256" role="img" aria-label="${BRAND.name} outline">`
  + wireframeLayers().map((l) => `<path d="${l.d}" fill="none" stroke="${BRAND.colors.blue2}" stroke-width="${l.stroke}" stroke-linejoin="round"/>`).join('')
  + `</svg>`

const svgFiles = {
  'logo.svg': markSvg({ size: 512, chip: true }), // as used in the UI: on its plate
  'logo-mark.svg': markSvg({ size: 128 }), // transparent, for light artwork
  'logo-full.svg': fullLogoSvg({ height: 128 }), // lockup with the two-tone wordmark
  'favicon.svg': markSvg({ size: 64, chip: true }),
  'app-icon.svg': appIconSvg(256),
  'mark-wireframe.svg': wireframeFile(),
}

const pngTargets = [
  ['favicon-32.png', markSvg({ size: 32, chip: true }), 32],
  ['apple-touch-icon.png', appIconSvg(512), 180],
  ['icon-192.png', appIconSvg(512), 192],
  ['icon-512.png', appIconSvg(512), 512],
]

await mkdir(out, { recursive: true })
for (const [name, svg] of Object.entries(svgFiles)) {
  await writeFile(join(out, name), `${svg}\n`)
  console.log(`logo  wrote public/${name} (${svg.length} b)`)
}

try {
  const { Resvg } = await import('@resvg/resvg-js')
  for (const [name, svg, size] of pngTargets) {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
    await writeFile(join(out, name), png)
    console.log(`logo  wrote public/${name} (${png.length} b)`)
  }
} catch {
  console.log('logo  @resvg/resvg-js not installed — PNG icons left untouched')
}
