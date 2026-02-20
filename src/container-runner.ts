/**
 * Agent Runner for NanoClaw
 * Spawns agent execution as a direct Node.js child process and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  isPartial?: boolean;
  streamType?: 'thinking' | 'text' | 'tool';
}

/**
 * Read allowed secrets from .env for passing to the agent via stdin.
 * Secrets are never written to disk or exposed as environment variables.
 */
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
}

/**
 * Prepare the group's sessions directory and sync skills.
 * Returns the path to the .claude sessions directory.
 */
function prepareGroupSessions(group: RegisteredGroup): string {
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Symlink Gmail credentials directory so Gmail MCP can find them
  // (HOME is overridden to sessions dir, so ~/.gmail-mcp needs to exist there)
  const realHome = process.env.HOME || '/home/user';
  const gmailSrc = path.join(realHome, '.gmail-mcp');
  const gmailDst = path.join(path.dirname(groupSessionsDir), '.gmail-mcp');
  if (fs.existsSync(gmailSrc) && !fs.existsSync(gmailDst)) {
    try {
      fs.symlinkSync(gmailSrc, gmailDst);
    } catch {
      // If symlink fails (e.g. already exists as file), skip
    }
  }

  // Sync skills into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, file), path.join(dstDir, file));
      }
    }
  }

  return groupSessionsDir;
}

/**
 * Prepare IPC directories for a group + JID.
 * The input directory is per-JID to prevent cross-contamination when
 * multiple JIDs share the same group folder.
 * Returns { ipcDir, inputDir }.
 */
function prepareIpcDirs(groupFolder: string, chatJid: string): { ipcDir: string; inputDir: string } {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  // Input dir is per-JID: sanitize the JID for use as a directory name
  const sanitizedJid = chatJid.replace(/[^a-zA-Z0-9@._:-]/g, '_');
  const inputDir = path.join(groupIpcDir, 'input', sanitizedJid);
  fs.mkdirSync(inputDir, { recursive: true });
  return { ipcDir: groupIpcDir, inputDir };
}

/**
 * Build the list of additional directories (from containerConfig.additionalMounts).
 * In containerless mode, these are passed as-is (host paths) via env var.
 */
function resolveExtraDirs(group: RegisteredGroup): string[] {
  const mounts = group.containerConfig?.additionalMounts;
  if (!mounts || mounts.length === 0) return [];

  const dirs: string[] = [];
  for (const mount of mounts) {
    const hostPath = mount.hostPath.startsWith('~/')
      ? path.join(process.env.HOME || '/home/user', mount.hostPath.slice(2))
      : path.resolve(mount.hostPath);
    if (fs.existsSync(hostPath)) {
      dirs.push(hostPath);
    } else {
      logger.warn({ hostPath }, 'Additional mount path does not exist, skipping');
    }
  }
  return dirs;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string, inputDir: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const groupSessionsDir = prepareGroupSessions(group);
  const { ipcDir: groupIpcDir, inputDir } = prepareIpcDirs(group.folder, input.chatJid);
  const extraDirs = resolveExtraDirs(group);

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const agentName = `nanoclaw-${safeName}-${Date.now()}`;

  // Compile the agent-runner TypeScript
  const projectRoot = process.cwd();
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
  const agentRunnerDist = path.join(agentRunnerDir, 'dist');
  const agentRunnerEntry = path.join(agentRunnerDist, 'index.js');

  // Build agent-runner if dist doesn't exist or src is newer
  if (!fs.existsSync(agentRunnerEntry)) {
    logger.info('Agent-runner dist not found, building...');
    const { execSync } = await import('child_process');
    execSync('npx tsc', { cwd: agentRunnerDir, stdio: 'pipe' });
  }

  // Environment variables for the agent-runner process
  const agentEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    // Path configuration — tells agent-runner where everything is
    NANOCLAW_IPC_DIR: groupIpcDir,
    NANOCLAW_IPC_INPUT_DIR: inputDir,
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_GLOBAL_DIR: path.join(GROUPS_DIR, 'global'),
    NANOCLAW_EXTRA_DIRS: extraDirs.join(':'),
    // Point HOME at the group's sessions dir so Claude SDK finds .claude/
    HOME: path.dirname(groupSessionsDir),
    // Ensure node_modules from agent-runner are available
    NODE_PATH: path.join(agentRunnerDir, 'node_modules'),
  };
  // Remove CLAUDECODE env var — prevents "nested session" detection when
  // NanoClaw itself is running inside a Claude Code session
  delete (agentEnv as Record<string, string | undefined>).CLAUDECODE;

  logger.info(
    {
      group: group.name,
      agentName,
      groupDir,
      ipcDir: groupIpcDir,
      extraDirs: extraDirs.length > 0 ? extraDirs : undefined,
      isMain: input.isMain,
    },
    'Spawning agent process',
  );

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const agent = spawn('node', [agentRunnerEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: agentEnv,
      cwd: groupDir,
    });

    onProcess(agent, agentName, inputDir);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or as env vars)
    input.secrets = readSecrets();
    agent.stdin.write(JSON.stringify(input));
    agent.stdin.end();
    delete input.secrets;

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    agent.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    agent.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ agent: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Agent stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error({ group: group.name, agentName }, 'Agent timeout, killing process');
      agent.kill('SIGTERM');
      // Force kill after 15s if SIGTERM doesn't work
      setTimeout(() => {
        if (!agent.killed) {
          agent.kill('SIGKILL');
        }
      }, 15000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    agent.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `agent-${ts}.log`);
        fs.writeFileSync(timeoutLog, [
          `=== Agent Run Log (TIMEOUT) ===`,
          `Timestamp: ${new Date().toISOString()}`,
          `Group: ${group.name}`,
          `Agent: ${agentName}`,
          `Duration: ${duration}ms`,
          `Exit Code: ${code}`,
          `Had Streaming Output: ${hadStreamingOutput}`,
        ].join('\n'));

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, agentName, duration, code },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, agentName, duration, code },
          'Agent timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Environment ===`,
          `NANOCLAW_IPC_DIR: ${groupIpcDir}`,
          `NANOCLAW_GROUP_DIR: ${groupDir}`,
          `NANOCLAW_EXTRA_DIRS: ${extraDirs.join(':')}`,
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Agent log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Agent exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Agent completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse agent output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    agent.on('error', (err) => {
      clearTimeout(timeout);
      logger.error({ group: group.name, agentName, error: err }, 'Agent spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
