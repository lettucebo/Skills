import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  COPILOT_CLI_CONTRACT,
  DEFAULT_LLM_CONCURRENCY,
  createCopilotRunner,
} from '../lib/llm.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.join(__dirname, '.runtime');

const outputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['value'],
  properties: {
    value: { type: 'string' },
  },
};

async function createFakeCopilot() {
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(path.join(runtimeRoot, 'llm-'));
  const script = path.join(root, 'fake-copilot.mjs');
  const source = `
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
if (process.env.FAKE_COPILOT_ARGS) {
  await writeFile(process.env.FAKE_COPILOT_ARGS, JSON.stringify(args));
}
if (process.env.FAKE_COPILOT_ENV) {
  await writeFile(process.env.FAKE_COPILOT_ENV, JSON.stringify({
    COPILOT_ALLOW_ALL: process.env.COPILOT_ALLOW_ALL ?? null,
    GITHUB_WORKSPACE: process.env.GITHUB_WORKSPACE ?? null,
  }));
}

const promptIndex = args.indexOf('--prompt');
const prompt = args[promptIndex + 1];
const quotedPaths = [...prompt.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const [inputPath, outputPath] = quotedPaths;
const request = JSON.parse(await readFile(inputPath, 'utf8'));

if (request.payload.behavior === 'timeout') {
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

let attempt = 1;
if (process.env.FAKE_COPILOT_COUNTER) {
  try {
    attempt = Number(await readFile(process.env.FAKE_COPILOT_COUNTER, 'utf8')) + 1;
  } catch {}
  await writeFile(process.env.FAKE_COPILOT_COUNTER, String(attempt));
}

if (request.payload.behavior === 'invalid-once' && attempt === 1) {
  await writeFile(outputPath, '{"value":');
} else if (request.payload.behavior === 'schema-invalid') {
  await writeFile(outputPath, JSON.stringify({ wrong: true }));
} else {
  await writeFile(outputPath, JSON.stringify({ value: request.payload.value }));
}
`;
  await writeFile(script, source);
  await chmod(script, 0o755);
  return { root, script };
}

test('Copilot runner keeps payload out of argv and pins the verified headless CLI contract', async () => {
  const fixture = await createFakeCopilot();
  const tempRoot = path.join(fixture.root, 'temp');
  const argsPath = path.join(fixture.root, 'args.json');
  const envPath = path.join(fixture.root, 'env.json');
  await mkdir(tempRoot);
  const previousArgsPath = process.env.FAKE_COPILOT_ARGS;
  const previousEnvPath = process.env.FAKE_COPILOT_ENV;
  const previousAllowAll = process.env.COPILOT_ALLOW_ALL;
  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  process.env.FAKE_COPILOT_ARGS = argsPath;
  process.env.FAKE_COPILOT_ENV = envPath;
  process.env.COPILOT_ALLOW_ALL = 'true';
  process.env.GITHUB_WORKSPACE = 'C:\\sensitive\\repository';

  try {
    const marker = `payload-${'x'.repeat(40_000)}`;
    const runner = createCopilotRunner({
      executable: process.execPath,
      executableArgs: [fixture.script],
      tempRoot,
    });
    const result = await runner.run({
      instruction: 'Return the payload value.',
      payload: { value: marker },
      schema: outputSchema,
    });
    const args = JSON.parse(await readFile(argsPath, 'utf8'));
    const childEnv = JSON.parse(await readFile(envPath, 'utf8'));
    const joined = args.join(' ');

    assert.deepEqual(result, { value: marker });
    assert.doesNotMatch(joined, /payload-xxx/);
    assert.ok(joined.length < 4_000, `argv should contain paths and fixed instructions only: ${joined.length}`);
    assert.equal(args[args.indexOf('--model') + 1], COPILOT_CLI_CONTRACT.model);
    for (const flag of [
      '--no-custom-instructions',
      '--disable-builtin-mcps',
      '--silent',
      '--no-ask-user',
      '--disallow-temp-dir',
    ]) {
      assert.ok(args.includes(flag), `missing required CLI flag ${flag}`);
    }
    const allowTools = args.filter((arg) => arg.startsWith('--allow-tool='));
    assert.equal(allowTools.length, 1);
    assert.match(allowTools[0], /^--allow-tool=write\(.+response\.json\)$/);
    assert.ok(
      args.includes('--available-tools=view,apply_patch'),
      'the model must not see shell, MCP, or unrelated filesystem tools',
    );
    assert.deepEqual(childEnv, {
      COPILOT_ALLOW_ALL: null,
      GITHUB_WORKSPACE: null,
    });
    assert.equal(DEFAULT_LLM_CONCURRENCY, 4);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    if (previousArgsPath === undefined) delete process.env.FAKE_COPILOT_ARGS;
    else process.env.FAKE_COPILOT_ARGS = previousArgsPath;
    if (previousEnvPath === undefined) delete process.env.FAKE_COPILOT_ENV;
    else process.env.FAKE_COPILOT_ENV = previousEnvPath;
    if (previousAllowAll === undefined) delete process.env.COPILOT_ALLOW_ALL;
    else process.env.COPILOT_ALLOW_ALL = previousAllowAll;
    if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previousWorkspace;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Copilot runner retries invalid JSON and returns only a schema-valid result', async () => {
  const fixture = await createFakeCopilot();
  const tempRoot = path.join(fixture.root, 'temp');
  const counterPath = path.join(fixture.root, 'counter.txt');
  await mkdir(tempRoot);
  const previousCounter = process.env.FAKE_COPILOT_COUNTER;
  process.env.FAKE_COPILOT_COUNTER = counterPath;

  try {
    const runner = createCopilotRunner({
      executable: process.execPath,
      executableArgs: [fixture.script],
      tempRoot,
      maxAttempts: 2,
    });
    const result = await runner.run({
      instruction: 'Return valid JSON.',
      payload: { behavior: 'invalid-once', value: 'valid' },
      schema: outputSchema,
    });

    assert.deepEqual(result, { value: 'valid' });
    assert.equal(await readFile(counterPath, 'utf8'), '2');
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    if (previousCounter === undefined) delete process.env.FAKE_COPILOT_COUNTER;
    else process.env.FAKE_COPILOT_COUNTER = previousCounter;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Copilot runner fails closed on schema-invalid output and cleans every temp file', async () => {
  const fixture = await createFakeCopilot();
  const tempRoot = path.join(fixture.root, 'temp');
  await mkdir(tempRoot);

  try {
    const runner = createCopilotRunner({
      executable: process.execPath,
      executableArgs: [fixture.script],
      tempRoot,
      maxAttempts: 2,
    });

    await assert.rejects(
      runner.run({
        instruction: 'Return valid JSON.',
        payload: { behavior: 'schema-invalid', value: 'ignored' },
        schema: outputSchema,
      }),
      /schema validation failed.*2 attempts/i,
    );
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('Copilot runner enforces the per-call timeout and cleans the failure path', async () => {
  const fixture = await createFakeCopilot();
  const tempRoot = path.join(fixture.root, 'temp');
  await mkdir(tempRoot);

  try {
    const runner = createCopilotRunner({
      executable: process.execPath,
      executableArgs: [fixture.script],
      tempRoot,
      maxAttempts: 1,
      timeoutMs: 100,
    });

    await assert.rejects(
      runner.run({
        instruction: 'Return valid JSON.',
        payload: { behavior: 'timeout', value: 'ignored' },
        schema: outputSchema,
      }),
      /timed out.*100ms/i,
    );
    assert.deepEqual(await readdir(tempRoot), []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
