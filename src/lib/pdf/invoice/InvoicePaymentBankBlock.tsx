import { Text, View } from "@react-pdf/renderer";
import { invoiceStyles as styles } from "./styles";
import type { InvoicePaymentView } from "./viewModel";

type Props = {
  payment: InvoicePaymentView;
};

export function InvoicePaymentBankBlock({ payment }: Props) {
  return (
    <View>
      <Text style={styles.paymentTitle}>ОБРАЗЕЦ ПЛАТЕЖНОГО ПОРУЧЕНИЯ</Text>
      <View style={styles.paymentBox}>
        <View style={styles.paymentRow}>
          <View style={[styles.bankCell, { width: "50%" }]}>
            <Text style={styles.bankLabel}>Бенефициар:</Text>
            <Text style={styles.bankValue}>{payment.beneficiaryName}</Text>
            <Text style={styles.bankLabel}>БИН/ИИН: {payment.binIin}</Text>
          </View>
          <View style={[styles.bankCell, { width: "32%" }]}>
            <Text style={styles.bankLabel}>ИИК</Text>
            <Text style={styles.bankValue}>{payment.iban}</Text>
          </View>
          <View style={[styles.bankCellLast, { width: "18%" }]}>
            <Text style={styles.bankLabel}>Кбе</Text>
            <Text style={styles.bankValue}>{payment.kbe}</Text>
          </View>
        </View>
        <View style={styles.paymentRowLast}>
          <View style={[styles.bankCell, { width: "50%" }]}>
            <Text style={styles.bankLabel}>Банк бенефициара:</Text>
            <Text style={styles.bankValue}>{payment.bankName}</Text>
          </View>
          <View style={[styles.bankCell, { width: "32%" }]}>
            <Text style={styles.bankLabel}>БИК</Text>
            <Text style={styles.bankValue}>{payment.bic}</Text>
          </View>
          <View style={[styles.bankCellLast, { width: "18%" }]}>
            <Text style={styles.bankLabel}>Код назначения платежа</Text>
            <Text style={styles.bankValue}>{payment.knp}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}
