import assert from 'node:assert/strict';
import { buildChatGptWebChildEnvironment } from '../dist/chatgpt-web/gateway.js';

const childEnvironment = buildChatGptWebChildEnvironment({
  DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
  KILO_AGENT_WORKING_DIRECTORY: '/workspace/ornix-tts',
  ORNIXAI_CONTROL_ENDPOINT_PATH: '/run/user/1000/ornixai-control.sock',
  ORNIXAI_CONTROL_CREDENTIAL_FILE: '/tmp/ornixai/control.token',
  HOME: '/home/test-user',
  API_TOKEN: 'must-not-be-forwarded',
});

assert.deepEqual(childEnvironment, {
  DC_CHATGPT_WEB_CHILD: 'true',
  DESKTOP_COMMANDER_DISABLE_TELEMETRY: 'true',
  KILO_AGENT_WORKING_DIRECTORY: '/workspace/ornix-tts',
  ORNIXAI_CONTROL_ENDPOINT_PATH: '/run/user/1000/ornixai-control.sock',
  ORNIXAI_CONTROL_CREDENTIAL_FILE: '/tmp/ornixai/control.token',
}, 'the per-session MCP child should receive explicit tool configuration without unrelated gateway environment values');

console.log('✓ ChatGPT Web child environment forwards configured tool paths and keeps its allowlist');
