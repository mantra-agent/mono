import { inputFailure, type ToolFailureCode } from "../../tool-failure";
import type { ToolHandlerResult } from "../contracts";

/**
 * Contract reject → amber input failure. The single canonical home for the
 * tool-argument rejection helper shared by every extracted handler module and
 * the bridge-tools invocation shell. Routing through inputFailure keeps a
 * rejected tool call on the same discriminant path as shell_policy_denied, so
 * every domain reports argument-contract violations identically. Do not
 * reintroduce per-module copies of this wrapper.
 */
export function contractReject(result: string, code: ToolFailureCode, detail?: string): ToolHandlerResult {
  return { result, error: true, failure: inputFailure(code, detail) };
}
