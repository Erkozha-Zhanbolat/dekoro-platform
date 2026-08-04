import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { StaffOrderDocumentDetails } from "@/types/database";
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
    fontSize: 8,
    paddingTop: 28,
    paddingBottom: 32,
    paddingHorizontal: 28,
    color: "#000",
  },
  formCode: {
    fontSize: 7,
    textAlign: "right",
    marginBottom: 6,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 6,
  },
  logo: {
    width: 48,
    height: 48,
    objectFit: "contain",
  },
  orgBlock: {
    flex: 1,
  },
  orgName: {
    fontSize: 10,
    fontWeight: 700,
    textAlign: "center",
    marginBottom: 2,
  },
  orgLine: {
    fontSize: 7,
    textAlign: "center",
    marginBottom: 1,
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    textAlign: "center",
    marginTop: 10,
    marginBottom: 2,
  },
  docMeta: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 24,
    marginBottom: 10,
    fontSize: 8,
  },
  box: {
    borderWidth: 1,
    borderColor: "#000",
    padding: 6,
    marginBottom: 8,
  },
  boxRow: {
    flexDirection: "row",
    marginBottom: 3,
  },
  label: {
    width: 90,
    fontSize: 7,
  },
  value: {
    flex: 1,
    fontSize: 8,
    fontWeight: 700,
  },
  twoCol: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 8,
  },
  half: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#000",
    padding: 6,
  },
  halfTitle: {
    fontSize: 7,
    fontWeight: 700,
    marginBottom: 4,
    textTransform: "uppercase",
  },
  tableHeader: {
    flexDirection: "row",
    borderWidth: 1,
    borderColor: "#000",
    backgroundColor: "#f5f5f5",
  },
  tableRow: {
    flexDirection: "row",
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: "#000",
  },
  th: {
    fontWeight: 700,
    fontSize: 6,
    padding: 3,
    borderRightWidth: 1,
    borderRightColor: "#000",
    textAlign: "center",
  },
  td: {
    fontSize: 7,
    padding: 3,
    borderRightWidth: 1,
    borderRightColor: "#000",
  },
  tdRight: {
    textAlign: "right",
  },
  tdCenter: {
    textAlign: "center",
  },
  cNo: { width: "5%" },
  cName: { width: "33%" },
  cUnit: { width: "8%" },
  cQty: { width: "10%" },
  cPrice: { width: "12%" },
  cSum: { width: "14%" },
  cNote: { width: "18%", borderRightWidth: 0 },
  productName: {
    width: "100%",
  },
  totalsBox: {
    marginTop: 6,
    alignItems: "flex-end",
  },
  totalRow: {
    flexDirection: "row",
    width: 260,
    marginBottom: 2,
  },
  totalLabel: {
    width: 140,
    textAlign: "right",
    paddingRight: 8,
    fontSize: 8,
  },
  totalValue: {
    width: 120,
    textAlign: "right",
    fontSize: 8,
    fontWeight: 700,
  },
  signBlock: {
    marginTop: 16,
    flexDirection: "row",
    gap: 12,
  },
  signCol: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#000",
    padding: 6,
    minHeight: 90,
  },
  signTitle: {
    fontSize: 7,
    fontWeight: 700,
    marginBottom: 8,
  },
  signLine: {
    fontSize: 7,
    marginTop: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: "#000",
    paddingBottom: 2,
  },
  signatureImage: {
    width: 110,
    height: 40,
    objectFit: "contain",
    marginTop: 6,
  },
  stampImage: {
    width: 72,
    height: 72,
    objectFit: "contain",
    marginTop: 6,
  },
  stampPlaceholder: {
    marginTop: 8,
    width: 72,
    height: 72,
    borderWidth: 0.5,
    borderColor: "#999",
    borderStyle: "dashed",
  },
  footerNote: {
    marginTop: 10,
    fontSize: 6,
    color: "#404040",
  },
});

type Props = {
  document: StaffOrderDocumentDetails;
  images: ResolvedSupplierImages;
};

export function DeliveryNotePdfDocument({ document, images }: Props) {
  const meta = document.metadata;
  const supplier = meta.supplier ?? {};
  const buyer = meta.buyer ?? {};
  const totals = meta.totals ?? {};
  const basis = meta.basis ?? {};
  const form32 = meta.form_3_2 ?? {};
  const items = meta.items ?? [];
  const taxMode = str(totals.tax_mode, "");
  const taxLabel = str(totals.tax_label, "");
  const documentNumber = documentNumberFromMetadata(meta);
  const warehouse = [str(supplier.warehouse_name, ""), str(supplier.warehouse_code, "")]
    .filter((v) => v !== "—")
    .join(" / ");

  if (!documentNumber) {
    throw new Error("В metadata отсутствует document_number — PDF не сформирован");
  }

  return (
    <Document
      title={`Накладная ${documentNumber}`}
      author={str(supplier.legal_name, "DEKORO")}
      subject={str(basis.label, "Форма 3-2")}
      language="ru"
    >
      <Page size={PDF_PAGE_SIZE} orientation="portrait" style={styles.page}>
        <Text style={styles.formCode}>Форма 3-2</Text>
        <View style={styles.headerRow}>
          {images.logoUrl ? (
            // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
            <Image src={images.logoUrl} style={styles.logo} />
          ) : null}
          <View style={styles.orgBlock}>
            <Text style={styles.orgName}>{str(supplier.legal_name)}</Text>
            <Text style={styles.orgLine}>БИН {str(supplier.bin)}</Text>
            <Text style={styles.orgLine}>{str(supplier.address)}</Text>
            <Text style={styles.orgLine}>тел. {str(supplier.phone)}</Text>
            {warehouse ? <Text style={styles.orgLine}>Склад: {warehouse}</Text> : null}
            {supplier.warehouse_address ? (
              <Text style={styles.orgLine}>{str(supplier.warehouse_address)}</Text>
            ) : null}
          </View>
        </View>

        <Text style={styles.title}>НАКЛАДНАЯ НА ОТПУСК ЗАПАСОВ</Text>
        <View style={styles.docMeta}>
          <Text>№ {documentNumber}</Text>
          <Text>от {formatPdfDate(meta.generated_at)}</Text>
        </View>

        <View style={styles.twoCol} wrap={false}>
          <View style={styles.half}>
            <Text style={styles.halfTitle}>Отправитель (организация)</Text>
            <Text>{str(supplier.legal_name)}</Text>
            <Text>БИН {str(supplier.bin)}</Text>
            <Text>{str(supplier.address)}</Text>
            <Text>Директор: {str(supplier.director_name)}</Text>
          </View>
          <View style={styles.half}>
            <Text style={styles.halfTitle}>Получатель</Text>
            <Text>{str(buyer.legal_name ?? buyer.display_name)}</Text>
            <Text>ИИН/БИН {str(buyer.iin_bin)}</Text>
            <Text>{str(buyer.address)}</Text>
            <Text>Контакт: {str(buyer.contact_person)}</Text>
            <Text>тел. {str(buyer.phone)}</Text>
          </View>
        </View>

        <View style={styles.box} wrap={false}>
          <View style={styles.boxRow}>
            <Text style={styles.label}>Основание</Text>
            <Text style={styles.value}>{str(basis.label)}</Text>
          </View>
          <View style={styles.boxRow}>
            <Text style={styles.label}>Дата заказа</Text>
            <Text style={styles.value}>{formatPdfDate(basis.order_date)}</Text>
          </View>
          <View style={styles.boxRow}>
            <Text style={styles.label}>Доверенность</Text>
            <Text style={styles.value}>{str(form32.power_of_attorney)}</Text>
          </View>
          <View style={styles.boxRow}>
            <Text style={styles.label}>Транспорт</Text>
            <Text style={styles.value}>{str(form32.transport)}</Text>
          </View>
        </View>

        <View style={styles.tableHeader} wrap={false}>
          <Text style={[styles.th, styles.cNo]}>№</Text>
          <Text style={[styles.th, styles.cName]}>Наименование</Text>
          <Text style={[styles.th, styles.cUnit]}>Ед.</Text>
          <Text style={[styles.th, styles.cQty]}>Кол-во</Text>
          <Text style={[styles.th, styles.cPrice]}>Цена</Text>
          <Text style={[styles.th, styles.cSum]}>Сумма</Text>
          <Text style={[styles.th, styles.cNote]}>Примечание</Text>
        </View>
        {items.map((item) => (
          <View key={item.order_item_id} style={styles.tableRow} wrap={false}>
            <Text style={[styles.td, styles.tdCenter, styles.cNo]}>{item.line_no}</Text>
            <View style={[styles.td, styles.cName]}>
              <Text style={styles.productName}>{item.product_name}</Text>
              {item.product_sku ? <Text>{item.product_sku}</Text> : null}
            </View>
            <Text style={[styles.td, styles.tdCenter, styles.cUnit]}>{item.unit}</Text>
            <Text style={[styles.td, styles.tdRight, styles.cQty]}>
              {formatPdfQty(item.quantity)}
            </Text>
            <Text style={[styles.td, styles.tdRight, styles.cPrice]}>
              {formatPdfMoney(item.unit_price)}
            </Text>
            <Text style={[styles.td, styles.tdRight, styles.cSum]}>
              {formatPdfMoney(item.line_total)}
            </Text>
            <Text style={[styles.td, styles.cNote]} />
          </View>
        ))}

        <View style={styles.totalsBox} wrap={false}>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Подытог</Text>
            <Text style={styles.totalValue}>{formatPdfMoney(totals.subtotal)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Скидка</Text>
            <Text style={styles.totalValue}>{formatPdfMoney(totals.discount)}</Text>
          </View>
          {taxMode === "without_vat" ? (
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{taxLabel || "Без НДС"}</Text>
              <Text style={styles.totalValue}>{formatPdfMoney(0)}</Text>
            </View>
          ) : (
            <>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Сумма без НДС</Text>
                <Text style={styles.totalValue}>
                  {formatPdfMoney(totals.amount_without_vat)}
                </Text>
              </View>
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>
                  НДС{totals.vat_rate != null ? ` ${str(totals.vat_rate)}%` : ""}
                </Text>
                <Text style={styles.totalValue}>{formatPdfMoney(totals.vat_amount)}</Text>
              </View>
            </>
          )}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Всего по накладной</Text>
            <Text style={styles.totalValue}>{formatPdfMoney(totals.total)}</Text>
          </View>
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Позиций / кол-во</Text>
            <Text style={styles.totalValue}>
              {str(totals.items_count)} / {formatPdfQty(totals.total_quantity)}
            </Text>
          </View>
        </View>

        <View style={styles.signBlock} wrap={false}>
          <View style={styles.signCol}>
            <Text style={styles.signTitle}>Отпустил</Text>
            <Text style={styles.signLine}>
              Должность: {str(form32.released_by_position)}
            </Text>
            <Text style={styles.signLine}>
              ФИО: {str(form32.released_by_name) !== "—"
                ? str(form32.released_by_name)
                : str(supplier.director_name)}
            </Text>
            {images.signatureUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
              <Image src={images.signatureUrl} style={styles.signatureImage} />
            ) : (
              <Text style={styles.signLine}>Подпись / дата</Text>
            )}
          </View>
          <View style={styles.signCol}>
            <Text style={styles.signTitle}>Получил / М.П.</Text>
            <Text style={styles.signLine}>
              Должность: {str(form32.received_by_position)}
            </Text>
            <Text style={styles.signLine}>ФИО: {str(form32.received_by_name)}</Text>
            <Text style={styles.signLine}>Подпись / дата</Text>
            {images.stampUrl ? (
              // eslint-disable-next-line jsx-a11y/alt-text -- @react-pdf/renderer Image
              <Image src={images.stampUrl} style={styles.stampImage} />
            ) : (
              <View style={styles.stampPlaceholder} />
            )}
          </View>
        </View>

        <Text style={styles.footerNote}>
          Документ сформирован из неизменяемого снимка metadata. Данные заказа и клиента
          не подтягиваются повторно.{" "}
          {form32.notes ? `Примечание: ${str(form32.notes)}` : ""}
        </Text>
      </Page>
    </Document>
  );
}
