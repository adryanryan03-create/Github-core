// Entry point: everything the trial harness expects from this process, and
// nothing else. The forge itself lives in app.ts and the modules behind it;
// this file only performs the small ceremony around it —
//
//   1. start the HTTP server on a port the kernel picks for us (port 0),
//   2. tell the contest environment which port that turned out to be,
//   3. ask the environment, over and over, whether the suite is finished,
//   4. once it says yes: shut the server down and leave with status 0.
//
// The environment's base URL arrives in MAKEFUN_ENV_URL. Registration is a
// POST to <env>/register carrying {"port": N}; the finish signal is a GET to
// <env>/done answering {"done": true}. Both facts come from the kit's rules;
// the code below is my own arrangement of them.

import type { Server } from 'node:http';
import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const POLL_EVERY_MS = 250;
const REGISTER_TRIES = 40;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startForge(): Promise<{ server: Server; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not report a TCP port');
  }
  return { server, port: address.port };
}

// Registration is retried a few times: the environment is the only judge of
// the boot budget, but a single dropped first attempt should not cost the
// whole trial when a second one a moment later would have landed.
async function tellEnvOurPort(port: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_TRIES; attempt += 1) {
    try {
      const reply = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (reply.ok) return;
      lastError = new Error(`register answered HTTP ${reply.status}`);
    } catch (err) {
      lastError = err;
    }
    await pause(POLL_EVERY_MS);
  }
  throw lastError instanceof Error ? lastError : new Error('registration never succeeded');
}

// A failed poll — a reset connection, a 5xx while the suite is busy writing
// its export — is not a finish signal. Only an explicit done:true ends us.
async function waitUntilSuiteIsDone(): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${ENV_URL}/done`);
      if (reply.ok) {
        const state = (await reply.json()) as { done?: unknown };
        if (state.done === true) return;
      }
    } catch {
      // Transient by assumption; the next poll decides.
    }
    await pause(POLL_EVERY_MS);
  }
}

async function run(): Promise<void> {
  const { server, port } = await startForge();
  if (ENV_URL === '') {
    // No environment to report to (a human started us directly): just serve.
    console.log(`[forge] listening on port ${port}, no MAKEFUN_ENV_URL set`);
    return;
  }
  await tellEnvOurPort(port);
  console.log(`[forge] registered port ${port}, waiting for the suite to finish`);
  await waitUntilSuiteIsDone();
  // Begin shutdown without awaiting it: idle keep-alive sockets may linger,
  // and the explicit exit below — not the last socket — ends this process.
  server.close();
  console.log('[forge] suite is done, exiting');
}

run().then(
  () => {
    if (ENV_URL !== '') process.exit(0);
  },
  (err: unknown) => {
    console.error('[forge] fatal:', err);
    process.exit(1);
  },
);
