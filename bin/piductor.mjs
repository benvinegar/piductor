#!/usr/bin/env node

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const entrypoint = path.join(__dirname, "..", "src", "main.ts")
const command = process.platform === "win32" ? "bun.exe" : "bun"

const result = spawnSync(command, [entrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
})

const errorCode =
  result.error && typeof result.error === "object" && "code" in result.error
    ? String(result.error.code)
    : undefined

if (errorCode === "ENOENT") {
  console.error("Piductor requires Bun to run.")
  console.error("Install Bun: https://bun.sh")
  process.exit(1)
}

if (typeof result.status === "number") {
  process.exit(result.status)
}

if (result.signal) {
  console.error(`piductor: Bun exited due to signal ${result.signal}.`)
}

process.exit(1)
