import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Ajv from 'ajv';

export const DEFAULT_LLM_CONCURRENCY = 4;
export const COPILOT_CLI_CONTRACT = Object.freeze({
  version: 1,
  model: 'gpt-5.4',
  flags: Object.freeze([
    '--model <pinned>',
    '--no-custom-instructions',
    '--disable-builtin-mcps',
    '--silent',
    '--no-ask-user',
    '--available-tools=view,apply_patch',
    '--allow-tool=write(<output-file>)',
    '--disallow-temp-dir',
    '-C <temp-directory>',
    '--prompt <path-only prompt>',
  ]),
});

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const STRIPPED_CHILD_ENVIRONMENT = Object.freeze([
  'COPILOT_ALLOW_ALL',
  'COPILOT_ASSISTED_APPROVAL',
  'GITHUB_WORKSPACE',
]);

class Semaphore {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.active >= this.limit) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    return () => {
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
  return value;
}

function appendBounded(current, chunk, child) {
  const next = current + chunk.toString('utf8');
  if (Buffer.byteLength(next, 'utf8') > MAX_CAPTURE_BYTES) {
    child.kill();
    throw new Error(`Copilot output exceeded ${MAX_CAPTURE_BYTES} bytes.`);
  }
  return next;
}

function childEnvironment() {
  const environment = { ...process.env };
  for (const name of STRIPPED_CHILD_ENVIRONMENT) {
    delete environment[name];
  }
  return environment;
}

function runProcess(command, args, { cwd, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let captureError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      try {
        stdout = appendBounded(stdout, chunk, child);
      } catch (error) {
        captureError = error;
      }
    });
    child.stderr.on('data', (chunk) => {
      try {
        stderr = appendBounded(stderr, chunk, child);
      } catch (error) {
        captureError = error;
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (captureError) {
        reject(captureError);
      } else if (timedOut) {
        const error = new Error(`Copilot call timed out after ${timeoutMs}ms.`);
        error.kind = 'timeout';
        reject(error);
      } else if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `signal ${signal ?? 'none'}`;
        const error = new Error(`Copilot exited with code ${code}: ${detail}`);
        error.kind = 'process';
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function finalFailure(lastError, attempts) {
  const prefix = lastError.kind === 'schema'
    ? 'Copilot schema validation failed'
    : lastError.kind === 'json'
      ? 'Copilot JSON parsing failed'
      : lastError.kind === 'timeout'
        ? 'Copilot call timed out'
        : 'Copilot call failed';
  return new Error(`${prefix} after ${attempts} attempts: ${lastError.message}`);
}

export function createCopilotRunner({
  executable = 'copilot',
  executableArgs = [],
  maxConcurrency = DEFAULT_LLM_CONCURRENCY,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tempRoot = os.tmpdir(),
} = {}) {
  positiveInteger(maxConcurrency, 'maxConcurrency');
  positiveInteger(maxAttempts, 'maxAttempts');
  positiveInteger(timeoutMs, 'timeoutMs');
  if (typeof executable !== 'string' || executable === '') {
    throw new TypeError('executable must be a non-empty string.');
  }
  if (!Array.isArray(executableArgs) || executableArgs.some((value) => typeof value !== 'string')) {
    throw new TypeError('executableArgs must be an array of strings.');
  }

  const semaphore = new Semaphore(maxConcurrency);

  return Object.freeze({
    async run({ instruction, payload, schema }) {
      if (typeof instruction !== 'string' || instruction === '') {
        throw new TypeError('instruction must be a non-empty string.');
      }
      if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new TypeError('schema must be a JSON Schema object.');
      }

      const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);
      const release = await semaphore.acquire();
      let lastError;

      try {
        await mkdir(tempRoot, { recursive: true });
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const workDirectory = await mkdtemp(path.join(tempRoot, 'skills-enrichment-'));
          const inputPath = path.join(workDirectory, 'request.json');
          const outputPath = path.join(workDirectory, 'response.json');

          try {
            await writeFile(
              inputPath,
              `${JSON.stringify({ instruction, payload, schema }, null, 2)}\n`,
              'utf8',
            );
            const prompt =
              `Read the JSON request at "${inputPath}". Follow its instruction field and ` +
              `satisfy its schema field. Write only the resulting JSON value to "${outputPath}". ` +
              'Do not modify any other file.';
            const args = [
              ...executableArgs,
              '--model',
              COPILOT_CLI_CONTRACT.model,
              '--no-custom-instructions',
              '--disable-builtin-mcps',
              '--silent',
              '--no-ask-user',
              '--available-tools=view,apply_patch',
              `--allow-tool=write(${outputPath})`,
              '--disallow-temp-dir',
              '-C',
              workDirectory,
              '--prompt',
              prompt,
            ];

            await runProcess(executable, args, { cwd: workDirectory, timeoutMs });

            let value;
            try {
              value = JSON.parse(await readFile(outputPath, 'utf8'));
            } catch (error) {
              error.kind = 'json';
              throw error;
            }

            if (!validate(value)) {
              const error = new Error(
                (validate.errors ?? [])
                  .map((entry) => `${entry.instancePath || '/'} ${entry.message}`)
                  .join('; '),
              );
              error.kind = 'schema';
              throw error;
            }

            return value;
          } catch (error) {
            lastError = error;
          } finally {
            await rm(workDirectory, { recursive: true, force: true });
          }
        }
      } finally {
        release();
      }

      throw finalFailure(lastError, maxAttempts);
    },
  });
}
