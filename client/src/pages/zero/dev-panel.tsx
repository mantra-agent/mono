import { useState } from "react";
import type { SurfaceDescriptor } from "@shared/models/glasses";

interface DevPanelProps {
  descriptor: SurfaceDescriptor | null;
  debugDescriptor: SurfaceDescriptor | null;
  onClose: () => void;
}

function CollapsibleSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="glasses-dev-section">
      <p
        className="glasses-dev-section-title"
        onClick={() => setOpen(!open)}
      >
        {open ? "▾" : "▸"} {title}
      </p>
      {open && children}
    </div>
  );
}

export function DevPanel({ descriptor, debugDescriptor, onClose }: DevPanelProps) {
  const reasoning = debugDescriptor?.reasoning;

  return (
    <div className="glasses-dev-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "rgba(255,255,255,0.6)" }}>
          Dev Inspector
        </span>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "rgba(255,255,255,0.4)",
            cursor: "pointer",
            fontSize: 16,
          }}
          type="button"
        >
          ✕
        </button>
      </div>

      <CollapsibleSection title="Cortex Reasoning" defaultOpen={true}>
        {reasoning ? (
          <div>
            <div style={{ marginBottom: 12 }}>
              <span
                style={{
                  display: "inline-block",
                  padding: "2px 8px",
                  borderRadius: 4,
                  fontSize: 11,
                  fontWeight: 600,
                  background:
                    reasoning.decision === "nothing"
                      ? "rgba(255,255,255,0.08)"
                      : "rgba(34,197,94,0.15)",
                  color:
                    reasoning.decision === "nothing"
                      ? "rgba(255,255,255,0.5)"
                      : "#22c55e",
                }}
              >
                {reasoning.decision === "nothing" ? "NOTHING" : "SURFACE"}
              </span>
              <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 11, marginLeft: 8 }}>
                {reasoning.modelUsed}
              </span>
              {reasoning.sessionOwned && (
                <span style={{ color: "#60a5fa", fontSize: 11, marginLeft: 8 }}>
                  session-owned
                </span>
              )}
            </div>
            <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
              {reasoning.reasoning}
            </p>
            {reasoning.contextSnapshot && (
              <details style={{ marginTop: 8 }}>
                <summary style={{ color: "rgba(255,255,255,0.4)", fontSize: 11, cursor: "pointer" }}>
                  Context Snapshot
                </summary>
                <pre className="glasses-dev-pre" style={{ marginTop: 8 }}>
                  {reasoning.contextSnapshot}
                </pre>
              </details>
            )}
            <p style={{ color: "rgba(255,255,255,0.3)", fontSize: 10, marginTop: 8 }}>
              {reasoning.computedAt}
            </p>
          </div>
        ) : (
          <p style={{ color: "rgba(255,255,255,0.3)" }}>
            Enable debug mode to see full reasoning
          </p>
        )}
      </CollapsibleSection>

      <CollapsibleSection title="Surface JSON">
        <pre className="glasses-dev-pre">
          {descriptor ? JSON.stringify(descriptor, null, 2) : "Loading..."}
        </pre>
      </CollapsibleSection>

      <CollapsibleSection title="Component Tree">
        {descriptor?.components && descriptor.components.length > 0 ? (
          descriptor.components.map((c, i) => (
            <div
              key={i}
              style={{
                padding: "6px 8px",
                background: "rgba(255,255,255,0.04)",
                borderRadius: 6,
                marginBottom: 4,
                fontSize: 12,
              }}
            >
              <span style={{ color: "#60a5fa" }}>{c.type}</span>
              <span style={{ color: "rgba(255,255,255,0.3)", marginLeft: 8 }}>
                #{c.id}
              </span>
              {c.focusable && (
                <span
                  style={{
                    color: "#22c55e",
                    marginLeft: 8,
                    fontSize: 10,
                  }}
                >
                  focusable
                </span>
              )}
            </div>
          ))
        ) : (
          <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 12 }}>
            Empty canvas — nothing to surface
          </p>
        )}
      </CollapsibleSection>
    </div>
  );
}
