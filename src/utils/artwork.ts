import { Buffer } from "node:buffer";
import { parseFile } from "music-metadata";

export async function extractEmbeddedArtwork(
  filePath: string,
): Promise<string | null> {
  try {
    const metadata = await parseFile(filePath, { duration: false });
    const picture = metadata.common.picture?.[0];

    if (!picture || !picture.data || picture.data.length < 2000) {
      return null;
    }

    const format = picture.format || "image/jpeg";

    return `data:${format};base64,${Buffer.from(picture.data).toString("base64")}`;
  } catch (err) {
    console.warn("extractEmbeddedArtwork failed:", (err as Error).message);
    return null;
  }
}
