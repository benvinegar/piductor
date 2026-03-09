#!/usr/bin/env bun

import { loadConfig } from "./core/config"
import { Store } from "./core/db"
import { PiConductorApp } from "./app"

async function main() {
  const { config } = loadConfig(process.cwd())
  const store = new Store(config.dbPath)

  const app = await PiConductorApp.create(config, store)

  process.on("SIGINT", () => {
    void app.shutdown()
  })

  process.on("SIGTERM", () => {
    void app.shutdown()
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
