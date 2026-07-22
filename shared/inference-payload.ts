export interface InferencePayloadCaptureSummary {
  id: string;
  capturedAt: string;
  provider: string;
  model: string;
  activity: string | null;
  boundary: string;
  sessionId: string | null;
  source: string | null;
  attempt: number;
  requestChars: number;
}

export interface InferencePayloadCapture extends InferencePayloadCaptureSummary {
  request: unknown;
  evidence: {
    authority: string;
    observableBoundary: string;
    excludedSensitiveFields: string[];
    residualLimitation: string | null;
  };
  metadata: Record<string, unknown>;
}

export interface InferencePayloadCaptureListResponse {
  captures: InferencePayloadCaptureSummary[];
  retentionLimit: number;
}
