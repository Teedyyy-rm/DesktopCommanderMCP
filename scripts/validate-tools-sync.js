#!/usr/bin/env node
/**
 * Validates that the tools listed in mcpb-bundle/manifest.json match
 * the tools actually provided by the running MCP server
 * 
 * This uses JSON-RPC to query the server directly, avoiding fragile regex parsing.
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

// ANSI color codes for pretty output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

async function extractToolsFromManifest() {
  // Prefer the built bundle when present so validation catches stale package
  // artifacts. A normal source checkout does not include this ignored output;
  // validate against the checked-in template instead of failing with ENOENT.
  const bundleManifestPath = join(rootDir, 'mcpb-bundle', 'manifest.json');
  const templateManifestPath = join(rootDir, 'manifest.template.json');
  let manifestPath = templateManifestPath;
  try {
    await readFile(bundleManifestPath, 'utf-8');
    manifestPath = bundleManifestPath;
  } catch {
    // The template is the source of truth until a bundle is built.
  }
  const content = await readFile(manifestPath, 'utf-8');
  const manifest = JSON.parse(content);
  
  return manifest.tools.map(tool => tool.name).sort();
}

async function extractToolsFromServer() {
  return new Promise((resolve, reject) => {
    // Start the MCP server
    const serverPath = join(rootDir, 'dist', 'index.js');
    const server = spawn('node', [serverPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';
    let settled = false;
    let initialized = false;
    const messages = [];
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for tools/list; messages=${JSON.stringify(messages)}; stderr=${errorOutput}`));
    }, 15_000);

    function finish(error, tools) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.kill();
      if (error) reject(error);
      else resolve(tools);
    }

    server.stdout.on('data', (data) => {
      output += data.toString();
      
      // Try to parse each line as JSON-RPC message
      const lines = output.split('\n');
      output = lines.pop() || ''; // Keep incomplete line
      
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            messages.push(message);
            if (message.id === 1) {
              if (message.error) {
                finish(new Error(`MCP initialize failed: ${JSON.stringify(message.error)}; stderr=${errorOutput}`));
              } else if (message.result && !initialized) {
                initialized = true;
                server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
                server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
              }
            } else if (message.id === 2) {
              if (message.error) {
                finish(new Error(`tools/list failed: ${JSON.stringify(message.error)}; stderr=${errorOutput}`));
              } else if (message.result?.tools) {
                const tools = message.result.tools.map(tool => tool.name).sort();
                finish(undefined, tools);
              }
            }
          } catch (e) {
            // Not JSON, might be debug output
          }
        }
      }
    });

    server.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    server.on('error', (error) => {
      finish(new Error(`Failed to start MCP server: ${error.message}`));
    });
    server.on('exit', (code, signal) => {
      if (!settled) finish(new Error(`MCP server exited before tools/list completed (code=${code}, signal=${signal}); messages=${JSON.stringify(messages)}; stderr=${errorOutput}`));
    });

    // Step 1: Send initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'validate-tools-sync',
          version: '1.0.0'
        }
      }
    };

    server.stdin.write(JSON.stringify(initRequest) + '\n');
  });
}

async function main() {
  console.log(`${colors.cyan}🔍 Validating tool synchronization...${colors.reset}\n`);
  
  try {
    const manifestTools = await extractToolsFromManifest();
    const serverTools = await extractToolsFromServer();
    
    console.log(`${colors.blue}📋 Manifest tools (${manifestTools.length}):${colors.reset}`);
    manifestTools.forEach(tool => console.log(`   - ${tool}`));
    
    console.log(`\n${colors.blue}⚙️  Server tools (${serverTools.length}):${colors.reset}`);
    serverTools.forEach(tool => console.log(`   - ${tool}`));
    
    // Find differences
    const missingInManifest = serverTools.filter(t => !manifestTools.includes(t));
    const missingInServer = manifestTools.filter(t => !serverTools.includes(t));
    
    console.log('\n' + '='.repeat(60));
    
    if (missingInManifest.length === 0 && missingInServer.length === 0) {
      console.log(`${colors.green}✅ SUCCESS: All tools are in sync!${colors.reset}`);
      console.log(`${colors.green}   Both manifest.json and server.ts have ${manifestTools.length} tools.${colors.reset}`);
      process.exit(0);
    } else {
      console.log(`${colors.red}❌ MISMATCH DETECTED!${colors.reset}\n`);
      
      if (missingInManifest.length > 0) {
        console.log(`${colors.yellow}⚠️  Tools in server.ts but NOT in manifest.json:${colors.reset}`);
        missingInManifest.forEach(tool => console.log(`   ${colors.red}✗${colors.reset} ${tool}`));
        console.log();
      }
      
      if (missingInServer.length > 0) {
        console.log(`${colors.yellow}⚠️  Tools in manifest.json but NOT in server.ts:${colors.reset}`);
        missingInServer.forEach(tool => console.log(`   ${colors.red}✗${colors.reset} ${tool}`));
        console.log();
      }
      
      console.log(`${colors.red}Please update the files to match!${colors.reset}`);
      process.exit(1);
    }
    
  } catch (error) {
    console.error(`${colors.red}❌ Error:${colors.reset}`, error.message);
    process.exit(1);
  }
}

main();
