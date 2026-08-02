import type { Request, Response, NextFunction } from "express";
import { hasActiveBuildAccess } from "./build-access";

/** Route-group middleware: client hiding never substitutes for server authority. */
export async function requireActiveBuild(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const principal = req.principal;
  if (!principal || principal.actorType !== "user") {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  try {
    if (!(await hasActiveBuildAccess(principal))) {
      res.status(403).json({ error: "Build Mod is inactive", code: "build_mod_inactive" });
      return;
    }
    next();
  } catch {
    res.status(403).json({ error: "Build Mod is inactive", code: "build_mod_inactive" });
  }
}
