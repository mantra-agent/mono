import type { Express } from "express";
import { requireAuth } from "./auth";
import { companyStorage } from "./company-storage";
import { createLogger } from "./log";

const log = createLogger("CompanyRoutes");

export function registerCompanyRoutes(app: Express): void {
  app.use("/api/companies", requireAuth);

  app.get("/api/companies", async (req, res) => {
    try {
      res.json({ companies: await companyStorage.list(String(req.query.q || "")) });
    } catch (error) {
      log.error("list companies failed", error);
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/companies", async (req, res) => {
    try {
      res.json(await companyStorage.create(req.body));
    } catch (error) {
      log.error("create company failed", error);
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/companies/:id", async (req, res) => {
    const company = await companyStorage.get(req.params.id);
    if (!company) return res.status(404).json({ error: "Company not found" });
    res.json({ ...company, people: await companyStorage.listPeople(company.id) });
  });

  app.patch("/api/companies/:id", async (req, res) => {
    try {
      res.json(await companyStorage.update(req.params.id, req.body));
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/companies/:id", async (req, res) => {
    try {
      await companyStorage.delete(req.params.id);
      res.json({ deleted: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/companies/:id/people/:personId", async (req, res) => {
    try {
      await companyStorage.addPerson(req.params.id, req.params.personId);
      res.json({ linked: true });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/companies/:id/people/:personId", async (req, res) => {
    try {
      await companyStorage.removePerson(req.params.id, req.params.personId);
      res.json({ linked: false });
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
