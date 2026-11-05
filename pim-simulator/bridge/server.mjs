#!/usr/bin/env node
/**
 * bridge/server.mjs — host-side bridge between the real UPMEM kernels and the
 * dashboard.
 *
 *   GET /api/run?kernel=VA&dpus=4   spawn make + host binary, stream JSON via SSE
 *   GET /api/runs                    list saved .jsonl runs
 *   GET /api/runs/:name              fetch one saved run
 *   GET /health                      liveness probe
 *
 * No npm dependencies: Node's http + child_process are enough.
 *
 * The kernel host writes one JSON object per line on stderr:
 *   {"event":"meta",...} {"event":"phase",...} {"event":"dpu",...}
 * We forward only those lines; make/SDK chatter goes to this process's stdout.
 */

import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SIM_ROOT = path.resolve(HERE, '..')
const KERNEL_ROOT = path.resolve(SIM_ROOT, '../pim-kernels')
const RUN_DIR = path.join(KERNEL_ROOT, 'runs')
const ENV_SCRIPT =
  process.env.UPMEM_ENV ?? path.resolve(SIM_ROOT, '../../upmem-env.sh')
const PORT = Number(process.env.PORT ?? 8787)

const KERNELS = {
  VA: 'va',
  GEMV: 'gemv',
  RED: 'red',
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

async function listRuns() {
  try {
    const names = await readdir(RUN_DIR)
    return names.filter((n) => n.endsWith('.jsonl')).sort().reverse()
  } catch {
    return []
  }
}

function runKernel(kernel, dpus, req, res) {
  const target = KERNELS[kernel]
  if (!target) return sendJson(res, 400, { error: `unknown kernel ${kernel}` })
  if (!Number.isInteger(dpus) || dpus < 1 || dpus > 64) {
    return sendJson(res, 400, { error: 'dpus must be an integer in 1..64' })
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...CORS,
  })
  res.write(`: bridge connected — ${kernel} on ${dpus} DPU(s)\n\n`)

  const command = [
    `source ${shellQuote(ENV_SCRIPT)} >/dev/null 2>&1`,
    `cd ${shellQuote(KERNEL_ROOT)}`,
    `make ${target} NR_DPUS=${dpus}`,
    `PIM_EVENTS=1 ./build/${target}_host`,
  ].join(' && ')

  const child = spawn('bash', ['-lc', command], {
    env: { ...process.env, PIM_EVENTS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const events = []
  let finished = false
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keep-alive\n\n')
  }, 15000)

  const forward = (line) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) {
      console.log(`[${kernel}] ${trimmed}`)
      return
    }
    try {
      const event = JSON.parse(trimmed)
      if (!event || typeof event.event !== 'string') return
      events.push(event)
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch {
      // partial / non-JSON line: ignore
    }
  }

  let stderrBuffer = ''
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString()
    const lines = stderrBuffer.split(/\r?\n/)
    stderrBuffer = lines.pop() ?? ''
    for (const line of lines) forward(line)
  })
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))

  const finish = async (code) => {
    if (finished) return
    finished = true
    clearInterval(heartbeat)
    if (stderrBuffer.trim()) forward(stderrBuffer)

    let saved = null
    if (events.length) {
      try {
        await mkdir(RUN_DIR, { recursive: true })
        saved = `${Date.now()}-${kernel}-${dpus}dpu.jsonl`
        await writeFile(path.join(RUN_DIR, saved), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      } catch (err) {
        console.error('could not save run:', err.message)
      }
    }

    const done = { event: 'done', ok: code === 0, code, saved }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(done)}\n\n`)
      res.write('event: done\ndata: {}\n\n')
      res.end()
    }
    console.log(`[${kernel}] finished code=${code}${saved ? ` saved=${saved}` : ''}`)
  }

  child.on('close', (code) => finish(code ?? -1))
  child.on('error', (err) => {
    console.error('spawn failed:', err.message)
    forward(JSON.stringify({ event: 'done', ok: false, code: -1 }))
    finish(-1)
  })

  req.on('close', () => {
    if (!finished) {
      finished = true
      clearInterval(heartbeat)
      child.kill('SIGTERM')
    }
  })
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    return res.end()
  }

  if (url.pathname === '/health') {
    return sendJson(res, 200, {
      ok: true,
      kernelRoot: KERNEL_ROOT,
      env: ENV_SCRIPT,
      runs: (await listRuns()).length,
    })
  }

  if (url.pathname === '/api/runs') {
    return sendJson(res, 200, { runs: await listRuns() })
  }

  if (url.pathname.startsWith('/api/runs/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/runs/'.length))
    if (!/^[\w.-]+\.jsonl$/.test(name)) return sendJson(res, 400, { error: 'bad name' })
    try {
      const text = await readFile(path.join(RUN_DIR, name), 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', ...CORS })
      return res.end(text)
    } catch {
      return sendJson(res, 404, { error: 'not found' })
    }
  }

  if (url.pathname === '/api/run') {
    const kernel = (url.searchParams.get('kernel') ?? 'VA').toUpperCase()
    const dpus = Number(url.searchParams.get('dpus') ?? 4)
    return runKernel(kernel, dpus, req, res)
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', ...CORS })
  res.end(
    [
      'UPMEM PIM bridge',
      '',
      'GET /api/run?kernel=VA|GEMV|RED&dpus=4   SSE run',
      'GET /api/runs                           saved runs',
      'GET /api/runs/:name                     replay one run',
      'GET /health                             probe',
      '',
      `kernels: ${KERNEL_ROOT}`,
      `env:     ${ENV_SCRIPT}`,
    ].join('\n')
  )
})

server.listen(PORT, () => {
  console.log(`UPMEM bridge on http://localhost:${PORT}`)
  console.log(`  kernels: ${KERNEL_ROOT}`)
  console.log(`  env:     ${ENV_SCRIPT}`)
  console.log(`  runs:    ${RUN_DIR}`)
})
