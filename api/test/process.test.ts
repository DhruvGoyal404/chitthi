import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB_PASSWORD, UNREACHABLE_DB_URL, WEB_ORIGIN } from './helpers.js';

// Runs the real entry point in its own process: proves the process survives bad input, and
// that nothing it prints (startup, request logs, errors) contains the connection string.
const apiDir = fileURLToPath(new URL('..', import.meta.url));
let child: ChildProcess;
let output = '';
let baseUrl = '';

beforeAll(async () => {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: apiDir,
    env: {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT, // Windows needs it for networking
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '0',
      LOG_LEVEL: 'debug',
      DATABASE_URL: UNREACHABLE_DB_URL,
      WEB_ORIGINS: WEB_ORIGIN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const onData = (chunk: Buffer) => { output += chunk.toString('utf8'); };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`api did not start:\n${output}`)); }, 15_000);
    const check = () => {
      const m = /"port":(\d+)[^\n]*"msg":"api listening"/.exec(output);
      if (m) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${m[1] ?? ''}`);
      }
    };
    child.stdout?.on('data', check);
    child.on('exit', (code) => { reject(new Error(`api exited with ${String(code)}:\n${output}`)); });
  });
});

afterAll(() => {
  child.kill();
});

describe('api process', () => {
  it('survives garbage input and keeps answering', async () => {
    const garbage = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
      body: '{{{{ definitely not json',
    });
    expect(garbage.status).toBe(400);

    const binary = await fetch(`${baseUrl}/api/x`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
      body: new Uint8Array([0, 255, 13, 10, 0x7b]),
    });
    expect(binary.status).toBe(400);

    const health = await fetch(`${baseUrl}/api/health`);
    expect(health.status).toBe(503);
    expect(child.exitCode).toBeNull();
  });

  // GHSA-27r3-jxmh-p828: in body-parser ≤ 2.3.0, a compressed body followed by trailing bytes
  // throws from the finished decoder after the response, killing the process. No client sends
  // compressed request bodies, so the parser refuses them (inflate: false) before decompressing.
  it('refuses compressed request bodies, and survives one with trailing bytes', async () => {
    const res = await fetch(`${baseUrl}/api/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Origin: WEB_ORIGIN },
      body: Buffer.concat([gzipSync('{"a":1}'), Buffer.from('trailing bytes')]),
    });
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_body');
    await new Promise((resolve) => setTimeout(resolve, 200)); // the crash came just after the response
    expect((await fetch(`${baseUrl}/api/health`)).status).toBe(503);
    expect(child.exitCode).toBeNull();
  });

  it('never prints the connection string or its password', () => {
    expect(output).toContain('api listening'); // the assertion below inspects real output
    expect(output).not.toContain(DB_PASSWORD);
    expect(output).not.toContain(UNREACHABLE_DB_URL);
    expect(output).not.toMatch(/postgres:\/\/[^\s"]*:[^\s"]*@/);
  });
});
