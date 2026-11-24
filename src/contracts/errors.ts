// 错误码。见 docs/interfaces.md §7。
import { z } from "zod";

export const ERROR_CODES = [
  "NO_TASK",
  "TASK_NOT_FOUND",
  "NOT_BOUND",
  "SUBTASK_NOT_FOUND",
  "NO_PLAN",
  "INVALID_INPUT",
  "PATH_OUTSIDE_TASK",
  "FILE_NOT_FOUND",
  "BINARY_FILE",
  "LOCK_TIMEOUT",
  "SCHEMA_TOO_NEW",
  "INTERNAL",
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** 工具出错时 structuredContent 的结构。 */
export const ToolError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    candidates: z.array(z.string()).optional(),
  }),
});
export type ToolError = z.infer<typeof ToolError>;

export class HotseatError extends Error {
  readonly code: ErrorCode;
  readonly candidates: string[] | undefined;

  constructor(code: ErrorCode, message: string, candidates?: string[]) {
    super(message);
    this.name = "HotseatError";
    this.code = code;
    this.candidates = candidates;
  }

  toToolError(): ToolError {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.candidates ? { candidates: this.candidates } : {}),
      },
    };
  }
}
