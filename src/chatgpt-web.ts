import { createChatGptWebPasswordHash, ChatGptWebOAuthProvider } from './chatgpt-web/oauth.js';
import { startChatGptWebGateway } from './chatgpt-web/gateway.js';

async function readHiddenPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Run `desktop-commander chatgpt-web hash-password` in an interactive terminal.');
  }

  return new Promise<string>((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          finish(new Error('Password entry was cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        if (character >= ' ') {
          value += character;
          process.stderr.write('*');
        }
      }
    };

    process.stderr.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

export async function runChatGptWebPasswordHash(): Promise<void> {
  const password = await readHiddenPassword('Password (minimum 12 characters): ');
  const confirmation = await readHiddenPassword('Confirm password: ');
  if (password !== confirmation) {
    throw new Error('The passwords did not match. No hash was created.');
  }
  const passwordHash = createChatGptWebPasswordHash(password);
  process.stdout.write(`${passwordHash}\n`);
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
  const username = process.env.DC_CHATGPT_WEB_OAUTH_USERNAME;
  const passwordHash = process.env.DC_CHATGPT_WEB_OAUTH_PASSWORD_HASH;
  if (!username) throw new Error('Set DC_CHATGPT_WEB_OAUTH_USERNAME before starting the ChatGPT Web gateway.');
  if (!passwordHash) throw new Error('Set DC_CHATGPT_WEB_OAUTH_PASSWORD_HASH before starting the ChatGPT Web gateway.');

  const publicUrl = readPublicUrl();
  const port = readPort();
  const oauthProvider = new ChatGptWebOAuthProvider({
    username,
    passwordHash,
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
