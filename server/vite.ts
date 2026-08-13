import { type Express, type NextFunction, type Request, type Response } from "express";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import fs from "fs";
import path from "path";
import { nanoid } from "nanoid";

const viteLogger = createLogger();

export async function setupVite(server: Server, app: Express) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server, path: "/vite-hmr" },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  const currentDir = typeof __dirname !== "undefined" ? __dirname : process.cwd();
  const publicDir = path.resolve(currentDir, "public");
  const allowUnauthenticatedWarmPath = (req: Request) => {
    const pathname = req.path || "";
    return pathname.startsWith("/api/")
      || pathname === "/api"
      || pathname === "/favicon.ico"
      || pathname.startsWith("/assets/");
  };
  const hasSession = (req: Request) => Boolean(req.session?.userId || req.session?.servicePrincipal?.actorType === "service");
  const requireWarmStageSession = (req: Request, res: Response, next: NextFunction) => {
    if (allowUnauthenticatedWarmPath(req) || hasSession(req)) return next();
    if (req.path.startsWith("/src/") || req.path.startsWith("/@") || req.path === "/vite-hmr") {
      return res.status(401).end("Authentication required");
    }
    const loginPage = path.resolve(publicDir, "index.html");
    if (fs.existsSync(loginPage)) {
      res.setHeader("Cache-Control", "no-cache");
      return res.sendFile(loginPage);
    }
    return res.status(401).end("Authentication required");
  };
  app.use(requireWarmStageSession);
  app.use(vite.middlewares);

  app.use("/{*path}", async (req, res, next) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "API route not found" });
    }
    if (!hasSession(req)) {
      const loginPage = path.resolve(publicDir, "index.html");
      if (fs.existsSync(loginPage)) {
        res.setHeader("Cache-Control", "no-cache");
        return res.sendFile(loginPage);
      }
      return res.status(401).end("Authentication required");
    }
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}
