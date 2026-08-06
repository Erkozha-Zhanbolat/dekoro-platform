import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { OrderDocumentPdfSource } from "@/types/database";
import {
  PDF_PAGE_SIZE,
  documentNumberFromMetadata,
  formatPdfDate,
  formatPdfMoney,
  formatPdfQty,
  str,
} from "./format";
import type { ResolvedSupplierImages } from "./types";

const styles = StyleSheet.create({
  page: {
    fontFamily: "Roboto",
    fontSize: 9,
    paddingTop: 36,
    paddingBottom: 40,
    paddingHorizontal: 40,
    color: "#171717",
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginBottom: 12,
  },
  logo: {
    width: 64,
    height: 64,
    objectFit: "contain",
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 9,
    color: "#525252",
    marginBottom: 16,
  },
  section: {
    marginBottom: 14,
  },
  sectionTitle: {
    fontSize: 8,
    fontWeight: 700,
    textTransform: "uppercase",
    color: "#737373",
    marginBottom: 4,
    letterSpacing: 0.4,
  },
  line: {
    marginBottom: 2,
  },
  row: {
    flexDirection: "row",
    gap: 16,
  },
  col: {
    flex: 1,
  },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#171717",
    paddingBottom: 4,
    marginTop: 8,
    marginBottom: 2,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#e5e5e5",
    paddingVertical: 4,
  },
  th: { fontWeight: 700, fontSize: 8 },
  cellNo: { width: "6%" },
  cellName: { width: "40%" },
  cellUnit: { width: "10%" },
  cellQty: { width: "12%", textAlign: "right" },
  cellPrice: { width: "16%", textAlign: "right" },
  cellSum: { width: "16%", textAlign: "right" },
  productName: {
    width: "100%",
  },
  totals: {
    marginTop: 12,
    alignItems: "flex-end",
  },
  totalLine: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginBottom: 2,
    minWidth: 220,
  },
  totalLabel: {
    width: 120,
    textAlign: "right",
    color: "#525252",
    paddingRight: 8,
  },
  totalValue: {
    width: 110,
    textAlign: "right",
  },
  totalStrong: {
    fontWeight: 700,
    fontSize: 11,
    marginTop: 4,
  },
  bank: {
    marginTop: 20,
    paddingTop: 10,
    borderTopWidth: 0.5,
    borderTopColor: "#d4d4d4",
  },
  muted: {
    color: "#737373",
    fontSize: 8,
  },
  signRow: {
    marginTop: 16,
    flexDirection: "row",
    gap: 24,
  },
  signCol: {
    flex: 1,
  },
  signatureImage: {
    width: 120,
    height: 48,
    objectFit: "contain",
    marginTop: 6,
    marginBottom: 4,
  },
  stampImage: {
    width: 90,
    height: 90,
    objectFit: "contain",
    marginTop: 6,
  },
  signLine: {
    marginTop: 28,
    borderBottomWidth: 0.5,
    borderBottomColor: "#171717",
  },
  stampPlaceholder: {
    marginTop: 8,
    width: 90,
    height: 90,
    borderWidth: 0.5,
    borderColor: "#d4d4d4",
    borderStyle: "dashed",
  },
});

type Props = {
  document: OrderDocumentPdfSource;
  images: ResolvedSupplierImages;
};

/** Individual (ФЛ) invoice — data only from order_documents.metadata. */
export function InvoiceIndividualPdfDocument({ document, images }: Props) {
  const meta = document.metadata;
  const supplier = meta.supplier ?? {};
  const buyer = meta.buyer ?? {};
  const totals = meta.totals ?? {};
  const basis = meta.basis ?? {};
  const payment = meta.payment_profile ?? null;
  const items = meta.items ?? [];
  const taxMode = str(totals.tax_mode, "");
  const documentNumber = documentNumberFromMetadata(meta);

  if (!documentNumber) {
    throw new Error("В metadata отсутствует document_number — PDF не сформирован");
  }

  // Prefer payment_profile (018); legacy invoices fall back to supplier bank snapshot.
  const bankName = str(payment ? payment.bank_name : supplier.bank_name);
  const bankBik = str(payment ? payment.bank_bik : supplier.bank_bik);
  const bankIik = str(payment ? payment.bank_iik : supplier.bank_iik);
  const bankKbe = str(payment ? payment.bank_kbe : supplier.bank_kbe);
  const beneficiary = str(payment ? payment.beneficiary_name : supplier.legal_name);
  const beneficiaryId = str(payment ? payment.bin_iin : supplier.bin);

  const buyerName = str(buyer.display_name ?? buyer.legal_name);
  const buyerIin = str(buyer.iin ?? buyer.iin_bin, "");

  return (
    <Document
      title={`Счёт ${documentNumber}`}
      author={str(supplier.legal_name, "DEKORO")}
      subject={str(basis.label, "")}
      language="ru"
    >
      <Page size={PDF_PAGE_SIZE} orientation="portrait" style={styles.page}>
        <View style={styles.headerRow}>
          {images.logoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
            <Image src={images.logoUrl} style={styles.logo} />
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Счёт на оплату {documentNumber}</Text>
            <Text style={styles.subtitle}>
              от {formatPdfDate(meta.generated_at)} · {str(basis.label)}
            </Text>
            {!images.logoUrl ? (
              <Text style={[styles.line, { fontWeight: 700 }]}>
                {str(supplier.legal_name)}
              </Text>
            ) : null}
          </View>
        </View>

        <View style={[styles.section, styles.row]}>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>Поставщик</Text>
            <Text style={styles.line}>{str(supplier.legal_name)}</Text>
            <Text style={styles.line}>БИН {str(supplier.bin)}</Text>
            <Text style={styles.line}>{str(supplier.address)}</Text>
            <Text style={styles.line}>тел. {str(supplier.phone)}</Text>
            {supplier.email ? (
              <Text style={styles.line}>{str(supplier.email)}</Text>
            ) : null}
          </View>
          <View style={styles.col}>
            <Text style={styles.sectionTitle}>Покупатель</Text>
            <Text style={styles.line}>{buyerName}</Text>
            {buyerIin ? <Text style={styles.line}>ИИН {buyerIin}</Text> : null}
            <Text style={styles.line}>{str(buyer.address)}</Text>
            <Text style={styles.line}>тел. {str(buyer.phone)}</Text>
            {buyer.email ? <Text style={styles.line}>{str(buyer.email)}</Text> : null}
          </View>
        </View>

        <View>
          <View style={styles.tableHeader} wrap={false}>
            <Text style={[styles.th, styles.cellNo]}>№</Text>
            <Text style={[styles.th, styles.cellName]}>Товар</Text>
            <Text style={[styles.th, styles.cellUnit]}>Ед.</Text>
            <Text style={[styles.th, styles.cellQty]}>Кол-во</Text>
            <Text style={[styles.th, styles.cellPrice]}>Цена</Text>
            <Text style={[styles.th, styles.cellSum]}>Сумма</Text>
          </View>
          {items.map((item) => (
            <View key={item.order_item_id} style={styles.tableRow} wrap={false}>
              <Text style={styles.cellNo}>{item.line_no}</Text>
              <View style={styles.cellName}>
                <Text style={styles.productName}>{item.product_name}</Text>
                {item.product_sku ? (
                  <Text style={styles.muted}>{item.product_sku}</Text>
                ) : null}
              </View>
              <Text style={styles.cellUnit}>{item.unit}</Text>
              <Text style={styles.cellQty}>{formatPdfQty(item.quantity)}</Text>
              <Text style={styles.cellPrice}>{formatPdfMoney(item.unit_price)}</Text>
              <Text style={styles.cellSum}>{formatPdfMoney(item.line_total)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.totals} wrap={false}>
          {taxMode === "without_vat" ? (
            <View style={[styles.totalLine, styles.totalStrong]}>
              <Text style={styles.totalLabel}>Итого</Text>
              <Text style={styles.totalValue}>
                {formatPdfMoney(totals.final_total ?? totals.total)}
              </Text>
            </View>
          ) : (
            <>
              <View style={styles.totalLine}>
                <Text style={styles.totalLabel}>Стоимость товаров</Text>
                <Text style={styles.totalValue}>
                  {formatPdfMoney(
                    totals.subtotal ?? totals.amount_without_vat,
                  )}
                </Text>
              </View>
              <View style={styles.totalLine}>
                <Text style={styles.totalLabel}>
                  НДС{totals.vat_rate != null ? ` ${str(totals.vat_rate)}%` : ""}
                </Text>
                <Text style={styles.totalValue}>{formatPdfMoney(totals.vat_amount)}</Text>
              </View>
              <View style={[styles.totalLine, styles.totalStrong]}>
                <Text style={styles.totalLabel}>Итого к оплате</Text>
                <Text style={styles.totalValue}>
                  {formatPdfMoney(totals.final_total ?? totals.total)}
                </Text>
              </View>
            </>
          )}
        </View>

        <View style={styles.bank} wrap={false}>
          <Text style={styles.sectionTitle}>Реквизиты для оплаты</Text>
          <Text style={styles.line}>Получатель: {beneficiary}</Text>
          <Text style={styles.line}>ИИН/БИН: {beneficiaryId}</Text>
          <Text style={styles.line}>Банк: {bankName}</Text>
          <Text style={styles.line}>БИК: {bankBik}</Text>
          <Text style={styles.line}>ИИК: {bankIik}</Text>
          <Text style={styles.line}>КБе: {bankKbe}</Text>
          {payment?.payment_purpose_code ? (
            <Text style={styles.line}>КНП: {str(payment.payment_purpose_code)}</Text>
          ) : null}
        </View>

        <View style={styles.signRow} wrap={false}>
          <View style={styles.signCol}>
            <Text style={styles.sectionTitle}>Директор</Text>
            <Text style={styles.line}>{str(supplier.director_name)}</Text>
            {images.signatureUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
              <Image src={images.signatureUrl} style={styles.signatureImage} />
            ) : (
              <View style={styles.signLine} />
            )}
            <Text style={styles.muted}>подпись</Text>
          </View>
          <View style={styles.signCol}>
            <Text style={styles.sectionTitle}>М.П.</Text>
            {images.stampUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
              <Image src={images.stampUrl} style={styles.stampImage} />
            ) : (
              <View style={styles.stampPlaceholder} />
            )}
          </View>
        </View>
      </Page>
    </Document>
  );
}
