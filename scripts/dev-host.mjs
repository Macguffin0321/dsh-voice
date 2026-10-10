/**
 * Development launcher: run a DSH profile as a plain web host on a spare port.
 *
 * The packaged Desktop host hard-codes `--port 19387`, so a second instance
 * cannot boot while the application runs. This script performs the same two
 * calls the Desktop host's `main()` performs — load the profile directory, then
 * `runProfile` through the Web application — with the port passed in, which is
 * how the plugin is exercised end to end without restarting the application.
 *
 * It must run inside Electron (`ELECTRON_RUN_AS_NODE=1`) because the harness
 * packages live inside `app.asar`, which only Electron can read.
 *
 * Usage:
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --expose-internals scripts/dev-host.mjs <profile-dir> [port]
 *
 * @module dsh-voice/scripts/dev-host
 */

const asar = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh'
const appBoot = await import(`${asar}/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`)
const profileBoot = await import(`${asar}/node_modules/@deepseek-ai/dsh/lib/profile-boot.js`)

const profileDir = process.argv[2]
const port = process.argv[3] ?? '5099'

if (typeof profileDir !== 'string' || profileDir === '') {
  console.error('dev-host: usage: dev-host.mjs <profile-dir> [port]')
  process.exit(2)
}

const installAnchor = `${asar}/node_modules/@deepseek-ai/dsh/package.json`
const profile = appBoot.loadProfileDirectory('dsh', profileDir, installAnchor)
appBoot.reportSkippedBundles('dsh', profile)

const application = profileBoot.runProfile({
  environment: appBoot.loadLayeredEnv('dsh'),
  profile: 'desktop',
  resolvedProfile: { profile, installAnchor },
  patchFiles: [],
  args: ['--no-open', '--port', String(port)],
})

await application
