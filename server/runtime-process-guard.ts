const isRailwayRuntime = Boolean(
  process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_ENVIRONMENT_ID ||
    process.env.RAILWAY_SERVICE_ID,
);

const isLiveRuntime = /(?:^|[._-])(?:live|prod)(?:$|[._-])/i.test(
  `${process.env.RAILWAY_ENVIRONMENT_NAME || ""} ${process.env.RAILWAY_ENVIRONMENT || ""}`,
);

// Warm Stage deliberately boots source via the process wrapper (`tsx server/index.ts`).
// That path is Stage-only: Live names fail closed here and in the wrapper/Vite mount.
const isWarmStageRuntime = process.env.STAGE_WARM_ENABLED === "true" && !isLiveRuntime;

const entrypoint = process.argv[1] || "";
const isSourceEntrypoint = /(?:^|[/\\])server[/\\]index\.ts$/.test(entrypoint);

if (isRailwayRuntime && isSourceEntrypoint && !isWarmStageRuntime) {
  throw new Error(
    "Refusing to start server/index.ts inside a Railway runtime. " +
      "Use the deployed production entrypoint; source development servers would share live infrastructure.",
  );
}
