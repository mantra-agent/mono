// Intention routes — deprecated, returns 410 Gone for all endpoints
import type { Express } from "express";
import { requireAuth } from "../auth";

export async function registerOodaRoutes(app: Express) {
  app.use("/api/intentions", requireAuth);

  // All intention endpoints return 410 Gone with deprecation message
  const deprecationHandler = (_req: any, res: any) => {
    res.status(410).json({
      error: "The intentions system has been deprecated. Use the autonomy skill instead.",
      migration: "Use skills(action: 'runs', name: 'autonomy') to see recent autonomous activity.",
    });
  };

  app.get("/api/intentions", deprecationHandler);
  app.get("/api/intentions/all", deprecationHandler);
  app.get("/api/intentions/:id", deprecationHandler);
  app.post("/api/intentions", deprecationHandler);
  app.post("/api/intentions/run", deprecationHandler);
  app.post("/api/intentions/advance", deprecationHandler);
  app.post("/api/intentions/:id/act", deprecationHandler);
  app.put("/api/intentions/:id", deprecationHandler);
  app.delete("/api/intentions", deprecationHandler);
  app.delete("/api/intentions/:id", deprecationHandler);
  app.post("/api/intentions/:id/complete", deprecationHandler);
  app.post("/api/intentions/:id/fail", deprecationHandler);
  app.post("/api/intentions/:id/not-planned", deprecationHandler);
  app.post("/api/intentions/:id/pending-review", deprecationHandler);
  app.post("/api/intentions/reorder", deprecationHandler);
}
