import { existsSync, mkdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AppConfig } from "./types"

type RawConfig = Partial<
  Omit<AppConfig, "scripts"> & {
    scripts: AppConfig["scripts"]
  }
>

const DEFAULTS = (cwd: string): AppConfig => ({
  dataDir: path.join(cwd, ".piconductor"),
  reposDir: path.join(cwd, ".piconductor", "repos"),
  workspacesDir: path.join(cwd, ".piconductor", "workspaces"),
  dbPath: path.join(cwd, ".piconductor", "piconductor.sqlite"),
  piCommand: "pi",
  defaultModel: undefined,
  maxLogLines: 500,
  scripts: {
    runMode: "concurrent",
  },
})

function readJson(filePath: string): RawConfig {
  const text = readFileSync(filePath, "utf8")
  return JSON.parse(text) as RawConfig
}

function resolveMaybeRelative(baseDir: string, maybePath: string | undefined): string | undefined {
  if (!maybePath) return undefined
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(baseDir, maybePath)
}

function normalizeRaw(raw: RawConfig, baseDir: string): RawConfig {
  return {
    ...raw,
    dataDir: resolveMaybeRelative(baseDir, raw.dataDir),
    reposDir: resolveMaybeRelative(baseDir, raw.reposDir),
    workspacesDir: resolveMaybeRelative(baseDir, raw.workspacesDir),
    dbPath: resolveMaybeRelative(baseDir, raw.dbPath),
  }
}

function merge(base: AppConfig, override: RawConfig): AppConfig {
  return {
    ...base,
    ...override,
    scripts: {
      ...base.scripts,
      ...(override.scripts ?? {}),
    },
  }
}

export interface LoadedConfig {
  config: AppConfig
  userConfigPath: string
  projectConfigPath: string
}

export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const userConfigPath = path.join(os.homedir(), ".config", "piconductor", "config.json")
  const projectConfigPath = path.join(cwd, "piconductor.json")

  let config = DEFAULTS(cwd)

  if (existsSync(userConfigPath)) {
    const rawUser = normalizeRaw(readJson(userConfigPath), path.dirname(userConfigPath))
    config = merge(config, rawUser)
  }

  if (existsSync(projectConfigPath)) {
    const rawProject = normalizeRaw(readJson(projectConfigPath), path.dirname(projectConfigPath))
    config = merge(config, rawProject)
  }

  if (!config.reposDir) config.reposDir = path.join(config.dataDir, "repos")
  if (!config.workspacesDir) config.workspacesDir = path.join(config.dataDir, "workspaces")
  if (!config.dbPath) config.dbPath = path.join(config.dataDir, "piconductor.sqlite")

  mkdirSync(config.dataDir, { recursive: true })
  mkdirSync(config.reposDir, { recursive: true })
  mkdirSync(config.workspacesDir, { recursive: true })

  return { config, userConfigPath, projectConfigPath }
}
