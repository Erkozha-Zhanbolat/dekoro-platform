import { Text, View } from "@react-pdf/renderer";
import { formatPdfMoneyPlain } from "../format";
import { invoiceStyles as styles } from "./styles";

type Props = {
  taxMode: string;
  vatRateLabel: string;
  vatAmount: unknown;
  finalTotal: unknown;
  itemCount: number;
  amountWords: string;
  totalLine: string;
};

export function InvoiceTotals({
  taxMode,
  vatRateLabel,
  vatAmount,
  finalTotal,
  itemCount,
  amountWords,
  totalLine,
}: Props) {
  const withoutVat = taxMode === "without_vat";
  const vatLabel = vatRateLabel
    ? `В том числе НДС ${vatRateLabel}%:`
    : "В том числе НДС:";

  return (
    <View>
      <View style={styles.totalsWrap}>
        <View style={styles.totalLine}>
          <Text style={styles.totalLabel}>Итого:</Text>
          <Text style={styles.totalValue}>{formatPdfMoneyPlain(finalTotal)}</Text>
        </View>
        {withoutVat ? (
          <View style={styles.totalLine}>
            <Text style={styles.totalLabel}>Без НДС</Text>
            <Text style={styles.totalValue} />
          </View>
        ) : (
          <View style={styles.totalLine}>
            <Text style={styles.totalLabel}>{vatLabel}</Text>
            <Text style={styles.totalValue}>{formatPdfMoneyPlain(vatAmount)}</Text>
          </View>
        )}
        <View style={styles.totalsRule} />
        <View style={styles.totalLine}>
          <Text style={[styles.totalLabel, styles.totalStrong]}>Всего к оплате:</Text>
          <Text style={[styles.totalValue, styles.totalStrong]}>
            {formatPdfMoneyPlain(finalTotal)}
          </Text>
        </View>
      </View>

      <Text style={styles.summary}>
        Всего наименований {itemCount}, на сумму {totalLine} KZT
      </Text>
      <Text style={styles.summaryStrong}>Всего к оплате:</Text>
      <Text style={styles.summaryStrong}>{amountWords}</Text>
    </View>
  );
}
