import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const WRANGLER_CONFIG = path.join(ROOT, 'wrangler.toml')
const CLOUDFLARE_ENV_DENYLIST = new Set([
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_WORKER_NAME',
  'CLOUDFLARE_WORKERS_URL',
])

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

async function runCommand(command, args, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: options.env ?? process.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    })

    if (options.stdin) child.stdin.write(options.stdin)
    child.stdin.end()
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve(undefined)
      else reject(new Error(`Command failed: ${command} ${args.join(' ')}`))
    })
  })
}

function collectSecretValues(values) {
  const result = {}
  for (const [key, rawValue] of Object.entries(values)) {
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!value || CLOUDFLARE_ENV_DENYLIST.has(key)) continue
    if (key.startsWith('CLOUDFLARE_')) continue
    result[key] = value
  }
  return result
}

function updateWorkerName(workerName) {
  if (!workerName || !existsSync(WRANGLER_CONFIG)) return
  const current = readFileSync(WRANGLER_CONFIG, 'utf8')
  const next = current.replace(/^name\s*=\s*"[^"]+"/m, `name = ${JSON.stringify(workerName)}`)
  if (next !== current) writeFileSync(WRANGLER_CONFIG, next, 'utf8')
}

async function syncSecrets({ accountId, apiToken, secrets, workerName }) {
  const synced = []
  for (const [key, value] of Object.entries(secrets)) {
    await runCommand(
      'npx',
      ['wrangler', 'secret', 'put', key, '--name', workerName, '--config', WRANGLER_CONFIG],
      {
        env: {
          ...process.env,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          CLOUDFLARE_API_TOKEN: apiToken,
        },
        stdin: `${value}\n`,
      }
    )
    synced.push(key)
  }
  return synced
}

async function main() {
  const localValues = {
    ...parseEnvFile(path.join(ROOT, '.env')),
    ...parseEnvFile(path.join(ROOT, '.dev.vars')),
  }
  for (const [key, value] of Object.entries(localValues)) {
    if (!(key in process.env)) process.env[key] = value
  }

  const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
  const workerName = process.env.CLOUDFLARE_WORKER_NAME?.trim() || 'gym-cancellation-saas'

  if (!apiToken || !accountId) {
    throw new Error(
      'Missing Cloudflare deployment credentials. Run `stripe projects env --pull`, then `npm run setup`, and confirm CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are present in .env.'
    )
  }

  updateWorkerName(workerName)
  const synced = await syncSecrets({
    accountId,
    apiToken,
    secrets: collectSecretValues(localValues),
    workerName,
  })

  await runCommand('npx', ['wrangler', 'deploy', '--config', WRANGLER_CONFIG], {
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: accountId,
      CLOUDFLARE_API_TOKEN: apiToken,
    },
  })

  console.log('Deployment completed.')
  if (synced.length > 0) console.log(`Synced secrets: ${synced.sort().join(', ')}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
