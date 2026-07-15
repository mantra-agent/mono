const isRailwayRuntime = Boolean(
  process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_ENVIRONMENT_ID ||
    process.env.RAILWAY_SERVICE_ID,
);

const entrypoint = process.argv[1] || "";
const isSourceEntrypoint = /(?:^|[/\\])server[/\\]index\.ts$/.test(entrypoint);

if (isRailwayRuntime && isSourceEntrypoint) {
  throw new Error(
    "Refusing to start server/index.ts inside a Railway runtime. " +
      "Use the deployed production entrypoint; source development servers would share live infrastructure.",
  );
}
