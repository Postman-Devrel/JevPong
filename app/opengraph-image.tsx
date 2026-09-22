import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import {
  SOCIAL_IMAGE_ALT,
  SOCIAL_IMAGE_SIZE,
  SocialCard,
} from "@/components/share/SocialCard";

export const alt = SOCIAL_IMAGE_ALT;
export const size = SOCIAL_IMAGE_SIZE;
export const contentType = "image/png";

const fonts = Promise.all([
  readFile(
    path.join(
      process.cwd(),
      "node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-600-normal.woff",
    ),
  ),
  readFile(
    path.join(
      process.cwd(),
      "node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff",
    ),
  ),
  readFile(
    path.join(
      process.cwd(),
      "node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff",
    ),
  ),
]);

export default async function OpenGraphImage() {
  const [spaceGroteskSemibold, spaceGroteskRegular, ibmPlexMonoSemibold] =
    await fonts;

  return new ImageResponse(<SocialCard />, {
    ...size,
    fonts: [
      {
        data: spaceGroteskRegular,
        name: "Space Grotesk",
        style: "normal",
        weight: 400,
      },
      {
        data: spaceGroteskSemibold,
        name: "Space Grotesk",
        style: "normal",
        weight: 600,
      },
      {
        data: ibmPlexMonoSemibold,
        name: "IBM Plex Mono",
        style: "normal",
        weight: 600,
      },
    ],
  });
}
