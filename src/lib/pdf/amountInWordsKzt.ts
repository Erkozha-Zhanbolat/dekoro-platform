/**
 * Deterministic KZT amount-in-words from a numeric snapshot (final_total).
 * Used by PDF/preview from immutable metadata — never live data.
 *
 * Limits: 0 .. 999_999_999_999.99 (up to billions triad).
 * Negative → throws. Null/NaN → throws.
 */

const HUNDREDS = [
  "",
  "сто",
  "двести",
  "триста",
  "четыреста",
  "пятьсот",
  "шестьсот",
  "семьсот",
  "восемьсот",
  "девятьсот",
];

const TENS = [
  "",
  "",
  "двадцать",
  "тридцать",
  "сорок",
  "пятьдесят",
  "шестьдесят",
  "семьдесят",
  "восемьдесят",
  "девяносто",
];

const ONES_M = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];

const TEENS = [
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
];

/** 1=one, 2=few, 3=many */
type PluralForm = 1 | 2 | 3;

const SCALE: { feminine: boolean; forms: [string, string, string] }[] = [
  { feminine: false, forms: ["тенге", "тенге", "тенге"] },
  { feminine: true, forms: ["тысяча", "тысячи", "тысяч"] },
  { feminine: false, forms: ["миллион", "миллиона", "миллионов"] },
  { feminine: false, forms: ["миллиард", "миллиарда", "миллиардов"] },
];

const MAX_INT = 999_999_999_999;

function pluralForm(n: number): PluralForm {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 3;
  const mod10 = n % 10;
  if (mod10 === 1) return 1;
  if (mod10 >= 2 && mod10 <= 4) return 2;
  return 3;
}

function triadWords(triad: number, feminine: boolean): { text: string; form: PluralForm } {
  if (triad <= 0) return { text: "", form: 3 };

  const hundreds = Math.floor(triad / 100);
  const tenOnes = triad % 100;
  const tens = Math.floor(tenOnes / 10);
  const ones = tenOnes % 10;
  const onesWords = feminine ? ONES_F : ONES_M;
  const parts: string[] = [];

  if (hundreds > 0) parts.push(HUNDREDS[hundreds]!);

  if (tenOnes >= 10 && tenOnes <= 19) {
    parts.push(TEENS[tenOnes - 10]!);
    return { text: parts.join(" "), form: 3 };
  }

  if (tens >= 2) parts.push(TENS[tens]!);
  if (ones > 0) parts.push(onesWords[ones]!);

  return { text: parts.join(" "), form: pluralForm(tenOnes) };
}

export function amountInWordsKzt(value: unknown): string {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error("Сумма для прописи некорректна");
  }
  if (n < 0) {
    throw new Error("Сумма для прописи не может быть отрицательной");
  }

  const rounded = Math.round(n * 100) / 100;
  const intPart = Math.trunc(rounded);
  const tiyn = Math.round((rounded - intPart) * 100);

  if (intPart > MAX_INT) {
    throw new Error("Сумма слишком велика для прописи (макс. 999 999 999 999,99)");
  }

  let result: string;
  if (intPart === 0) {
    result = "Ноль тенге";
  } else {
    let rest = intPart;
    const chunks: string[] = [];
    let scaleIdx = 0;

    while (rest > 0) {
      const triad = rest % 1000;
      rest = Math.floor(rest / 1000);

      if (triad > 0) {
        const scale = SCALE[scaleIdx];
        if (!scale) {
          throw new Error("Сумма слишком велика для прописи");
        }
        const { text, form } = triadWords(triad, scale.feminine);
        chunks.unshift(`${text} ${scale.forms[form - 1]}`.trim());
      }

      scaleIdx += 1;
      if (scaleIdx > 3 && rest > 0) {
        throw new Error("Сумма слишком велика для прописи");
      }
    }

    result = chunks.join(" ");
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  return `${result} ${String(tiyn).padStart(2, "0")} тиын`;
}
