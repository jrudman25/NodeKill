import {
  Action,
  ActionPanel,
  Alert,
  confirmAlert,
  Icon,
  List,
  showToast,
  Toast,
} from "@raycast/api";
import { useCallback, useEffect, useState } from "react";
import type { LocalhostServer } from "./types";
import { findLocalhostServers, killProcess } from "./windowsProcesses";
import { version } from "../package.json";

export default function Command() {
  const [servers, setServers] = useState<LocalhostServer[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string>();

  const loadServers = useCallback(async () => {
    setIsLoading(true);
    setError(undefined);

    try {
      setServers(await findLocalhostServers());
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : String(loadError);
      setError(message);
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to find localhost servers",
        message,
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  async function killServer(server: LocalhostServer) {
    const confirmed = await confirmAlert({
      title: `Kill ${server.label}?`,
      message: `This will force stop PID ${server.pid} listening on port ${server.port}.`,
      icon: Icon.XMarkCircle,
      primaryAction: {
        title: "Kill Process",
        style: Alert.ActionStyle.Destructive,
      },
    });

    if (!confirmed) {
      return;
    }

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Killing PID ${server.pid}`,
    });

    try {
      await killProcess(server.pid);
      toast.style = Toast.Style.Success;
      toast.title = "Process killed";
      toast.message = `${server.processName} on port ${server.port}`;
      await loadServers();
    } catch (killError) {
      toast.style = Toast.Style.Failure;
      toast.title = "Failed to kill process";
      toast.message =
        killError instanceof Error ? killError.message : String(killError);
    }
  }

  async function killAllServers() {
    const uniqueServersByPid = Array.from(
      new Map(servers.map((server) => [server.pid, server])).values(),
    );

    if (uniqueServersByPid.length === 0) {
      await showToast({
        style: Toast.Style.Success,
        title: "No localhost servers to kill",
      });
      return;
    }

    const confirmed = await confirmAlert({
      title: "Kill all listed servers?",
      message: `This will force stop ${uniqueServersByPid.length} process${uniqueServersByPid.length === 1 ? "" : "es"}.`,
      icon: Icon.XMarkCircle,
      primaryAction: {
        title: "Kill All",
        style: Alert.ActionStyle.Destructive,
      },
    });

    if (!confirmed) {
      return;
    }

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: "Killing localhost servers",
    });
    const failures: string[] = [];

    for (const server of uniqueServersByPid) {
      try {
        await killProcess(server.pid);
      } catch (killError) {
        failures.push(
          `${server.pid}: ${killError instanceof Error ? killError.message : String(killError)}`,
        );
      }
    }

    await loadServers();

    if (failures.length > 0) {
      toast.style = Toast.Style.Failure;
      toast.title = "Some processes could not be killed";
      toast.message = failures.slice(0, 2).join("; ");
      return;
    }

    toast.style = Toast.Style.Success;
    toast.title = "All listed servers killed";
    toast.message = `${uniqueServersByPid.length} process${uniqueServersByPid.length === 1 ? "" : "es"} stopped`;
  }

  const emptyViewTitle = error
    ? "Unable to find localhost servers"
    : "No localhost development servers found";

  return (
    <List
      isLoading={isLoading}
      navigationTitle={`NodeKill v${version}`}
      searchBarPlaceholder="Search by port, process, PID, or command"
      actions={
        <ActionPanel>
          <Action
            title="Refresh"
            icon={Icon.ArrowClockwise}
            onAction={() => void loadServers()}
          />
          <Action
            title="Kill All Listed Servers"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            onAction={() => void killAllServers()}
          />
        </ActionPanel>
      }
    >
      {servers.length === 0 ? (
        <List.EmptyView
          title={emptyViewTitle}
          description={
            error ?? "Start a dev server, then refresh this command."
          }
        />
      ) : null}
      {servers.map((server) => (
        <List.Item
          key={server.id}
          icon={Icon.Terminal}
          title={server.label}
          subtitle={server.url}
          accessories={[
            { text: server.processName },
            { text: `PID ${server.pid}` },
          ]}
          detail={<ServerDetail server={server} />}
          actions={
            <ActionPanel>
              <Action.OpenInBrowser
                title="Open Localhost URL"
                url={server.url}
              />
              <Action.CopyToClipboard title="Copy URL" content={server.url} />
              <Action.CopyToClipboard
                title="Copy Process Id"
                content={String(server.pid)}
              />
              {server.commandLine ? (
                <Action.CopyToClipboard
                  title="Copy Command Line"
                  content={server.commandLine}
                />
              ) : null}
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                onAction={() => void loadServers()}
              />
              <Action
                title="Kill Process"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={() => void killServer(server)}
              />
              <Action
                title="Kill All Listed Servers"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={() => void killAllServers()}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function ServerDetail({ server }: { server: LocalhostServer }) {
  return (
    <List.Item.Detail
      markdown={`# ${server.label}\n\n${server.commandLine ? `\`${server.commandLine}\`` : "No command line available."}`}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label title="URL" text={server.url} />
          <List.Item.Detail.Metadata.Label
            title="Port"
            text={String(server.port)}
          />
          <List.Item.Detail.Metadata.Label
            title="PID"
            text={String(server.pid)}
          />
          <List.Item.Detail.Metadata.Label
            title="Process"
            text={server.processName}
          />
          {server.workingDirectory ? (
            <List.Item.Detail.Metadata.Label
              title="Project Hint"
              text={server.workingDirectory}
            />
          ) : null}
          {server.executablePath ? (
            <List.Item.Detail.Metadata.Label
              title="Executable"
              text={server.executablePath}
            />
          ) : null}
          {server.creationDate ? (
            <List.Item.Detail.Metadata.Label
              title="Started"
              text={server.creationDate}
            />
          ) : null}
        </List.Item.Detail.Metadata>
      }
    />
  );
}
