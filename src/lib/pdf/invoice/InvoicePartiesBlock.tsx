import { Text, View } from "@react-pdf/renderer";
import { invoiceStyles as styles } from "./styles";

type Props = {
  supplierLine: string;
  buyerLine: string;
  basisLine: string;
};

export function InvoicePartiesBlock({ supplierLine, buyerLine, basisLine }: Props) {
  return (
    <View style={styles.partiesWrap}>
      <View style={styles.partyRow}>
        <Text style={styles.partyLabel}>Поставщик:</Text>
        <Text style={styles.partyValue}>{supplierLine}</Text>
      </View>
      <View style={styles.partyRow}>
        <Text style={styles.partyLabel}>Покупатель:</Text>
        <Text style={styles.partyValue}>{buyerLine}</Text>
      </View>
      <View style={styles.partyRow}>
        <Text style={styles.partyLabel}>Основание:</Text>
        <Text style={styles.partyValue}>{basisLine}</Text>
      </View>
    </View>
  );
}
