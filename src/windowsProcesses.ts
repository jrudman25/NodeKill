import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

/**
 * Processes that commonly bind to localhost ports but are NOT development
 * servers. These are excluded even when they happen to listen on a common
 * dev port.
 */
const IGNORED_PROCESS_NAMES = new Set([
  "riotclientservices.exe",
  "riotclientux.exe",
  "riotclientcrashhandler.exe",
  "leagueclient.exe",
  "leagueclientux.exe",
  "valorant-win64-shipping.exe",
  "vanguard.exe",
  "epicwebhelper.exe",
  "steamwebhelper.exe",
  "msedgewebview2.exe",
  "msedge.exe",
  "chrome.exe",
  "firefox.exe",
  "brave.exe",
  "opera.exe",
  "svchost.exe",
  "system",
  "lsass.exe",
  "services.exe",
  "spoolsv.exe",
  "searchhost.exe",
  "explorer.exe",
  "microsoft.servicehub.controller.exe",
  "servicehub.host.dotnet.x64.exe",
  "servicehub.identityhost.exe",
  "servicehub.vsdetouredhost.exe",
  "servicehub.roslyncodanalysisservice.exe",
  "servicehub.threadedwaitdialog.exe",
  "vsls-agent.exe",
  "devenv.exe",
  "code.exe",
  "discord.exe",
  "spotify.exe",
  "slack.exe",
  "teams.exe",
  "msteams.exe",
  "onedrive.exe",
  "dropbox.exe",
  "nvidia web helper.exe",
  "sqlservr.exe",
  "mysqld.exe",
  "postgres.exe",
  "mongod.exe",
  "redis-server.exe",
  "AppleMobileDeviceProcess.exe",
  "esrv.exe",
  "language_server_windows_x64.exe"
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

  const deduplicated = Array.from(
    new Map(servers.map((server) => [server.id, server])).values(),
  ).sort((left, right) => {
    if (left.port !== right.port) {
      return left.port - right.port;
    }

    return left.pid - right.pid;
  });

  await enrichWithProjectNames(deduplicated);
  return deduplicated;
}

export async function killProcess(pid: number): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = "Stop"
$ProcessId = ${pid}
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
if (-not $process) {
  throw "Process $ProcessId is no longer running."
}
Stop-Process -Id $ProcessId -Force
`;
  await execPowerShell(script);
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
  const workingDirectory = inferWorkingDirectory(listener.commandLine);

  const server: LocalhostServer = {
    id: `${listener.pid}:${listener.port}`,
    port: listener.port,
    pid: listener.pid,
    processName,
    commandLine: listener.commandLine,
    executablePath: listener.executablePath,
    creationDate: listener.creationDate,
    url,
    label: processName,
    workingDirectory,
  };

  server.label = buildLabel(server);
  return server;
}

function isLikelyDevelopmentServer(server: LocalhostServer): boolean {
  const processName = server.processName.toLowerCase();
  const commandLine = server.commandLine?.toLowerCase() ?? "";

  if (IGNORED_PROCESS_NAMES.has(processName)) {
    return false;
  }

  return (
    DEVELOPMENT_PROCESS_NAMES.has(processName) ||
    COMMON_DEVELOPMENT_PORTS.has(server.port) ||
    DEVELOPMENT_COMMAND_HINTS.some((hint) => commandLine.includes(hint))
  );
}

function buildLabel(server: LocalhostServer): string {
  const name = server.projectName;
  if (name) {
    return `${name} (${server.processName})`;
  }

  const folderHint = server.workingDirectory
    ? lastPathSegment(server.workingDirectory)
    : undefined;

  if (folderHint) {
    return `${folderHint} (${server.processName})`;
  }

  return server.processName;
}

/**
 * Try to extract the project root directory from the command line.
 * Matches patterns like:
 *   - ...\SomeProject\node_modules\.bin\next dev
 *   - ...\SomeProject\node_modules\vite\bin\vite.js
 *   - ...\SomeProject\package.json
 *   - --prefix "C:\Projects\SomeProject"
 *   - ...\SomeProject\manage.py (Python)
 *   - ...\SomeProject\server.js
 */
function inferWorkingDirectory(
  commandLine: string | undefined,
): string | undefined {
  if (!commandLine) {
    return undefined;
  }

  // Match path\node_modules\... — the parent of node_modules is the project root
  const nodeModulesMatch = commandLine.match(
    /"?([A-Z]:\\[^"]*?)\\node_modules\\/i,
  );
  if (nodeModulesMatch?.[1]) {
    return nodeModulesMatch[1];
  }

  // Match an explicit package.json reference
  const packageJsonMatch = commandLine.match(
    /"?([A-Z]:\\[^"]*?)\\package\.json/i,
  );
  if (packageJsonMatch?.[1]) {
    return packageJsonMatch[1];
  }

  // Match --prefix flag (npm)
  const cwdMatch = commandLine.match(
    /--prefix\s+"?([A-Z]:\\[^"\s]+(?:\\[^"\s]+)*)"?/i,
  );
  if (cwdMatch?.[1]) {
    return cwdMatch[1];
  }

  return undefined;
}

/**
 * Read the "name" field from a package.json in the given directory.
 * Returns undefined if the file doesn't exist or can't be parsed.
 */
async function readProjectName(
  directory: string,
): Promise<string | undefined> {
  try {
    const raw = await readFile(join(directory, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { name?: string };
    return pkg.name || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enrich servers with project names from package.json where possible,
 * then rebuild labels to include the project name.
 */
async function enrichWithProjectNames(
  servers: LocalhostServer[],
): Promise<void> {
  // Group by working directory to avoid reading the same package.json multiple times
  const directoryCache = new Map<string, string | undefined>();

  await Promise.all(
    servers.map(async (server) => {
      if (!server.workingDirectory) {
        return;
      }

      let name = directoryCache.get(server.workingDirectory);
      if (name === undefined && !directoryCache.has(server.workingDirectory)) {
        name = await readProjectName(server.workingDirectory);
        directoryCache.set(server.workingDirectory, name);
      }

      if (name) {
        server.projectName = name;
      }

      server.label = buildLabel(server);
    }),
  );
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
