import { existsSync, mkdirSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AppConfig } from "./types"

type RawConfig = Partial<
  Omit<AppConfig, "scripts"> & {
    scripts: AppConfig["scripts"]
  }
>

const APP_SLUG = "piductor"
const LEGACY_APP_SLUG = "piconductor"

const DEFAULTS = (cwd: string): AppConfig => ({
  dataDir: path.join(cwd, `.${APP_SLUG}`),
  reposDir: path.join(cwd, `.${APP_SLUG}`, "repos"),
  workspacesDir: path.join(cwd, `.${APP_SLUG}`, "workspaces"),
  dbPath: path.join(cwd, `.${APP_SLUG}`, `${APP_SLUG}.sqlite`),
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

function chooseDbPath(dataDir: string): string {
  const preferred = path.join(dataDir, `${APP_SLUG}.sqlite`)
  const legacy = path.join(dataDir, `${LEGACY_APP_SLUG}.sqlite`)

  if (existsSync(preferred)) return preferred
  if (existsSync(legacy)) return legacy
  return preferred
}

export interface LoadedConfig {
  config: AppConfig
  userConfigPath: string
  projectConfigPath: string
}

export function loadConfig(cwd: string = process.cwd()): LoadedConfig {
  const userConfigPath = path.join(os.homedir(), ".config", APP_SLUG, "config.json")
  const legacyUserConfigPath = path.join(os.homedir(), ".config", LEGACY_APP_SLUG, "config.json")

  const projectConfigPath = path.join(cwd, `${APP_SLUG}.json`)
  const legacyProjectConfigPath = path.join(cwd, `${LEGACY_APP_SLUG}.json`)

  let config = DEFAULTS(cwd)

  const hasUserConfig = existsSync(userConfigPath)
  const hasLegacyUserConfig = existsSync(legacyUserConfigPath)
  const hasProjectConfig = existsSync(projectConfigPath)
  const hasLegacyProjectConfig = existsSync(legacyProjectConfigPath)

  if (hasUserConfig) {
    const rawUser = normalizeRaw(readJson(userConfigPath), path.dirname(userConfigPath))
    config = merge(config, rawUser)
  } else if (hasLegacyUserConfig) {
    const rawUser = normalizeRaw(readJson(legacyUserConfigPath), path.dirname(legacyUserConfigPath))
    config = merge(config, rawUser)
  }

  if (hasProjectConfig) {
    const rawProject = normalizeRaw(readJson(projectConfigPath), path.dirname(projectConfigPath))
    config = merge(config, rawProject)
  } else if (hasLegacyProjectConfig) {
    const rawProject = normalizeRaw(readJson(legacyProjectConfigPath), path.dirname(legacyProjectConfigPath))
    config = merge(config, rawProject)
  }

  const usedAnyConfigFile = hasUserConfig || hasLegacyUserConfig || hasProjectConfig || hasLegacyProjectConfig
  const legacyDataDir = path.join(cwd, `.${LEGACY_APP_SLUG}`)

  if (!usedAnyConfigFile && !existsSync(config.dataDir) && existsSync(legacyDataDir)) {
    config.dataDir = legacyDataDir
    config.reposDir = path.join(legacyDataDir, "repos")
    config.workspacesDir = path.join(legacyDataDir, "workspaces")
    config.dbPath = chooseDbPath(legacyDataDir)
  }

  if (!config.reposDir) config.reposDir = path.join(config.dataDir, "repos")
  if (!config.workspacesDir) config.workspacesDir = path.join(config.dataDir, "workspaces")
  if (!config.dbPath) config.dbPath = chooseDbPath(config.dataDir)

  mkdirSync(config.dataDir, { recursive: true })
  mkdirSync(config.reposDir, { recursive: true })
  mkdirSync(config.workspacesDir, { recursive: true })

  return { config, userConfigPath, projectConfigPath }
}
