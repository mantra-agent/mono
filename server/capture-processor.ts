import { eventBus } from "./event-bus";
import { db } from "./db";
import { captures } from "@shared/schema";
import { eq } from "drizzle-orm";
import { classifyCapture } from "./capture-classifier";
import { routeCapture } from "./capture-router";
import { createLogger } from "./log";

const log = createLogger("CaptureProcessor");

export function initCaptureProcessor() {
  eventBus.on("event", async (busEvent) => {
    if (busEvent.event !== "capture.created") return;

    const captureId = busEvent.payload.captureId as string;
    const overrideType = busEvent.payload.overrideType as string | undefined;

    try {
      const [capture] = await db.select().from(captures).where(eq(captures.id, captureId));
      if (!capture || (capture.status !== "pending")) return;

      await db.update(captures).set({ status: "processing" }).where(eq(captures.id, captureId));

      let classification;
      if (overrideType) {
        classification = {
          type: overrideType as any,
          confidence: 1.0,
          person: null,
          timeRef: null,
          summary: capture.rawText,
        };
      } else {
        classification = await classifyCapture(capture.rawText, capture.typeHint);
      }

      if (classification.confidence < 0.5) {
        await db.update(captures).set({
          status: "manual",
          classifiedType: classification.type,
          classificationConfidence: classification.confidence,
          processedAt: new Date(),
        }).where(eq(captures.id, captureId));
        log.log(`Capture ${captureId} → manual (confidence ${classification.confidence})`);
        return;
      }

      const routeResult = await routeCapture(classification, capture.rawText);

      const newStatus = routeResult.success
        ? (classification.confidence >= 0.7 ? "routed" : "routed")
        : "failed";

      await db.update(captures).set({
        status: routeResult.success ? "routed" : "failed",
        classifiedType: classification.type,
        classificationConfidence: classification.confidence,
        routedTo: routeResult.system,
        routedRef: routeResult.ref,
        errorMessage: routeResult.error || null,
        processedAt: new Date(),
      }).where(eq(captures.id, captureId));

      log.log(`Capture ${captureId} → ${classification.type} → ${routeResult.system} (${routeResult.success ? "success" : "failed"})`);
    } catch (err: any) {
      log.error(`Capture processing failed for ${captureId}: ${err.message}`);
      try {
        await db.update(captures).set({
          status: "failed",
          errorMessage: err.message,
          processedAt: new Date(),
        }).where(eq(captures.id, captureId));
      } catch (updateErr: any) {
        log.error(`Failed to update capture ${captureId} status: ${updateErr.message}`);
      }
    }
  });

  log.log("Capture processor initialized, listening for capture.created events");
}
