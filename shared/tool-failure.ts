/**
 * Shared tool-failure kind discriminant.
 * Server owns full ToolFailure; client only needs the kind for presentation.
 */
export type ToolFailureKind = "input" | "permission" | "transient" | "internal";
