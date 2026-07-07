import { writeFile as fsWriteFile } from "node:fs/promises";
import { Buffer } from "node:buffer";

export interface ImageGenerationOptions {
  size?: string;
  quality?: string;
  background?: string;
  outputFormat?: string;
}

/**
 * Generate an image and return as Buffer.
 * Routes through the ChatGPT subscription Responses API (gpt-image-2).
 */
export async function generateImageBuffer(
  prompt: string,
  options?: ImageGenerationOptions | string
): Promise<Buffer> {
  const { generateImageViaSubscription } = await import("../../model-client");

  // Backward compat: old callers pass size as second string arg
  const opts: ImageGenerationOptions = typeof options === "string"
    ? { size: options }
    : (options ?? {});

  const result = await generateImageViaSubscription(prompt, opts);
  return result.buffer;
}

/**
 * Edit/combine multiple images into a composite.
 * Routes through the ChatGPT subscription Responses API.
 */
export async function editImages(
  imageFiles: string[],
  prompt: string,
  outputPath?: string
): Promise<Buffer> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const imageBuffers = await Promise.all(imageFiles.map(async (file) => {
    const buf = await fs.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const mediaType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
      : ext === ".webp" ? "image/webp"
      : "image/png";
    return { buffer: buf, mediaType };
  }));

  const { editImageViaSubscription } = await import("../../model-client");
  const result = await editImageViaSubscription(imageBuffers, prompt);

  if (outputPath) {
    await fsWriteFile(outputPath, result.buffer);
  }

  return result.buffer;
}
