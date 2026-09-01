import type {
  JsonObject,
  OpenccLocaleArtifact,
} from './enrichment.mjs';

export type LocalizableJsonPrimitive = string | number | boolean | null;
export type LocalizableJsonValue =
  | LocalizableJsonPrimitive
  | LocalizableJsonValue[]
  | { [key: string]: LocalizableJsonValue };
export type LocalizableJsonObject = {
  [key: string]: LocalizableJsonValue;
};

export interface ZhCnLocaleArtifactInput<
  TContent extends LocalizableJsonObject = LocalizableJsonObject,
> {
  content: TContent;
  promptId: string;
  promptHash: string;
  generatorVersion: number;
  cliContract: JsonObject;
}

export const ZH_TW_LOCALE: 'zh-tw';
export const ZH_CN_LOCALE: 'zh-cn';
export const OPENCC_CONVERTER_NAME: 'opencc-js:twp-to-cn';
export const OPENCC_CONVERTER_VERSION: '1.4.2';
export const OPENCC_CONVERTER_ID: 'opencc-js:twp-to-cn@1.4.2';

export function convertZhTwToZhCn(text: string): string;
export function convertZhTwContentToZhCn<TValue extends LocalizableJsonValue>(
  value: TValue,
): TValue;
export function createZhCnLocaleArtifact<
  TContent extends LocalizableJsonObject,
>(
  input: ZhCnLocaleArtifactInput<TContent>,
): OpenccLocaleArtifact<TContent>;
