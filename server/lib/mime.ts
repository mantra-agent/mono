export const MIME_MAP: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".json": "application/json", ".xml": "application/xml",
  ".yaml": "text/yaml", ".yml": "text/yaml",
  ".html": "text/html", ".css": "text/css",
  ".js": "application/javascript", ".ts": "application/typescript",
  ".py": "text/x-python", ".sh": "text/x-sh",
  ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".zip": "application/zip", ".gz": "application/gzip",
  ".log": "text/plain", ".toml": "text/plain",
  ".ini": "text/plain", ".cfg": "text/plain",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const TEXT_ARTIFACT_MIME_MAP: Record<string, string> = {
  ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json",
  ".yaml": "text/yaml", ".yml": "text/yaml", ".xml": "application/xml",
  ".csv": "text/csv", ".html": "text/html", ".css": "text/css",
  ".js": "application/javascript", ".ts": "application/typescript",
  ".py": "text/x-python", ".sh": "text/x-shellscript", ".log": "text/plain",
  ".toml": "text/plain", ".ini": "text/plain", ".cfg": "text/plain",
};
