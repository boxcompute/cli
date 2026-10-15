import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { connectionPaths } from "./config.js";

export type MaintenanceNotice = {
  id: string;
  revision: number;
  kind: "planned" | "urgent";
  status: "scheduled" | "in_progress" | "completed" | "cancelled";
  startsAt: string;
  endsAt: string;
  impact: string;
};

type NoticeState = {
  shown: Array<{ key: string; day: string }>;
  dismissed: string[];
};

const EMPTY_STATE: NoticeState = { shown: [], dismissed: [] };
const MAX_STATE_ENTRIES = 32;
const NOTICE_KEYS = ["endsAt", "id", "impact", "kind", "revision", "startsAt", "status"];
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const maintenanceKey = (notice: MaintenanceNotice) => `${notice.id}:${notice.revision}`;

const hasControlCharacter = (value: string) =>
  [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

function validNotice(value: unknown): value is MaintenanceNotice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const notice = value as Record<string, unknown>;
  return Object.keys(notice).sort().join(",") === NOTICE_KEYS.join(",")
    && typeof notice.id === "string" && notice.id.length <= 80
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(notice.id)
    && Number.isSafeInteger(notice.revision) && (notice.revision as number) > 0
    && (notice.kind === "planned" || notice.kind === "urgent")
    && ["scheduled", "in_progress", "completed", "cancelled"].includes(String(notice.status))
    && typeof notice.startsAt === "string" && RFC3339.test(notice.startsAt)
    && Number.isFinite(Date.parse(notice.startsAt))
    && typeof notice.endsAt === "string" && RFC3339.test(notice.endsAt)
    && Date.parse(notice.endsAt) > Date.parse(notice.startsAt)
    && typeof notice.impact === "string" && notice.impact.trim() === notice.impact
    && notice.impact.length > 0 && notice.impact.length <= 500
    && !hasControlCharacter(notice.impact);
}

export async function fetchMaintenanceNotice(
  baseUrl: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<MaintenanceNotice | null> {
  const response = await fetchImpl(new URL("/api/meta", baseUrl), {
    headers: { accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (!response.ok) throw new Error(`Maintenance notice request failed (HTTP ${response.status})`);
  const body = await response.json() as { maintenance?: unknown };
  if (body.maintenance === null || body.maintenance === undefined) return null;
  if (!validNotice(body.maintenance)) throw new Error("BoxCompute returned an invalid maintenance notice");
  return body.maintenance;
}

function statePath(env: NodeJS.ProcessEnv): string {
  return path.join(connectionPaths(env).directory, "maintenance-notices.json");
}

async function readState(env: NodeJS.ProcessEnv): Promise<NoticeState> {
  try {
    const value = JSON.parse(await readFile(statePath(env), "utf8")) as Partial<NoticeState>;
    return {
      shown: Array.isArray(value.shown)
        ? value.shown.filter((item): item is { key: string; day: string } =>
          Boolean(item) && typeof item.key === "string" && typeof item.day === "string").slice(-MAX_STATE_ENTRIES)
        : [],
      dismissed: Array.isArray(value.dismissed)
        ? value.dismissed.filter((item): item is string => typeof item === "string").slice(-MAX_STATE_ENTRIES)
        : [],
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

async function writeState(env: NodeJS.ProcessEnv, state: NoticeState): Promise<void> {
  const paths = connectionPaths(env);
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  await chmod(paths.directory, 0o700);
  const destination = statePath(env);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function localDay(now: number): string {
  const date = new Date(now);
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`;
}

const statusLabel: Record<MaintenanceNotice["status"], string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function formatMaintenanceNotice(notice: MaintenanceNotice, dismissHint = true): string {
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const settled = notice.status === "completed" || notice.status === "cancelled";
  const title = notice.kind === "urgent" ? "URGENT MAINTENANCE" : "PLANNED MAINTENANCE";
  return [
    `\n${title} · ${statusLabel[notice.status]}`,
    `Window: ${formatter.format(new Date(notice.startsAt))} – ${formatter.format(new Date(notice.endsAt))}${timezone ? ` (${timezone})` : ""}`,
    `Expected impact: ${notice.impact}`,
    ...(!settled ? [notice.status === "in_progress" ? "Save your work now." : "Save your work before the window begins."] : []),
    ...(dismissHint ? ["Run `bxc maintenance dismiss` to hide this update."] : []),
    "",
  ].join("\n");
}

/** Return today's MOTD once per revision, or null when it is dismissed, already shown, or unavailable. */
export async function maintenanceMotd(options: {
  baseUrl: string;
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  now: number;
}): Promise<string | null> {
  try {
    const notice = await fetchMaintenanceNotice(options.baseUrl, options.fetch, AbortSignal.timeout(1_200));
    if (!notice) return null;
    const state = await readState(options.env);
    const key = maintenanceKey(notice);
    const day = localDay(options.now);
    if (state.dismissed.includes(key) || state.shown.some((item) => item.key === key && item.day === day)) return null;
    state.shown = [...state.shown.filter((item) => item.key !== key), { key, day }].slice(-MAX_STATE_ENTRIES);
    await writeState(options.env, state);
    return formatMaintenanceNotice(notice);
  } catch {
    // A best-effort MOTD must never delay or break the command the user asked for.
    return null;
  }
}

export async function dismissMaintenanceNotice(notice: MaintenanceNotice, env: NodeJS.ProcessEnv): Promise<void> {
  const state = await readState(env);
  const key = maintenanceKey(notice);
  state.dismissed = [...state.dismissed.filter((item) => item !== key), key].slice(-MAX_STATE_ENTRIES);
  await writeState(env, state);
}
