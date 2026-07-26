const numberFormatter = new Intl.NumberFormat("ru-RU", {
  maximumFractionDigits: 0,
});

export function formatPrice(value: number): string {
  return `${numberFormatter.format(value)} ₸`;
}
