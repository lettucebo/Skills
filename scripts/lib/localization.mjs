import OpenCC from 'opencc-js';

import {
  ENRICHMENT_LOCALES,
  ENRICHMENT_SCHEMA_VERSION,
  createLocaleSignature,
} from './enrichment.mjs';

export const ZH_TW_LOCALE = ENRICHMENT_LOCALES[1];
export const ZH_CN_LOCALE = ENRICHMENT_LOCALES[2];
export const OPENCC_CONVERTER_NAME = 'opencc-js:twp-to-cn';
export const OPENCC_CONVERTER_VERSION = '1.4.2';
export const OPENCC_CONVERTER_ID =
  `${OPENCC_CONVERTER_NAME}@${OPENCC_CONVERTER_VERSION}`;

const convertText = OpenCC.Converter({ from: 'twp', to: 'cn' });

export function convertZhTwToZhCn(text) {
  if (typeof text !== 'string') {
    throw new TypeError('convertZhTwToZhCn requires a string.');
  }
  return convertText(text);
}

export function convertZhTwContentToZhCn(value) {
  if (typeof value === 'string') {
    return convertZhTwToZhCn(value);
  }
  if (value === null || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Localization content cannot contain non-finite numbers.');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => convertZhTwContentToZhCn(entry));
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Localization content accepts only plain JSON objects.');
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        convertZhTwContentToZhCn(entry),
      ]),
    );
  }

  throw new TypeError(`Localization content cannot contain ${typeof value} values.`);
}

export function createZhCnLocaleArtifact({
  content,
  promptId,
  promptHash,
  generatorVersion,
  cliContract,
}) {
  return {
    signature: createLocaleSignature({
      locale: ZH_CN_LOCALE,
      schemaVersion: ENRICHMENT_SCHEMA_VERSION,
      producer: 'opencc',
      promptId,
      promptHash,
      converterVersion: OPENCC_CONVERTER_ID,
      generatorVersion,
      cliContract,
    }),
    producer: 'opencc',
    converterVersion: OPENCC_CONVERTER_ID,
    generatorVersion,
    content: convertZhTwContentToZhCn(content),
  };
}
