export type LocalhostServer = {
  id: string;
  port: number;
  pid: number;
  processName: string;
  commandLine?: string;
  executablePath?: string;
  creationDate?: string;
  url: string;
  label: string;
  workingDirectory?: string;
  projectName?: string;
};
