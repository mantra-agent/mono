export const AGENT_WEBVIEW_USER_AGENT_SUFFIX = 'AgentMobileIOS';

export const AGENT_NATIVE_MARKER_SCRIPT = `
  window.__AGENT_NATIVE_APP__ = { platform: 'ios' };
  true;
`;
