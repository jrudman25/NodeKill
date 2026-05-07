# NodeKill

NodeKill is a Raycast extension for Windows that finds likely localhost development servers and lets you stop stale processes quickly.

## Features

- Lists listening localhost TCP ports on Windows.
- Shows process name, PID, URL, command line, executable path, and project hints when available.
- Opens or copies `http://localhost:<port>` URLs.
- Kills an individual listed process with confirmation.
- Kills all listed development server processes with confirmation.

## How It Works

NodeKill uses Windows PowerShell commands to inspect localhost TCP listeners and resolve each listener to process metadata. It filters results toward likely development servers by process name, command line hints, and common development ports.

The extension is intentionally conservative so it does not list every Windows service bound to localhost.

## Requirements

- Windows
- Raycast
- PowerShell
- Node.js for local extension development

## Development

Install dependencies:

```powershell
npm install
```

Run the extension in Raycast development mode:

```powershell
npm run dev
```

Validate the extension:

```powershell
npm run lint
npm run build
```

## Safety Notes

Killing a process is destructive. NodeKill asks for confirmation before stopping one process or all listed processes. It uses the PID shown in the list and surfaces failures instead of ignoring them.

## Limitations

- Windows only.
- Process working directory is inferred from command-line hints when available, not guaranteed.
- Website title and favicon discovery are intentionally deferred until the core Windows process workflow is reliable.
