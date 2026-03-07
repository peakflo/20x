import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  interpolate,
  spring,
  useVideoConfig,
  Sequence,
} from "remotion";

// ── Color tokens (dark theme matching 20x) ──────────────────
const colors = {
  bg: "#09090b",
  bgCard: "#18181b",
  bgSidebar: "#0f0f12",
  border: "#27272a",
  foreground: "#fafafa",
  muted: "#71717a",
  accent: "#27272a",
  accentFg: "#fafafa",
  green: "#22c55e",
  greenBg: "rgba(34,197,94,0.1)",
  blue: "#60a5fa",
  blueBg: "rgba(96,165,250,0.1)",
  destructive: "#ef4444",
  destructiveBg: "rgba(239,68,68,0.1)",
  ring: "#3f3f46",
  primary: "#fafafa",
  primaryBg: "#fafafa",
  primaryFg: "#09090b",
};

// ── Mock data ───────────────────────────────────────────────
const installedPlugins = [
  {
    name: "code-review-agent",
    version: "2.1.0",
    enabled: true,
    scope: "workspace",
    description:
      "Automated code review agent that analyzes PRs for bugs, security issues, and style violations using configurable rulesets.",
    keywords: ["code-review", "security", "linting", "AI"],
  },
  {
    name: "jira-sync",
    version: "1.4.2",
    enabled: true,
    scope: "user",
    description:
      "Bidirectional sync between 20x tasks and Jira issues. Supports custom field mapping and status transitions.",
    keywords: ["jira", "sync", "project-management"],
  },
  {
    name: "terraform-assistant",
    version: "0.9.1",
    enabled: false,
    scope: "workspace",
    description:
      "Infrastructure-as-code helper for Terraform. Generates plans, detects drift, and suggests resource optimizations.",
    keywords: ["terraform", "IaC", "devops", "cloud"],
  },
];

const discoverablePlugins = [
  {
    name: "docker-compose-helper",
    version: "1.2.0",
    author: "cloudtools",
    description:
      "Generate, validate, and optimize Docker Compose files. Supports multi-stage builds and health checks.",
    category: "devops",
    tags: ["docker", "containers", "compose"],
    marketplace: "claude-community",
    installed: false,
  },
  {
    name: "api-docs-generator",
    version: "3.0.1",
    author: "docsmith",
    description:
      "Auto-generate OpenAPI specs and beautiful API documentation from your codebase. Supports REST and GraphQL.",
    category: "documentation",
    tags: ["openapi", "swagger", "docs"],
    marketplace: "claude-community",
    installed: false,
  },
  {
    name: "db-migration-wizard",
    version: "1.0.5",
    author: "dataforge",
    description:
      "Schema migration tool with rollback support. Generates type-safe migrations for PostgreSQL, MySQL, and SQLite.",
    category: "database",
    tags: ["migrations", "sql", "schema"],
    marketplace: "claude-community",
    installed: false,
  },
  {
    name: "test-generator",
    version: "2.3.0",
    author: "testcraft",
    description:
      "AI-powered test generation for TypeScript and Python. Creates unit, integration, and e2e tests from source code.",
    category: "testing",
    tags: ["testing", "vitest", "jest", "pytest"],
    marketplace: "anthropic-official",
    installed: true,
  },
];

const marketplaceSources = [
  {
    name: "anthropic-official",
    type: "github",
    url: "anthropics/claude-plugins",
  },
  {
    name: "claude-community",
    type: "github",
    url: "claude-community/marketplace",
  },
];

// ── SVG Icons (inline to avoid lucide dep) ──────────────────

const SearchIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
);

const PuzzleIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15.39 4.39a1 1 0 0 0 .61.22 1 1 0 0 0 .71-.29l1.58-1.58a1 1 0 0 1 1.42 0l1.17 1.17a1 1 0 0 1 0 1.42L19.3 6.91a1 1 0 0 0 .07 1.32A3.5 3.5 0 0 1 20.5 11H21a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-.5a3.5 3.5 0 0 1-1.13 2.77 1 1 0 0 0-.07 1.32l1.58 1.58a1 1 0 0 1 0 1.42l-1.17 1.17a1 1 0 0 1-1.42 0l-1.58-1.58a1 1 0 0 0-1.32-.07A3.5 3.5 0 0 1 13 21.5V22a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-.5a3.5 3.5 0 0 1-2.77-1.13 1 1 0 0 0-1.32-.07L3.33 21.88a1 1 0 0 1-1.42 0L.74 20.71a1 1 0 0 1 0-1.42l1.58-1.58a1 1 0 0 0 .07-1.32A3.5 3.5 0 0 1 1.5 13H1a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1h.5a3.5 3.5 0 0 1 1.13-2.77 1 1 0 0 0 .07-1.32L1.12 3.33a1 1 0 0 1 0-1.42L2.29.74a1 1 0 0 1 1.42 0L5.29 2.3a1 1 0 0 0 1.32.07A3.5 3.5 0 0 1 9 1.5V1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.5a3.5 3.5 0 0 1 2.39 1.89Z" />
  </svg>
);

const SettingsIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const UsersIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);

const ServerIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="20" height="8" x="2" y="2" rx="2" ry="2" />
    <rect width="20" height="8" x="2" y="14" rx="2" ry="2" />
    <line x1="6" x2="6.01" y1="6" y2="6" />
    <line x1="6" x2="6.01" y1="18" y2="18" />
  </svg>
);

const KeyIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" />
    <path d="m21 2-9.6 9.6" />
    <circle cx="7.5" cy="15.5" r="5.5" />
  </svg>
);

const WorkflowIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect width="8" height="8" x="3" y="3" rx="2" />
    <path d="M7 11v4a2 2 0 0 0 2 2h4" />
    <rect width="8" height="8" x="13" y="13" rx="2" />
  </svg>
);

const WrenchIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  </svg>
);

const StoreIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7" />
    <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
    <path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4" />
    <path d="M2 7h20" />
    <path d="M22 7v3a2 2 0 0 1-2 2a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 16 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 12 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 8 12a2.7 2.7 0 0 1-1.59-.63.7.7 0 0 0-.82 0A2.7 2.7 0 0 1 4 12a2 2 0 0 1-2-2V7" />
  </svg>
);

const DownloadIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color || "currentColor"}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" x2="12" y1="15" y2="3" />
  </svg>
);

const PowerIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 2v10" />
    <path d="M18.4 6.6a9 9 0 1 1-12.77.04" />
  </svg>
);

const TrashIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.destructive,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 6h18" />
    <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
    <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
  </svg>
);

const RefreshIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M8 16H3v5" />
  </svg>
);

const PlusIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color || "currentColor"}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M5 12h14" />
    <path d="M12 5v14" />
  </svg>
);

const ExternalLinkIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </svg>
);

const XIcon: React.FC<{ size?: number; color?: string }> = ({
  size = 16,
  color = colors.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

// ── Reusable UI pieces ──────────────────────────────────────

const Badge: React.FC<{
  children: React.ReactNode;
  bg?: string;
  color?: string;
}> = ({ children, bg = colors.accent, color: c = colors.muted }) => (
  <span
    style={{
      fontSize: 11,
      padding: "2px 8px",
      borderRadius: 9999,
      backgroundColor: bg,
      color: c,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </span>
);

const Tag: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      fontSize: 10,
      padding: "2px 7px",
      borderRadius: 4,
      backgroundColor: colors.accent,
      color: colors.muted,
    }}
  >
    {children}
  </span>
);

const IconBtn: React.FC<{ children: React.ReactNode; title?: string }> = ({
  children,
}) => (
  <div
    style={{
      width: 32,
      height: 32,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 6,
      cursor: "pointer",
    }}
  >
    {children}
  </div>
);

const SmallButton: React.FC<{
  children: React.ReactNode;
  variant?: "default" | "outline" | "destructive";
}> = ({ children, variant = "default" }) => {
  const styles: React.CSSProperties =
    variant === "outline"
      ? {
          border: `1px solid ${colors.border}`,
          background: "transparent",
          color: colors.foreground,
        }
      : variant === "destructive"
        ? {
            border: "none",
            background: colors.destructive,
            color: "#fff",
          }
        : {
            border: "none",
            background: colors.primaryBg,
            color: colors.primaryFg,
          };

  return (
    <div
      style={{
        ...styles,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 12px",
        borderRadius: 6,
        fontSize: 13,
        fontWeight: 500,
        cursor: "pointer",
      }}
    >
      {children}
    </div>
  );
};

// ── Sidebar ─────────────────────────────────────────────────

const sidebarItems = [
  { label: "General", Icon: SettingsIcon },
  { label: "Agents", Icon: UsersIcon },
  { label: "Tools & MCP", Icon: ServerIcon },
  { label: "Secrets", Icon: KeyIcon },
  { label: "Task sources", Icon: WorkflowIcon },
  { label: "Plugins", Icon: PuzzleIcon },
  { label: "Advanced", Icon: WrenchIcon },
];

const Sidebar: React.FC = () => (
  <div
    style={{
      width: 240,
      borderRight: `1px solid ${colors.border}`,
      backgroundColor: colors.bgSidebar,
      padding: "16px 12px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
    }}
  >
    {sidebarItems.map(({ label, Icon }) => {
      const active = label === "Plugins";
      return (
        <div
          key={label}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 12px",
            borderRadius: 6,
            backgroundColor: active ? colors.accent : "transparent",
            color: active ? colors.accentFg : colors.muted,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          <Icon size={16} color={active ? colors.accentFg : colors.muted} />
          <span>{label}</span>
        </div>
      );
    })}
  </div>
);

// ── Header ──────────────────────────────────────────────────

const Header: React.FC = () => (
  <div
    style={{
      padding: "16px 24px",
      borderBottom: `1px solid ${colors.border}`,
      backgroundColor: colors.bg,
      display: "flex",
      justifyContent: "space-between",
      alignItems: "flex-start",
    }}
  >
    <div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: colors.foreground,
        }}
      >
        Settings
      </div>
      <div
        style={{
          fontSize: 14,
          color: colors.muted,
          marginTop: 2,
        }}
      >
        Manage your application preferences and integrations
      </div>
    </div>
    <IconBtn>
      <XIcon size={16} color={colors.muted} />
    </IconBtn>
  </div>
);

// ── Tab bar ─────────────────────────────────────────────────

const TabBar: React.FC<{
  active: "installed" | "discover" | "marketplaces";
}> = ({ active }) => {
  const tabs = [
    { key: "installed" as const, label: `Installed (${installedPlugins.length})` },
    { key: "discover" as const, label: "Discover" },
    { key: "marketplaces" as const, label: `Marketplaces (${marketplaceSources.length})` },
  ];

  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        borderBottom: `1px solid ${colors.border}`,
        marginBottom: 16,
      }}
    >
      {tabs.map(({ key, label }) => (
        <div
          key={key}
          style={{
            padding: "8px 16px",
            fontSize: 14,
            fontWeight: 500,
            borderBottom: `2px solid ${active === key ? colors.foreground : "transparent"}`,
            color: active === key ? colors.foreground : colors.muted,
          }}
        >
          {label}
        </div>
      ))}
    </div>
  );
};

// ── Search bar ──────────────────────────────────────────────

const SearchBar: React.FC<{ placeholder: string; value?: string }> = ({
  placeholder,
  value = "",
}) => (
  <div style={{ position: "relative", marginBottom: 16 }}>
    <div
      style={{
        position: "absolute",
        left: 12,
        top: "50%",
        transform: "translateY(-50%)",
      }}
    >
      <SearchIcon size={16} />
    </div>
    <div
      style={{
        width: "100%",
        height: 36,
        borderRadius: 6,
        border: `1px solid ${colors.border}`,
        backgroundColor: "transparent",
        paddingLeft: 40,
        display: "flex",
        alignItems: "center",
        fontSize: 14,
        color: value ? colors.foreground : colors.muted,
      }}
    >
      {value || placeholder}
    </div>
  </div>
);

// ── Installed Plugin Card ───────────────────────────────────

const InstalledPluginCard: React.FC<{
  plugin: (typeof installedPlugins)[0];
  opacity?: number;
  translateY?: number;
}> = ({ plugin, opacity = 1, translateY = 0 }) => (
  <div
    style={{
      borderRadius: 6,
      border: `1px solid ${colors.border}`,
      backgroundColor: colors.bgCard,
      padding: "12px 16px",
      marginBottom: 10,
      opacity,
      transform: `translateY(${translateY}px)`,
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: colors.foreground,
            }}
          >
            {plugin.name}
          </span>
          <span style={{ fontSize: 12, color: colors.muted }}>
            v{plugin.version}
          </span>
          <Badge
            bg={plugin.enabled ? colors.greenBg : colors.accent}
            color={plugin.enabled ? colors.green : colors.muted}
          >
            {plugin.enabled ? "Enabled" : "Disabled"}
          </Badge>
          <Badge>{plugin.scope}</Badge>
        </div>
        <div
          style={{
            fontSize: 12,
            color: colors.muted,
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {plugin.description}
        </div>
        <div
          style={{
            display: "flex",
            gap: 4,
            marginTop: 6,
            flexWrap: "wrap",
          }}
        >
          {plugin.keywords.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          marginLeft: 12,
          flexShrink: 0,
        }}
      >
        <IconBtn>
          <PowerIcon
            size={14}
            color={plugin.enabled ? colors.muted : colors.green}
          />
        </IconBtn>
        <IconBtn>
          <TrashIcon size={14} />
        </IconBtn>
      </div>
    </div>
  </div>
);

// ── Discover Plugin Card ────────────────────────────────────

const DiscoverPluginCard: React.FC<{
  plugin: (typeof discoverablePlugins)[0];
  opacity?: number;
  translateY?: number;
  installing?: boolean;
}> = ({ plugin, opacity = 1, translateY = 0, installing = false }) => (
  <div
    style={{
      borderRadius: 6,
      border: `1px solid ${colors.border}`,
      backgroundColor: colors.bgCard,
      padding: "12px 16px",
      marginBottom: 10,
      opacity,
      transform: `translateY(${translateY}px)`,
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: colors.foreground,
            }}
          >
            {plugin.name}
          </span>
          <span style={{ fontSize: 12, color: colors.muted }}>
            v{plugin.version}
          </span>
          <span style={{ fontSize: 12, color: colors.muted }}>
            by {plugin.author}
          </span>
        </div>
        <div
          style={{
            fontSize: 12,
            color: colors.muted,
            marginTop: 4,
            lineHeight: 1.4,
          }}
        >
          {plugin.description}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 6,
          }}
        >
          <span
            style={{
              fontSize: 10,
              padding: "2px 7px",
              borderRadius: 4,
              backgroundColor: colors.blueBg,
              color: colors.blue,
            }}
          >
            {plugin.category}
          </span>
          {plugin.tags.map((tag) => (
            <Tag key={tag}>{tag}</Tag>
          ))}
          <span style={{ fontSize: 10, color: colors.muted }}>
            from {plugin.marketplace}
          </span>
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          marginLeft: 12,
          flexShrink: 0,
        }}
      >
        <IconBtn>
          <ExternalLinkIcon size={14} />
        </IconBtn>
        {plugin.installed ? (
          <SmallButton variant="outline">
            <TrashIcon size={12} color={colors.foreground} />
            Remove
          </SmallButton>
        ) : installing ? (
          <SmallButton>
            <span
              style={{
                display: "inline-block",
                width: 12,
                height: 12,
                border: `2px solid ${colors.primaryFg}`,
                borderTopColor: "transparent",
                borderRadius: "50%",
              }}
            />
            Installing...
          </SmallButton>
        ) : (
          <SmallButton>
            <DownloadIcon size={12} color={colors.primaryFg} />
            Install
          </SmallButton>
        )}
      </div>
    </div>
  </div>
);

// ── Marketplace Source Card ──────────────────────────────────

const MarketplaceSourceCard: React.FC<{
  source: (typeof marketplaceSources)[0];
  opacity?: number;
  translateY?: number;
}> = ({ source, opacity = 1, translateY = 0 }) => (
  <div
    style={{
      borderRadius: 6,
      border: `1px solid ${colors.border}`,
      backgroundColor: colors.bgCard,
      padding: "12px 16px",
      marginBottom: 10,
      opacity,
      transform: `translateY(${translateY}px)`,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StoreIcon size={16} color={colors.muted} />
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: colors.foreground,
            }}
          >
            {source.name}
          </span>
          <Badge>{source.type}</Badge>
        </div>
        <div
          style={{
            fontSize: 12,
            color: colors.muted,
            marginTop: 2,
            marginLeft: 24,
          }}
        >
          {source.url}
        </div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          marginLeft: 12,
          flexShrink: 0,
        }}
      >
        <IconBtn>
          <RefreshIcon size={14} />
        </IconBtn>
        <IconBtn>
          <TrashIcon size={14} />
        </IconBtn>
      </div>
    </div>
  </div>
);

// ── Add Marketplace Form ────────────────────────────────────

const AddMarketplaceForm: React.FC<{ opacity?: number }> = ({
  opacity = 1,
}) => (
  <div
    style={{
      borderRadius: 6,
      border: `1px solid ${colors.border}`,
      backgroundColor: colors.bgCard,
      padding: 16,
      marginBottom: 12,
      opacity,
    }}
  >
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 12,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 500, color: colors.foreground }}>
        Add Plugin Marketplace
      </span>
      <IconBtn>
        <XIcon size={14} />
      </IconBtn>
    </div>
    {/* Name input */}
    <div
      style={{
        height: 36,
        borderRadius: 6,
        border: `1px solid ${colors.border}`,
        padding: "0 12px",
        display: "flex",
        alignItems: "center",
        fontSize: 14,
        color: colors.muted,
        marginBottom: 8,
      }}
    >
      my-team-plugins
    </div>
    {/* Type + URL row */}
    <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
      <div
        style={{
          height: 36,
          borderRadius: 6,
          border: `1px solid ${colors.border}`,
          padding: "0 12px",
          display: "flex",
          alignItems: "center",
          fontSize: 14,
          color: colors.foreground,
          minWidth: 100,
        }}
      >
        GitHub
      </div>
      <div
        style={{
          flex: 1,
          height: 36,
          borderRadius: 6,
          border: `1px solid ${colors.border}`,
          padding: "0 12px",
          display: "flex",
          alignItems: "center",
          fontSize: 14,
          color: colors.muted,
        }}
      >
        owner/repo (e.g. anthropics/claude-code)
      </div>
    </div>
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <SmallButton>
        <PlusIcon size={12} color={colors.primaryFg} />
        Add
      </SmallButton>
    </div>
  </div>
);

// ── Cursor ──────────────────────────────────────────────────

const Cursor: React.FC<{ x: number; y: number; opacity?: number }> = ({
  x,
  y,
  opacity = 1,
}) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      opacity,
      zIndex: 100,
      pointerEvents: "none",
    }}
  >
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path
        d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L5.85 2.36a.5.5 0 0 0-.35.85z"
        fill="#fff"
        stroke="#000"
        strokeWidth="1.5"
      />
    </svg>
  </div>
);

// ── Section title ───────────────────────────────────────────

const SectionHeader: React.FC = () => (
  <div style={{ marginBottom: 16 }}>
    <div style={{ fontSize: 16, fontWeight: 600, color: colors.foreground }}>
      Plugins
    </div>
    <div style={{ fontSize: 13, color: colors.muted, marginTop: 2 }}>
      Extend 20x with Claude Code format plugins. Browse marketplaces, install
      skills, MCP servers, agents, and more.
    </div>
  </div>
);

// ── Main Composition ────────────────────────────────────────

export const PluginsShowcase: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // ── Timeline phases (in frames at 30fps) ──────────────
  // 0-30: fade in entire settings window
  // 30-180: Installed tab shown
  // 180-210: transition to Discover tab
  // 210-390: Discover tab (with install animation at 300)
  // 390-420: transition to Marketplaces tab
  // 420-540: Marketplaces tab (show add form at 470)
  // 540-600: fade out / hold

  const windowOpacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });
  const windowScale = interpolate(frame, [0, 20], [0.96, 1], {
    extrapolateRight: "clamp",
  });

  // Determine active tab
  let activeTab: "installed" | "discover" | "marketplaces" = "installed";
  if (frame >= 195) activeTab = "discover";
  if (frame >= 405) activeTab = "marketplaces";

  // Content crossfade
  const installedOpacity = interpolate(
    frame,
    [180, 195],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const discoverOpacity =
    frame < 195
      ? 0
      : frame < 210
        ? interpolate(frame, [195, 210], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        : frame < 390
          ? 1
          : interpolate(frame, [390, 405], [1, 0], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            });
  const marketOpacity =
    frame < 405
      ? 0
      : interpolate(frame, [405, 420], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

  // Card stagger animations
  const cardSpring = (index: number, baseFrame: number) => {
    const s = spring({
      frame: frame - baseFrame - index * 4,
      fps,
      config: { damping: 15, stiffness: 120 },
    });
    return {
      opacity: s,
      translateY: interpolate(s, [0, 1], [16, 0]),
    };
  };

  // Install animation on Discover tab (frame 300-330)
  const isInstalling =
    frame >= 300 && frame < 340;
  const installDone = frame >= 340;

  // Show add marketplace form (frame 470+)
  const showAddForm = frame >= 470;
  const addFormOpacity =
    frame < 470
      ? 0
      : interpolate(frame, [470, 485], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });

  // Cursor position animation
  const cursorX = interpolate(
    frame,
    [
      0,   30,  // start
      170, 190, // click "Discover"
      290, 310, // click "Install" on first card
      380, 400, // click "Marketplaces"
      450, 470, // click "Add Marketplace"
      540,
    ],
    [
      960, 960,
      520, 520,
      1170, 1170,
      680, 680,
      1180, 1180,
      960,
    ],
    { extrapolateRight: "clamp" }
  );
  const cursorY = interpolate(
    frame,
    [
      0,   30,
      170, 190,
      290, 310,
      380, 400,
      450, 470,
      540,
    ],
    [
      540, 540,
      198, 198,
      340, 340,
      198, 198,
      215, 215,
      540,
    ],
    { extrapolateRight: "clamp" }
  );
  const cursorOpacity = interpolate(
    frame,
    [10, 25, 555, 580],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Final fade out
  const finalOpacity = interpolate(frame, [570, 600], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "#000",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
        opacity: finalOpacity,
      }}
    >
      {/* Title sequence */}
      <Sequence from={0} durationInFrames={45}>
        <AbsoluteFill
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontSize: 48,
              fontWeight: 700,
              color: colors.foreground,
              opacity: interpolate(frame, [0, 15], [0, 1], {
                extrapolateRight: "clamp",
              }),
              transform: `translateY(${interpolate(frame, [0, 15], [20, 0], { extrapolateRight: "clamp" })}px)`,
            }}
          >
            20x Plugins
          </div>
          <div
            style={{
              fontSize: 20,
              color: colors.muted,
              marginTop: 8,
              opacity: interpolate(frame, [8, 22], [0, 1], {
                extrapolateRight: "clamp",
              }),
            }}
          >
            Claude Code format plugin system
          </div>
        </AbsoluteFill>
      </Sequence>

      {/* Settings window */}
      <Sequence from={30} durationInFrames={570}>
        <AbsoluteFill
          style={{
            padding: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <div
            style={{
              width: 1400,
              height: 850,
              borderRadius: 12,
              border: `1px solid ${colors.border}`,
              backgroundColor: colors.bg,
              overflow: "hidden",
              display: "flex",
              flexDirection: "column",
              opacity: windowOpacity,
              transform: `scale(${windowScale})`,
              boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
            }}
          >
            <Header />
            <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
              <Sidebar />
              {/* Content area */}
              <div
                style={{
                  flex: 1,
                  overflow: "hidden",
                  padding: "24px 32px",
                }}
              >
                <SectionHeader />
                <TabBar active={activeTab} />

                {/* Installed tab content */}
                {(activeTab === "installed" || frame < 210) && (
                  <div style={{ opacity: installedOpacity }}>
                    <SearchBar placeholder="Search installed plugins..." />
                    {installedPlugins.map((plugin, i) => {
                      const anim = cardSpring(i, 40);
                      return (
                        <InstalledPluginCard
                          key={plugin.name}
                          plugin={plugin}
                          opacity={anim.opacity}
                          translateY={anim.translateY}
                        />
                      );
                    })}
                  </div>
                )}

                {/* Discover tab content */}
                {discoverOpacity > 0 && (
                  <div style={{ opacity: discoverOpacity }}>
                    <SearchBar placeholder="Search plugins..." />
                    {discoverablePlugins.map((plugin, i) => {
                      const anim = cardSpring(i, 205);
                      return (
                        <DiscoverPluginCard
                          key={plugin.name}
                          plugin={plugin}
                          opacity={anim.opacity}
                          translateY={anim.translateY}
                          installing={
                            i === 0 && isInstalling
                          }
                        />
                      );
                    })}
                  </div>
                )}

                {/* Marketplaces tab content */}
                {marketOpacity > 0 && (
                  <div style={{ opacity: marketOpacity }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        marginBottom: 12,
                      }}
                    >
                      <SmallButton variant="outline">
                        <PlusIcon size={14} color={colors.foreground} />
                        Add Marketplace
                      </SmallButton>
                    </div>
                    {showAddForm && (
                      <AddMarketplaceForm opacity={addFormOpacity} />
                    )}
                    {marketplaceSources.map((source, i) => {
                      const anim = cardSpring(i, 415);
                      return (
                        <MarketplaceSourceCard
                          key={source.name}
                          source={source}
                          opacity={anim.opacity}
                          translateY={anim.translateY}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Cursor */}
          <Cursor
            x={cursorX}
            y={cursorY}
            opacity={cursorOpacity}
          />
        </AbsoluteFill>
      </Sequence>
    </AbsoluteFill>
  );
};
