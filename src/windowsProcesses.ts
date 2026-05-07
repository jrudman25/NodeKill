import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalhostServer } from "./types";

const execFileAsync = promisify(execFile);

const DISCOVERY_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$connections = Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object {
  $_.LocalAddress -eq "127.0.0.1" -or $_.LocalAddress -eq "::1" -or $_.LocalAddress -eq "localhost" -or $_.LocalAddress -eq "0.0.0.0" -or $_.LocalAddress -eq "::"
}
$processIds = $connections | Select-Object -ExpandProperty OwningProcess -Unique
$processes = @{}
foreach ($processId in $processIds) {
  $processes[$processId] = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" | Select-Object ProcessId, Name, CommandLine, ExecutablePath, CreationDate
}
$connections | ForEach-Object {
  $process = $processes[$_.OwningProcess]
  if ($process) {
    [PSCustomObject]@{
      port = $_.LocalPort
      pid = $_.OwningProcess
      processName = $process.Name
      commandLine = $process.CommandLine
      executablePath = $process.ExecutablePath
      creationDate = $process.CreationDate
    }
  }
} | ConvertTo-Json -Depth 4
`;

const KILL_SCRIPT = String.raw`
param([int]$ProcessId)
$ErrorActionPreference = "Stop"
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
if (-not $process) {
  throw "Process $ProcessId is no longer running."
}
Stop-Process -Id $ProcessId -Force
`;

const DEVELOPMENT_PROCESS_NAMES = new Set([
  "node.exe",
  "npm.exe",
  "npx.exe",
  "pnpm.exe",
  "yarn.exe",
  "bun.exe",
  "deno.exe",
  "python.exe",
  "pythonw.exe",
  "py.exe",
  "uvicorn.exe",
  "flask.exe",
  "dotnet.exe",
  "java.exe",
  "ruby.exe",
  "rails.exe",
  "php.exe",
  "go.exe",
  "air.exe",
  "cargo.exe",
]);

const DEVELOPMENT_COMMAND_HINTS = [
  "localhost",
  "127.0.0.1",
  "vite",
  "next",
  "webpack",
  "webpack-dev-server",
  "react-scripts",
  "astro",
  "remix",
  "nuxt",
  "svelte-kit",
  "serve",
  "dev",
  "start",
  "uvicorn",
  "flask",
  "django",
  "runserver",
  "dotnet watch",
  "spring-boot",
  "rails server",
];

const COMMON_DEVELOPMENT_PORTS = new Set([
  3000, 3001, 3002, 3333, 4000, 4200, 4321, 5000, 5173, 5174, 5175, 5500, 6006,
  7000, 8000, 8080, 8081, 8888, 9000,
]);

type RawWindowsListener = {
  port: number;
  pid: number;
  processName?: string;
  commandLine?: string;
  executablePath?: string;
  creationDate?: string;
};

export async function findLocalhostServers(): Promise<LocalhostServer[]> {
  const { stdout } = await execPowerShell(DISCOVERY_SCRIPT);
  const rawListeners = parsePowerShellJson<RawWindowsListener>(stdout);
  const servers = rawListeners
    .map(toLocalhostServer)
    .filter(isLikelyDevelopmentServer);

  return Array.from(
    new Map(servers.map((server) => [server.id, server])).values(),
  ).sort((left, right) => {
    if (left.port !== right.port) {
      return left.port - right.port;
    }

    return left.pid - right.pid;
  });
}

export async function killProcess(pid: number): Promise<void> {
  await execPowerShell(KILL_SCRIPT, ["-ProcessId", String(pid)]);
}

function parsePowerShellJson<T>(stdout: string): T[] {
  const trimmed = stdout.trim();

  if (!trimmed) {
    return [];
  }

  const parsed = JSON.parse(trimmed) as T | T[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function toLocalhostServer(listener: RawWindowsListener): LocalhostServer {
  const processName = listener.processName ?? "Unknown process";
  const url = `http://localhost:${listener.port}`;

  return {
    id: `${listener.pid}:${listener.port}`,
    port: listener.port,
    pid: listener.pid,
    processName,
    commandLine: listener.commandLine,
    executablePath: listener.executablePath,
    creationDate: listener.creationDate,
    url,
    label: buildLabel(listener),
    workingDirectory: inferWorkingDirectory(listener.commandLine),
  };
}

function isLikelyDevelopmentServer(server: LocalhostServer): boolean {
  const processName = server.processName.toLowerCase();
  const commandLine = server.commandLine?.toLowerCase() ?? "";

  return (
    DEVELOPMENT_PROCESS_NAMES.has(processName) ||
    COMMON_DEVELOPMENT_PORTS.has(server.port) ||
    DEVELOPMENT_COMMAND_HINTS.some((hint) => commandLine.includes(hint))
  );
}

function buildLabel(listener: RawWindowsListener): string {
  const processName = listener.processName ?? "Unknown process";
  const projectHint = inferProjectHint(listener.commandLine);

  if (projectHint) {
    return `${projectHint} (${processName})`;
  }

  return processName;
}

function inferProjectHint(commandLine: string | undefined): string | undefined {
  if (!commandLine) {
    return undefined;
  }

  const packageJsonMatch = commandLine.match(
    /([A-Z]:\\[^"\s]+(?:\\[^"\s]+)*)\\package\.json/i,
  );

  if (packageJsonMatch?.[1]) {
    return lastPathSegment(packageJsonMatch[1]);
  }

  const cwdMatch = commandLine.match(
    /--prefix\s+"?([A-Z]:\\[^"\s]+(?:\\[^"\s]+)*)"?/i,
  );

  if (cwdMatch?.[1]) {
    return lastPathSegment(cwdMatch[1]);
  }

  return undefined;
}

function inferWorkingDirectory(
  commandLine: string | undefined,
): string | undefined {
  if (!commandLine) {
    return undefined;
  }

  const packageJsonMatch = commandLine.match(
    /([A-Z]:\\[^"\s]+(?:\\[^"\s]+)*)\\package\.json/i,
  );

  if (packageJsonMatch?.[1]) {
    return packageJsonMatch[1];
  }

  const cwdMatch = commandLine.match(
    /--prefix\s+"?([A-Z]:\\[^"\s]+(?:\\[^"\s]+)*)"?/i,
  );

  return cwdMatch?.[1];
}

function lastPathSegment(path: string): string {
  return path.split("\\").filter(Boolean).at(-1) ?? path;
}

async function execPowerShell(
  script: string,
  args: string[] = [],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
      ...args,
    ],
    {
      maxBuffer: 1024 * 1024 * 5,
      windowsHide: true,
    },
  );
}
