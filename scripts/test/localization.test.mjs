import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLocaleSignature } from '../lib/enrichment.mjs';
import {
  OPENCC_CONVERTER_ID,
  OPENCC_CONVERTER_NAME,
  OPENCC_CONVERTER_VERSION,
  ZH_CN_LOCALE,
  ZH_TW_LOCALE,
  convertZhTwContentToZhCn,
  convertZhTwToZhCn,
  createZhCnLocaleArtifact,
} from '../lib/localization.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PROMPT_HASH = `sha256:${'a'.repeat(64)}`;
const CLI_CONTRACT = { version: 1, model: 'gpt-5.4' };

test('Taiwan phrase preset converts representative software terminology to Simplified Chinese', () => {
  assert.deepEqual(
    ['軟體', '程式', '資料庫', '網路'].map(convertZhTwToZhCn),
    ['软件', '程序', '数据库', '网络'],
  );
});

test('conversion preserves technical identifiers and URL syntax', () => {
  const source = {
    apiURL: 'https://api.example.com/v1/repos/owner/name?user_id=dbConnection',
    command: 'npm run validate:enrichment -- --strict',
    identifier: 'user_id dbConnection OPENCC_CONVERTER_ID',
    text: '軟體資料庫與網路程式',
  };

  assert.deepEqual(convertZhTwContentToZhCn(source), {
    apiURL: source.apiURL,
    command: source.command,
    identifier: source.identifier,
    text: '软件数据库与网络程序',
  });
  assert.deepEqual(source, {
    apiURL: 'https://api.example.com/v1/repos/owner/name?user_id=dbConnection',
    command: 'npm run validate:enrichment -- --strict',
    identifier: 'user_id dbConnection OPENCC_CONVERTER_ID',
    text: '軟體資料庫與網路程式',
  });
});

test('content conversion is deterministic across nested JSON values', () => {
  const source = {
    title: '軟體',
    sections: [
      { heading: '資料庫', enabled: true },
      { heading: '網路', count: 2 },
    ],
    metadata: null,
  };

  const first = convertZhTwContentToZhCn(source);
  const second = convertZhTwContentToZhCn(source);

  assert.deepEqual(first, {
    title: '软件',
    sections: [
      { heading: '数据库', enabled: true },
      { heading: '网络', count: 2 },
    ],
    metadata: null,
  });
  assert.deepEqual(second, first);
  assert.notEqual(first, source);
  assert.notEqual(first.sections, source.sections);
});

test('content conversion rejects values outside deterministic JSON content', () => {
  assert.throws(
    () => convertZhTwContentToZhCn({ invalid: undefined }),
    /cannot contain undefined values/i,
  );
  assert.throws(
    () => convertZhTwContentToZhCn({ invalid: Number.NaN }),
    /cannot contain non-finite numbers/i,
  );
  assert.throws(
    () => convertZhTwContentToZhCn({ invalid: new Date(0) }),
    /only plain JSON objects/i,
  );
});

test('zh-CN artifact builder converts content and signs the pinned converter identity', () => {
  const content = {
    title: '軟體資料庫',
    details: ['程式', '網路'],
  };
  const artifact = createZhCnLocaleArtifact({
    content,
    promptId: 'summary-zh-tw-v1',
    promptHash: PROMPT_HASH,
    generatorVersion: 1,
    cliContract: CLI_CONTRACT,
  });
  const expectedSignature = createLocaleSignature({
    locale: ZH_CN_LOCALE,
    schemaVersion: 1,
    producer: 'opencc',
    promptId: 'summary-zh-tw-v1',
    promptHash: PROMPT_HASH,
    converterVersion: OPENCC_CONVERTER_ID,
    generatorVersion: 1,
    cliContract: CLI_CONTRACT,
  });

  assert.deepEqual(artifact, {
    signature: expectedSignature,
    producer: 'opencc',
    converterVersion: OPENCC_CONVERTER_ID,
    generatorVersion: 1,
    content: {
      title: '软件数据库',
      details: ['程序', '网络'],
    },
  });
  assert.equal(ZH_TW_LOCALE, 'zh-tw');
  assert.equal(ZH_CN_LOCALE, 'zh-cn');
});

test('locale signature changes when only the converter version changes', () => {
  const signatureInput = {
    locale: ZH_CN_LOCALE,
    schemaVersion: 1,
    producer: 'opencc',
    promptId: 'summary-zh-tw-v1',
    promptHash: PROMPT_HASH,
    generatorVersion: 1,
    cliContract: CLI_CONTRACT,
  };

  assert.notEqual(
    createLocaleSignature({
      ...signatureInput,
      converterVersion: OPENCC_CONVERTER_ID,
    }),
    createLocaleSignature({
      ...signatureInput,
      converterVersion: `${OPENCC_CONVERTER_NAME}@1.4.3`,
    }),
  );
});

test('pinned converter version matches the installed opencc-js package', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(repoRoot, 'node_modules', 'opencc-js', 'package.json'), 'utf8'),
  );

  assert.equal(packageJson.version, OPENCC_CONVERTER_VERSION);
  assert.equal(OPENCC_CONVERTER_ID, `${OPENCC_CONVERTER_NAME}@${packageJson.version}`);
});
