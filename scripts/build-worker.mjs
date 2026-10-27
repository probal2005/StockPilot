// Bundles the Worker into a single ES module for deployment.
import { build } from 'esbuild'

await build({
  entryPoints: ['worker/index.js'],
  outfile: 'build/worker.js',
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['workerd', 'worker', 'browser'],
  sourcemap: false,
  legalComments: 'none',
})
console.log('built build/worker.js')
