import { Image, Text, View } from "@react-pdf/renderer";
import type { ResolvedSupplierImages } from "../types";
import { invoiceStyles as styles } from "./styles";

type Props = {
  directorName: string;
  issuedDateLabel: string;
  images: ResolvedSupplierImages;
};

export function InvoiceSignatureBlock({
  directorName,
  issuedDateLabel,
  images,
}: Props) {
  return (
    <View>
      <View style={styles.signRule} />
      <Text style={styles.signLabel}>Руководитель</Text>
      <View style={styles.signRow}>
        <View style={styles.stampSlot}>
          {images.stampUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
            <Image src={images.stampUrl} style={styles.stampImage} />
          ) : null}
        </View>
        <View style={styles.signSlot}>
          {images.signatureUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
            <Image src={images.signatureUrl} style={styles.signatureImage} />
          ) : (
            <View style={styles.signLine} />
          )}
          <Text style={styles.directorName}>
            {directorName ? `/ ${directorName} /` : "/                          /"}
          </Text>
        </View>
        <Text style={styles.issuedDate}>Дата выписки: {issuedDateLabel}</Text>
      </View>
    </View>
  );
}
