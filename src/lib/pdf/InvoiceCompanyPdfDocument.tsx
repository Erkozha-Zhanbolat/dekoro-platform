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
import { amountInWordsKzt } from "./amountInWordsKzt";
import type { ResolvedSupplierImages } from "./types";

const styles = StyleSheet.create({
  page: {
    fontFamily: "Roboto",
    fontSize: 9,
    paddingTop: 28,
    paddingBottom: 36,
    paddingHorizontal: 36,
    color: "#000000",
  },
  warning: {
    fontSize: 8,
    lineHeight: 1.35,
    marginBottom: 10,
    textAlign: "justify",
  },
  paymentTitle: {
    fontSize: 9,
    fontWeight: 700,
    textAlign: "center",
    marginBottom: 4,
  },
  paymentBox: {
    borderWidth: 1,
    borderColor: "#000000",
    marginBottom: 12,
  },
  paymentRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#000000",
  },
  paymentRowLast: {
    flexDirection: "row",
  },
  cell: {
    padding: 4,
    borderRightWidth: 1,
    borderRightColor: "#000000",
    justifyContent: "center",
  },
  cellLast: {
    padding: 4,
    justifyContent: "center",
  },
  cellLabel: {
    fontSize: 7,
    color: "#333333",
  },
  cellValue: {
    fontSize: 9,
    fontWeight: 700,
  },
  title: {
    fontSize: 12,
    fontWeight: 700,
    textAlign: "center",
    marginBottom: 10,
    marginTop: 4,
  },
  partyBlock: {
    marginBottom: 6,
  },
  partyLine: {
    fontSize: 9,
    marginBottom: 2,
  },
  partyLabel: {
    fontWeight: 700,
  },
  tableHeader: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#000000",
    backgroundColor: "#f5f5f5",
    marginTop: 8,
  },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#000000",
  },
  th: {
    fontSize: 7,
    fontWeight: 700,
    padding: 3,
    textAlign: "center",
  },
  td: {
    fontSize: 8,
    padding: 3,
  },
  cNo: { width: "5%", borderRightWidth: 0.5, borderRightColor: "#000000" },
  cCode: { width: "14%", borderRightWidth: 0.5, borderRightColor: "#000000" },
  cName: { width: "37%", borderRightWidth: 0.5, borderRightColor: "#000000" },
  cQty: { width: "10%", borderRightWidth: 0.5, borderRightColor: "#000000", textAlign: "right" },
  cUnit: { width: "8%", borderRightWidth: 0.5, borderRightColor: "#000000", textAlign: "center" },
  cPrice: { width: "13%", borderRightWidth: 0.5, borderRightColor: "#000000", textAlign: "right" },
  cSum: { width: "13%", textAlign: "right" },
  totalsWrap: {
    marginTop: 6,
    alignItems: "flex-end",
  },
  totalLine: {
    flexDirection: "row",
    minWidth: 240,
    marginBottom: 2,
  },
  totalLabel: {
    width: 140,
    textAlign: "right",
    paddingRight: 8,
    fontWeight: 700,
  },
  totalValue: {
    width: 100,
    textAlign: "right",
  },
  summary: {
    marginTop: 10,
    fontSize: 9,
    marginBottom: 2,
  },
  summaryStrong: {
    fontWeight: 700,
    marginTop: 4,
  },
  signRow: {
    marginTop: 20,
    flexDirection: "row",
    gap: 24,
  },
  signCol: {
    flex: 1,
  },
  signLabel: {
    fontSize: 9,
    fontWeight: 700,
    marginBottom: 4,
  },
  signLine: {
    marginTop: 28,
    borderBottomWidth: 0.5,
    borderBottomColor: "#000000",
  },
  signatureImage: {
    width: 120,
    height: 48,
    objectFit: "contain",
    marginTop: 6,
  },
  stampImage: {
    width: 90,
    height: 90,
    objectFit: "contain",
    marginTop: 4,
  },
});

type Props = {
  document: OrderDocumentPdfSource;
  images: ResolvedSupplierImages;
};

function formatPlainMoney(value: unknown): string {
  const formatted = formatPdfMoney(value);
  return formatted.replace(/\s*₸\s*$/, "").trim();
}

/** Company (ЮЛ) invoice — layout oriented on DEKORO sample payment order + invoice. */
export function InvoiceCompanyPdfDocument({ document, images }: Props) {
  const meta = document.metadata;
  const supplier = meta.supplier ?? {};
  const buyer = meta.buyer ?? {};
  const totals = meta.totals ?? {};
  const basis = meta.basis ?? {};
  const payment = meta.payment_profile ?? {};
  const items = meta.items ?? [];
  const taxMode = str(totals.tax_mode, "");
  const documentNumber = documentNumberFromMetadata(meta);

  if (!documentNumber) {
    throw new Error("В metadata отсутствует document_number — PDF не сформирован");
  }

  if (!meta.payment_profile) {
    throw new Error(
      "В metadata отсутствует payment_profile — company invoice PDF не сформирован",
    );
  }

  const warning =
    str(meta.warning_text, "") ||
    "Внимание! Оплата данного счёта означает согласие с условиями поставки товара.";

  const contractLabel = str(basis.contract_label, "Без договора");
  const itemCount = Number(totals.item_count ?? totals.items_count ?? items.length);
  const finalTotal = totals.final_total ?? totals.total;
  const amountWords =
    str(totals.amount_in_words, "") || amountInWordsKzt(finalTotal);

  return (
    <Document
      title={`Счёт ${documentNumber}`}
      author={str(supplier.legal_name, "DEKORO")}
      subject={str(basis.label, "")}
      language="ru"
    >
      <Page size={PDF_PAGE_SIZE} orientation="portrait" style={styles.page}>
        <Text style={styles.warning}>{warning}</Text>

        <Text style={styles.paymentTitle}>Образец платёжного поручения</Text>
        <View style={styles.paymentBox}>
          <View style={styles.paymentRow}>
            <View style={[styles.cell, { width: "62%" }]}>
              <Text style={styles.cellLabel}>Бенефициар:</Text>
              <Text style={styles.cellValue}>{str(payment.beneficiary_name)}</Text>
            </View>
            <View style={[styles.cellLast, { width: "38%" }]}>
              <Text style={styles.cellLabel}>ИИН/БИН:</Text>
              <Text style={styles.cellValue}>{str(payment.bin_iin)}</Text>
            </View>
          </View>
          <View style={styles.paymentRow}>
            <View style={[styles.cell, { width: "62%" }]}>
              <Text style={styles.cellLabel}>Банк бенефициара:</Text>
              <Text style={styles.cellValue}>{str(payment.bank_name)}</Text>
            </View>
            <View style={[styles.cellLast, { width: "38%" }]}>
              <Text style={styles.cellLabel}>ИИК:</Text>
              <Text style={styles.cellValue}>{str(payment.bank_iik)}</Text>
            </View>
          </View>
          <View style={styles.paymentRowLast}>
            <View style={[styles.cell, { width: "20%" }]}>
              <Text style={styles.cellLabel}>КБе</Text>
              <Text style={styles.cellValue}>{str(payment.bank_kbe)}</Text>
            </View>
            <View style={[styles.cell, { width: "45%" }]}>
              <Text style={styles.cellLabel}>БИК</Text>
              <Text style={styles.cellValue}>{str(payment.bank_bik)}</Text>
            </View>
            <View style={[styles.cellLast, { width: "35%" }]}>
              <Text style={styles.cellLabel}>Код назначения платежа</Text>
              <Text style={styles.cellValue}>
                {str(payment.payment_purpose_code, "")}
              </Text>
            </View>
          </View>
        </View>

        <Text style={styles.title}>
          Счёт на оплату № {documentNumber} от {formatPdfDate(meta.generated_at)}
        </Text>

        <View style={styles.partyBlock}>
          <Text style={styles.partyLine}>
            <Text style={styles.partyLabel}>Поставщик: </Text>
            БИН/ИИН {str(supplier.bin)}, {str(supplier.legal_name)},{" "}
            {str(supplier.address)}
          </Text>
          <Text style={styles.partyLine}>
            <Text style={styles.partyLabel}>Покупатель: </Text>
            БИН/ИИН {str(buyer.bin ?? buyer.iin_bin)},{" "}
            {str(buyer.legal_name ?? buyer.display_name)}, {str(buyer.address)}
          </Text>
          <Text style={styles.partyLine}>
            <Text style={styles.partyLabel}>Договор: </Text>
            {contractLabel}
          </Text>
        </View>

        <View style={styles.tableHeader} wrap={false}>
          <Text style={[styles.th, styles.cNo]}>№</Text>
          <Text style={[styles.th, styles.cCode]}>Код</Text>
          <Text style={[styles.th, styles.cName]}>Наименование</Text>
          <Text style={[styles.th, styles.cQty]}>Кол-во</Text>
          <Text style={[styles.th, styles.cUnit]}>Ед.</Text>
          <Text style={[styles.th, styles.cPrice]}>Цена</Text>
          <Text style={[styles.th, styles.cSum]}>Сумма</Text>
        </View>
        {items.map((item) => (
          <View key={item.order_item_id} style={styles.tableRow} wrap={false}>
            <Text style={[styles.td, styles.cNo, { textAlign: "center" }]}>
              {item.line_no}
            </Text>
            <Text style={[styles.td, styles.cCode]}>{str(item.product_sku, "")}</Text>
            <Text style={[styles.td, styles.cName]}>{item.product_name}</Text>
            <Text style={[styles.td, styles.cQty]}>{formatPdfQty(item.quantity)}</Text>
            <Text style={[styles.td, styles.cUnit]}>{item.unit}</Text>
            <Text style={[styles.td, styles.cPrice]}>
              {formatPlainMoney(item.unit_price)}
            </Text>
            <Text style={[styles.td, styles.cSum]}>
              {formatPlainMoney(item.line_total)}
            </Text>
          </View>
        ))}

        <View style={styles.totalsWrap} wrap={false}>
          {taxMode === "without_vat" ? (
            <View style={styles.totalLine}>
              <Text style={styles.totalLabel}>Итого:</Text>
              <Text style={styles.totalValue}>{formatPlainMoney(finalTotal)}</Text>
            </View>
          ) : (
            <>
              <View style={styles.totalLine}>
                <Text style={styles.totalLabel}>Стоимость:</Text>
                <Text style={styles.totalValue}>
                  {formatPlainMoney(totals.subtotal ?? totals.amount_without_vat)}
                </Text>
              </View>
              <View style={styles.totalLine}>
                <Text style={styles.totalLabel}>НДС:</Text>
                <Text style={styles.totalValue}>
                  {formatPlainMoney(totals.vat_amount)}
                </Text>
              </View>
              <View style={styles.totalLine}>
                <Text style={styles.totalLabel}>Итого:</Text>
                <Text style={styles.totalValue}>{formatPlainMoney(finalTotal)}</Text>
              </View>
            </>
          )}
        </View>

        <Text style={styles.summary}>
          Всего наименований {Number.isFinite(itemCount) ? itemCount : items.length},
          на сумму {formatPlainMoney(finalTotal)} тенге
        </Text>
        <Text style={[styles.summary, styles.summaryStrong]}>
          Всего к оплате: {amountWords || formatPdfMoney(finalTotal)}
        </Text>

        <View style={styles.signRow} wrap={false}>
          <View style={styles.signCol}>
            <Text style={styles.signLabel}>Исполнитель</Text>
            {images.signatureUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
              <Image src={images.signatureUrl} style={styles.signatureImage} />
            ) : (
              <View style={styles.signLine} />
            )}
          </View>
          <View style={styles.signCol}>
            <Text style={styles.signLabel}>Бухгалтер</Text>
            <View style={styles.signLine} />
          </View>
          <View style={[styles.signCol, { alignItems: "center" }]}>
            {images.stampUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
              <Image src={images.stampUrl} style={styles.stampImage} />
            ) : null}
          </View>
        </View>
      </Page>
    </Document>
  );
}
