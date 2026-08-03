import { Font } from "@react-pdf/renderer";

let registered = false;
let registerPromise: Promise<void> | null = null;

const FONT_PATHS = {
  regular: "/fonts/Roboto-Regular.ttf",
  bold: "/fonts/Roboto-Bold.ttf",
} as const;

async function assertFontFileExists(url: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { method: "GET", cache: "force-cache" });
  } catch {
    throw new Error(
      `Не удалось загрузить шрифт Roboto (${url}). Проверьте сеть и файлы в public/fonts/.`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Файл шрифта Roboto не найден (${url}, HTTP ${response.status}). ` +
        `Положите Roboto-Regular.ttf и Roboto-Bold.ttf в public/fonts/. PDF не сформирован.`,
    );
  }
}

/**
 * Cyrillic-capable fonts for DEKORO PDFs (Helvetica has no Cyrillic).
 * Registers Roboto exactly once per page session.
 * Missing font files → clear Error (does not silently mark as registered).
 */
export async function ensurePdfFontsRegistered(): Promise<void> {
  if (registered) {
    return;
  }

  if (registerPromise) {
    await registerPromise;
    return;
  }

  registerPromise = (async () => {
    if (typeof window === "undefined") {
      throw new Error("PDF со шрифтами Roboto формируется только в браузере");
    }

    const origin = window.location.origin;
    const regularUrl = `${origin}${FONT_PATHS.regular}`;
    const boldUrl = `${origin}${FONT_PATHS.bold}`;

    await assertFontFileExists(regularUrl);
    await assertFontFileExists(boldUrl);

    Font.register({
      family: "Roboto",
      fonts: [
        { src: regularUrl, fontWeight: 400 },
        { src: boldUrl, fontWeight: 700 },
      ],
    });

    // Break very long unbroken product names so they wrap inside table cells.
    Font.registerHyphenationCallback((word) => {
      if (word.length <= 16) {
        return [word];
      }
      const chunks: string[] = [];
      for (let i = 0; i < word.length; i += 12) {
        chunks.push(word.slice(i, i + 12));
      }
      return chunks;
    });

    registered = true;
  })();

  try {
    await registerPromise;
  } catch (error) {
    registerPromise = null;
    registered = false;
    throw error;
  }
}
