export type ThemeKey = "midnight" | "light" | "solarized" | "forest" | "high_contrast"

export interface UiThemeColors {
  appBackground: string
  sidebarBackground: string
  centerBackground: string
  rightBackground: string
  inputBackground: string
  sectionHeaderBackground: string
  sectionHeaderCollapsedBackground: string
  sectionHeaderText: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  textSubtle: string
  accent: string
  accentSoft: string
  accentStrong: string
  success: string
  error: string
  warning: string
  selectedBackground: string
  selectedText: string
  userRowBackground: string
  userRowText: string
  activityText: string
  inputText: string
  inputPlaceholder: string
  inputCursor: string
  commandPaletteBackground: string
  commandPaletteBorder: string
  modalOverlayBackground: string
  modalBackground: string
  modalBorder: string
  markdownCodeBackground: string
  link: string
  diffLineNumberFg: string
  diffLineNumberBg: string
  diffAddedBg: string
  diffRemovedBg: string
  diffContextBg: string
  diffAddedSign: string
  diffRemovedSign: string
  diffAddedLineNumberBg: string
  diffRemovedLineNumberBg: string
  statusActive: string
  statusBusy: string
  statusError: string
  statusIdle: string
}

export interface UiThemeDefinition {
  key: ThemeKey
  name: string
  aliases: string[]
  description: string
  colors: UiThemeColors
}

export const DEFAULT_THEME_KEY: ThemeKey = "midnight"

const THEMES: readonly UiThemeDefinition[] = [
  {
    key: "midnight",
    name: "Midnight",
    aliases: ["dark", "default"],
    description: "Dark blue baseline theme inspired by Codex/OpenCode.",
    colors: {
      appBackground: "#0b1220",
      sidebarBackground: "#11151f",
      centerBackground: "#100f13",
      rightBackground: "#111013",
      inputBackground: "#151922",
      sectionHeaderBackground: "#182031",
      sectionHeaderCollapsedBackground: "#1a2332",
      sectionHeaderText: "#bfdbfe",
      textPrimary: "#e2e8f0",
      textSecondary: "#d1d5db",
      textMuted: "#94a3b8",
      textSubtle: "#64748b",
      accent: "#93c5fd",
      accentSoft: "#60a5fa",
      accentStrong: "#bfdbfe",
      success: "#86efac",
      error: "#fca5a5",
      warning: "#fcd34d",
      selectedBackground: "#1f2937",
      selectedText: "#e2e8f0",
      userRowBackground: "#1e293b",
      userRowText: "#e2e8f0",
      activityText: "#64748b",
      inputText: "#f9fafb",
      inputPlaceholder: "#6b7280",
      inputCursor: "#f9fafb",
      commandPaletteBackground: "#0b1220",
      commandPaletteBorder: "#334155",
      modalOverlayBackground: "#090d15",
      modalBackground: "#0f172a",
      modalBorder: "#60a5fa",
      markdownCodeBackground: "#111827",
      link: "#60a5fa",
      diffLineNumberFg: "#64748b",
      diffLineNumberBg: "#0b1220",
      diffAddedBg: "#123320",
      diffRemovedBg: "#3d1823",
      diffContextBg: "#0b1220",
      diffAddedSign: "#86efac",
      diffRemovedSign: "#fca5a5",
      diffAddedLineNumberBg: "#123320",
      diffRemovedLineNumberBg: "#3d1823",
      statusActive: "#86efac",
      statusBusy: "#93c5fd",
      statusError: "#fca5a5",
      statusIdle: "#94a3b8",
    },
  },
  {
    key: "light",
    name: "Light",
    aliases: ["day"],
    description: "Light high-readability theme for daytime terminals.",
    colors: {
      appBackground: "#f1f5f9",
      sidebarBackground: "#ffffff",
      centerBackground: "#ffffff",
      rightBackground: "#ffffff",
      inputBackground: "#e2e8f0",
      sectionHeaderBackground: "#dbeafe",
      sectionHeaderCollapsedBackground: "#e2e8f0",
      sectionHeaderText: "#1e3a8a",
      textPrimary: "#0f172a",
      textSecondary: "#334155",
      textMuted: "#475569",
      textSubtle: "#64748b",
      accent: "#2563eb",
      accentSoft: "#3b82f6",
      accentStrong: "#1d4ed8",
      success: "#15803d",
      error: "#b91c1c",
      warning: "#a16207",
      selectedBackground: "#dbeafe",
      selectedText: "#0f172a",
      userRowBackground: "#dbeafe",
      userRowText: "#0f172a",
      activityText: "#64748b",
      inputText: "#0f172a",
      inputPlaceholder: "#64748b",
      inputCursor: "#0f172a",
      commandPaletteBackground: "#eff6ff",
      commandPaletteBorder: "#93c5fd",
      modalOverlayBackground: "#cbd5e1",
      modalBackground: "#ffffff",
      modalBorder: "#3b82f6",
      markdownCodeBackground: "#f1f5f9",
      link: "#2563eb",
      diffLineNumberFg: "#64748b",
      diffLineNumberBg: "#e2e8f0",
      diffAddedBg: "#dcfce7",
      diffRemovedBg: "#fee2e2",
      diffContextBg: "#f1f5f9",
      diffAddedSign: "#166534",
      diffRemovedSign: "#991b1b",
      diffAddedLineNumberBg: "#bbf7d0",
      diffRemovedLineNumberBg: "#fecaca",
      statusActive: "#15803d",
      statusBusy: "#2563eb",
      statusError: "#b91c1c",
      statusIdle: "#64748b",
    },
  },
  {
    key: "solarized",
    name: "Solarized",
    aliases: ["sol"],
    description: "Solarized-inspired theme with warm contrast.",
    colors: {
      appBackground: "#002b36",
      sidebarBackground: "#073642",
      centerBackground: "#002b36",
      rightBackground: "#073642",
      inputBackground: "#0a3a46",
      sectionHeaderBackground: "#0b3b47",
      sectionHeaderCollapsedBackground: "#12424e",
      sectionHeaderText: "#93a1a1",
      textPrimary: "#eee8d5",
      textSecondary: "#93a1a1",
      textMuted: "#839496",
      textSubtle: "#657b83",
      accent: "#268bd2",
      accentSoft: "#2aa198",
      accentStrong: "#6c71c4",
      success: "#859900",
      error: "#dc322f",
      warning: "#b58900",
      selectedBackground: "#12424e",
      selectedText: "#eee8d5",
      userRowBackground: "#12424e",
      userRowText: "#eee8d5",
      activityText: "#657b83",
      inputText: "#eee8d5",
      inputPlaceholder: "#657b83",
      inputCursor: "#eee8d5",
      commandPaletteBackground: "#073642",
      commandPaletteBorder: "#2aa198",
      modalOverlayBackground: "#001f27",
      modalBackground: "#073642",
      modalBorder: "#268bd2",
      markdownCodeBackground: "#073642",
      link: "#268bd2",
      diffLineNumberFg: "#657b83",
      diffLineNumberBg: "#073642",
      diffAddedBg: "#11422f",
      diffRemovedBg: "#4a1f27",
      diffContextBg: "#073642",
      diffAddedSign: "#859900",
      diffRemovedSign: "#dc322f",
      diffAddedLineNumberBg: "#11422f",
      diffRemovedLineNumberBg: "#4a1f27",
      statusActive: "#859900",
      statusBusy: "#268bd2",
      statusError: "#dc322f",
      statusIdle: "#839496",
    },
  },
  {
    key: "forest",
    name: "Forest",
    aliases: ["green"],
    description: "Low-glare green-biased dark theme.",
    colors: {
      appBackground: "#0a1611",
      sidebarBackground: "#102018",
      centerBackground: "#0d1913",
      rightBackground: "#102018",
      inputBackground: "#14251d",
      sectionHeaderBackground: "#1a2d23",
      sectionHeaderCollapsedBackground: "#203428",
      sectionHeaderText: "#a7f3d0",
      textPrimary: "#dcfce7",
      textSecondary: "#bbf7d0",
      textMuted: "#86efac",
      textSubtle: "#4ade80",
      accent: "#34d399",
      accentSoft: "#10b981",
      accentStrong: "#6ee7b7",
      success: "#86efac",
      error: "#fca5a5",
      warning: "#fde68a",
      selectedBackground: "#1f3429",
      selectedText: "#dcfce7",
      userRowBackground: "#1f3429",
      userRowText: "#dcfce7",
      activityText: "#4ade80",
      inputText: "#ecfdf5",
      inputPlaceholder: "#6b7280",
      inputCursor: "#ecfdf5",
      commandPaletteBackground: "#0f1f18",
      commandPaletteBorder: "#2f5945",
      modalOverlayBackground: "#07120e",
      modalBackground: "#102018",
      modalBorder: "#34d399",
      markdownCodeBackground: "#0b1b14",
      link: "#34d399",
      diffLineNumberFg: "#4ade80",
      diffLineNumberBg: "#0f1f18",
      diffAddedBg: "#103122",
      diffRemovedBg: "#3a1e24",
      diffContextBg: "#0f1f18",
      diffAddedSign: "#86efac",
      diffRemovedSign: "#fca5a5",
      diffAddedLineNumberBg: "#103122",
      diffRemovedLineNumberBg: "#3a1e24",
      statusActive: "#86efac",
      statusBusy: "#34d399",
      statusError: "#fca5a5",
      statusIdle: "#6ee7b7",
    },
  },
  {
    key: "high_contrast",
    name: "High Contrast",
    aliases: ["contrast", "hc"],
    description: "High-contrast accessibility-focused dark theme.",
    colors: {
      appBackground: "#000000",
      sidebarBackground: "#050505",
      centerBackground: "#000000",
      rightBackground: "#050505",
      inputBackground: "#0d0d0d",
      sectionHeaderBackground: "#111111",
      sectionHeaderCollapsedBackground: "#1a1a1a",
      sectionHeaderText: "#ffffff",
      textPrimary: "#ffffff",
      textSecondary: "#f1f5f9",
      textMuted: "#cbd5e1",
      textSubtle: "#94a3b8",
      accent: "#38bdf8",
      accentSoft: "#0ea5e9",
      accentStrong: "#7dd3fc",
      success: "#4ade80",
      error: "#f87171",
      warning: "#facc15",
      selectedBackground: "#1f2937",
      selectedText: "#ffffff",
      userRowBackground: "#1e293b",
      userRowText: "#ffffff",
      activityText: "#94a3b8",
      inputText: "#ffffff",
      inputPlaceholder: "#94a3b8",
      inputCursor: "#ffffff",
      commandPaletteBackground: "#0d0d0d",
      commandPaletteBorder: "#475569",
      modalOverlayBackground: "#000000",
      modalBackground: "#0a0a0a",
      modalBorder: "#38bdf8",
      markdownCodeBackground: "#111111",
      link: "#38bdf8",
      diffLineNumberFg: "#94a3b8",
      diffLineNumberBg: "#0d0d0d",
      diffAddedBg: "#102414",
      diffRemovedBg: "#351518",
      diffContextBg: "#0d0d0d",
      diffAddedSign: "#4ade80",
      diffRemovedSign: "#f87171",
      diffAddedLineNumberBg: "#102414",
      diffRemovedLineNumberBg: "#351518",
      statusActive: "#4ade80",
      statusBusy: "#38bdf8",
      statusError: "#f87171",
      statusIdle: "#cbd5e1",
    },
  },
]

const THEME_BY_KEY = new Map(THEMES.map((theme) => [theme.key, theme]))

export function listThemes(): readonly UiThemeDefinition[] {
  return THEMES
}

export function getThemeByKey(themeKey: ThemeKey): UiThemeDefinition {
  return THEME_BY_KEY.get(themeKey) ?? THEME_BY_KEY.get(DEFAULT_THEME_KEY)!
}

export function resolveThemeKey(input: string | null | undefined): ThemeKey | null {
  if (!input) {
    return null
  }

  const normalized = input.trim().toLowerCase().replace(/[\s-]+/g, "_")
  if (!normalized) {
    return null
  }

  for (const theme of THEMES) {
    if (theme.key === normalized) {
      return theme.key
    }

    if (theme.aliases.some((alias) => alias.toLowerCase().replace(/[\s-]+/g, "_") === normalized)) {
      return theme.key
    }

    const normalizedName = theme.name.toLowerCase().replace(/[\s-]+/g, "_")
    if (normalizedName === normalized) {
      return theme.key
    }
  }

  return null
}

export function nextThemeKey(current: ThemeKey): ThemeKey {
  const index = THEMES.findIndex((theme) => theme.key === current)
  if (index === -1) {
    return DEFAULT_THEME_KEY
  }

  const next = THEMES[(index + 1) % THEMES.length]
  return next?.key ?? DEFAULT_THEME_KEY
}

export type ParsedThemeArgs =
  | { action: "show" }
  | { action: "list" }
  | { action: "next" }
  | { action: "set"; themeKey: ThemeKey }

export function parseThemeArgs(args: string[]): ParsedThemeArgs | null {
  if (args.length === 0) {
    return { action: "show" }
  }

  const sub = args[0]?.toLowerCase() ?? ""

  if (sub === "list") {
    return { action: "list" }
  }

  if (sub === "show") {
    return { action: "show" }
  }

  if (sub === "next") {
    return { action: "next" }
  }

  if (sub === "set") {
    const target = resolveThemeKey(args[1])
    if (!target) {
      return null
    }
    return { action: "set", themeKey: target }
  }

  const direct = resolveThemeKey(args.join(" "))
  if (!direct) {
    return null
  }

  return { action: "set", themeKey: direct }
}

export function themeUsage(): string {
  return "Usage: /theme [show|list|next|set <theme>|<theme>]"
}

export function toThemeMarkdown(currentTheme: ThemeKey): string {
  const lines = ["## Themes", ""]

  for (const theme of THEMES) {
    const marker = theme.key === currentTheme ? "**(active)**" : ""
    lines.push(`- \`${theme.key}\` ${marker} — ${theme.description}`.trim())
  }

  lines.push("")
  lines.push("Examples:")
  lines.push("- `/theme list`")
  lines.push("- `/theme next`")
  lines.push("- `/theme set solarized`")

  return lines.join("\n")
}
