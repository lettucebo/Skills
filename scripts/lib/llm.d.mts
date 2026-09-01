export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = Record<string, unknown>;

export interface CopilotCliContract {
  readonly version: 1;
  readonly model: 'gpt-5.4';
  readonly flags: readonly string[];
}

export interface CopilotRunRequest {
  instruction: string;
  payload: JsonValue;
  schema: JsonSchema;
}

export interface CopilotRunner {
  run<T extends JsonValue = JsonValue>(request: CopilotRunRequest): Promise<T>;
}

export interface CopilotRunnerOptions {
  executable?: string;
  executableArgs?: string[];
  maxConcurrency?: number;
  maxAttempts?: number;
  timeoutMs?: number;
  tempRoot?: string;
}

export const DEFAULT_LLM_CONCURRENCY: 4;
export const COPILOT_CLI_CONTRACT: CopilotCliContract;
export function createCopilotRunner(options?: CopilotRunnerOptions): CopilotRunner;
