import { Redirect } from "wouter";

/**
 * Compatibility component for stale imports and bookmarks.
 * Library2 is retired; standard Library remains the only active surface.
 */
export default function Library2Page() {
  return <Redirect to="/library" />;
}
