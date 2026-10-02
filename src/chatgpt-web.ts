import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ChatGptWebOAuthProvider, generateChatGptWebAccessKey } from './chatgpt-web/oauth.js';
import { startChatGptWebGateway } from './chatgpt-web/gateway.js';

function writeChatGptWebAccessKey(): string {
  const envFilePath = resolve(
    process.env.DC_CHATGPT_WEB_ENV_FILE ?? join(homedir(), '.config', 'desktop-commander', 'chatgpt-web.env'),
  );
  mkdirSync(dirname(envFilePath), { recursive: true, mode: 0o700 });

  let existing = '';
  try {
    const fileStat = lstatSync(envFilePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      throw new Error('The ChatGPT Web environment file must be a regular file, not a symlink.');
    }
    existing = readFileSync(envFilePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const preservedLines = existing.split(/\r?\n/).filter((line) =>
    !/^\s*DC_CHATGPT_WEB_OAUTH_(?:USERNAME|PASSWORD_HASH|KEY)\s*=/.test(line),
  );
  while (preservedLines.at(-1) === '') preservedLines.pop();

  const accessKey = generateChatGptWebAccessKey();
  const contents = [...preservedLines, `DC_CHATGPT_WEB_OAUTH_KEY=${accessKey}`, ''].join('\n');
  const temporaryPath = `${envFilePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    throw error;
  }

  try {
    renameSync(temporaryPath, envFilePath);
    chmodSync(envFilePath, 0o600);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    throw error;
  }
  return envFilePath;
}

export function runChatGptWebGenerateKey(): void {
  const envFilePath = writeChatGptWebAccessKey();
  process.stdout.write(
    `Generated a new ChatGPT Web access key in ${envFilePath}\n` +
    'The gateway uses this key automatically; no key entry in ChatGPT is needed.\n' +
    'Restart the gateway service to activate the new key.\n',
    () => process.exit(0),
  );
}

function readPublicUrl(): URL {
  const configured = process.env.DC_CHATGPT_WEB_PUBLIC_URL;
  if (!configured) {
    throw new Error('Set DC_CHATGPT_WEB_PUBLIC_URL to your public HTTPS origin, for example https://mcp.example.com.');
  }
  let publicUrl: URL;
  try {
    publicUrl = new URL(configured);
  } catch {
    throw new Error('DC_CHATGPT_WEB_PUBLIC_URL must be a valid HTTPS origin.');
  }
  if (publicUrl.protocol !== 'https:' || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash ||
    publicUrl.username || publicUrl.password) {
    throw new Error('DC_CHATGPT_WEB_PUBLIC_URL must be an HTTPS origin without a path, credentials, query, or fragment.');
  }
  return new URL(publicUrl.origin);
}

function readPort(): number {
  const configured = process.env.DC_CHATGPT_WEB_PORT ?? '3000';
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DC_CHATGPT_WEB_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

export async function runChatGptWeb(): Promise<void> {
  const accessKey = process.env.DC_CHATGPT_WEB_OAUTH_KEY;
  if (!accessKey) throw new Error('Set DC_CHATGPT_WEB_OAUTH_KEY by running `desktop-commander chatgpt-web generate-key` before starting the ChatGPT Web gateway.');

  const publicUrl = readPublicUrl();
  const port = readPort();
  const oauthProvider = new ChatGptWebOAuthProvider({
    accessKey,
    resourceUrl: new URL('/mcp', publicUrl),
  });
  const gateway = await startChatGptWebGateway({ publicUrl, port, oauthProvider });
  process.stderr.write(`[ChatGPT Web MCP] Listening on http://127.0.0.1:${gateway.port}/mcp\n`);
  process.stderr.write(`[ChatGPT Web MCP] Public URL for your HTTPS ingress: ${new URL('/mcp', publicUrl).href}\n`);

  await new Promise<void>((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void gateway.close().catch((error) => {
        process.stderr.write(`[ChatGPT Web MCP] Shutdown error: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      }).finally(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
