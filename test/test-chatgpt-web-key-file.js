import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(testDir, '..');
const cliPath = path.join(projectDir, 'dist', 'index.js');

async function run() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dc-chatgpt-web-key-'));
  const envFilePath = path.join(tempDir, '.env');
  try {
    await writeFile(envFilePath, 'DC_CHATGPT_WEB_PUBLIC_URL=https://mcp.example.test\nDC_CHATGPT_WEB_PORT=3000\n');
    await chmod(envFilePath, 0o644);

    const generateKey = () => spawnSync(process.execPath, [cliPath, 'chatgpt-web', 'generate-key'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, DC_CHATGPT_WEB_ENV_FILE: envFilePath },
    });

    const first = generateKey();
    assert.equal(first.status, 0, first.stderr || first.error?.message);
    const firstContents = await readFile(envFilePath, 'utf8');
    const firstKey = /^DC_CHATGPT_WEB_OAUTH_KEY=([A-Za-z0-9_-]{43})$/m.exec(firstContents)?.[1];
    assert.ok(firstKey, 'the generated key should be written to the environment file');
    assert.doesNotMatch(first.stdout, new RegExp(firstKey), 'the generated key should not be printed to terminal output');
    assert.match(firstContents, /DC_CHATGPT_WEB_PUBLIC_URL=https:\/\/mcp\.example\.test/);
    assert.match(firstContents, /DC_CHATGPT_WEB_PORT=3000/);
    assert.doesNotMatch(firstContents, /DC_CHATGPT_WEB_OAUTH_(?:USERNAME|PASSWORD_HASH)=/);
    assert.equal((await stat(envFilePath)).mode & 0o777, 0o600);

    const second = generateKey();
    assert.equal(second.status, 0, second.stderr || second.error?.message);
    const secondContents = await readFile(envFilePath, 'utf8');
    const secondKey = /^DC_CHATGPT_WEB_OAUTH_KEY=([A-Za-z0-9_-]{43})$/m.exec(secondContents)?.[1];
    assert.ok(secondKey);
    assert.notEqual(secondKey, firstKey, 'running generate-key again should rotate the access key');
    assert.match(secondContents, /DC_CHATGPT_WEB_PUBLIC_URL=https:\/\/mcp\.example\.test/);
    assert.equal((await stat(envFilePath)).mode & 0o777, 0o600);

    console.log('✓ ChatGPT Web generate-key writes and rotates a private env key without printing it');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error('✗ ChatGPT Web access-key file test failed:', error);
  process.exitCode = 1;
});
