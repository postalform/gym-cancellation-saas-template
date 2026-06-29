import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()
const DEV_VARS_FILE = path.join(ROOT, '.dev.vars')
const ENV_FILE = path.join(ROOT, '.env')

const DEFAULTS = {
  APP_NAME: 'Gym Cancellation SaaS',
  CHECKOUT_AMOUNT_CENTS: '1299',
  CHECKOUT_CURRENCY: 'usd',
  CHECKOUT_DISPLAY_NAME: 'Gym Cancellation SaaS',
  POSTALFORM_API_BASE: 'https://projects.postalform.com/api',
  POSTALFORM_MODE: 'test',
  STRIPE_API_VERSION: '2025-09-30.clover',
}

const SECRET_KEYS = [
  'STRIPE_SECRET_KEY',
  'POSTALFORM_API_KEY',
  'POSTALFORM_TEST_API_KEY',
  'POSTALFORM_LIVE_API_KEY',
  'POSTALFORM_ENV',
  'POSTALFORM_CREDENTIALS',
]

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {}

  const values = {}
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const separatorIndex = trimmed.indexOf('=')
    if (separatorIndex === -1) continue
    const key = trimmed.slice(0, separatorIndex).trim()
    const value = unquote(trimmed.slice(separatorIndex + 1).trim())
    if (key) values[key] = value
  }
  return values
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function serializeEnv(values) {
  const keys = Object.keys(values).sort()
  return `${keys.map((key) => `${key}=${quoteEnv(values[key])}`).join('\n')}\n`
}

function quoteEnv(value) {
  const stringValue = String(value ?? '')
  if (/^[A-Za-z0-9_./:@-]*$/.test(stringValue)) return stringValue
  return JSON.stringify(stringValue)
}

function tryPullProjectsEnv() {
  try {
    execFileSync('stripe', ['projects', 'env', '--pull'], {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
  } catch {
    console.warn('Could not pull Stripe Projects env. Continuing with local values.')
  }
}

function readStripeCliTestSecretKey() {
  const configOutput = readStripeCliConfig()
  if (!configOutput) return ''

  let activeProfile = 'default'
  for (const line of configOutput.split(/\r?\n/)) {
    const match = line.match(/^project-name\s*=\s*["']([^"']+)["']/)
    if (match) {
      activeProfile = match[1]
      break
    }
  }

  let inActiveProfile = false
  for (const line of configOutput.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === `[${activeProfile}]`) {
      inActiveProfile = true
      continue
    }
    if (/^\[.+\]$/.test(trimmed)) {
      inActiveProfile = false
      continue
    }
    if (!inActiveProfile) continue

    const match = trimmed.match(/^test_mode_api_key\s*=\s*["']([^"']+)["']/)
    if (match && match[1].startsWith('sk_test_')) return match[1]
  }

  return ''
}

function readStripeCliConfig() {
  try {
    return execFileSync('stripe', ['config', '--list'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    const configPath = path.join(os.homedir(), '.config', 'stripe', 'config.toml')
    return existsSync(configPath) ? readFileSync(configPath, 'utf8') : ''
  }
}

function publicOrSecretValues(values) {
  const selected = {}
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('CLOUDFLARE_')) continue
    if (key in DEFAULTS || SECRET_KEYS.includes(key)) selected[key] = value
  }
  return selected
}

tryPullProjectsEnv()

const envValues = parseEnvFile(ENV_FILE)
const devVarValues = parseEnvFile(DEV_VARS_FILE)
const nextValues = {
  ...DEFAULTS,
  ...publicOrSecretValues(envValues),
  ...publicOrSecretValues(devVarValues),
}

if (!nextValues.STRIPE_SECRET_KEY) {
  const stripeSecretKey = readStripeCliTestSecretKey()
  if (stripeSecretKey) nextValues.STRIPE_SECRET_KEY = stripeSecretKey
}

writeFileSync(DEV_VARS_FILE, serializeEnv(nextValues), 'utf8')

const missing = []
if (!nextValues.STRIPE_SECRET_KEY) missing.push('STRIPE_SECRET_KEY')
if (
  !nextValues.POSTALFORM_TEST_API_KEY &&
  !nextValues.POSTALFORM_API_KEY &&
  !nextValues.POSTALFORM_ENV &&
  !nextValues.POSTALFORM_CREDENTIALS
) {
  missing.push('POSTALFORM_TEST_API_KEY')
}

console.log(`Wrote ${path.relative(ROOT, DEV_VARS_FILE)}.`)
if (missing.length > 0) {
  console.log(`Still needed before checkout can run: ${missing.join(', ')}`)
}
