import { Text, View } from "@react-pdf/renderer";
import type { OrderDocumentMetadataItem } from "@/types/database";
import { formatPdfInvoiceQty, formatPdfMoneyPlain, str } from "../format";
import { invoiceStyles as styles } from "./styles";

export function InvoiceItemsTableHeader() {
  return (
    <View style={styles.tableHeader} wrap={false}>
      <Text style={[styles.th, styles.cNo]}>№</Text>
      <Text style={[styles.th, styles.cSku]}>Артикул</Text>
      <Text style={[styles.th, styles.cName]}>Наименование</Text>
      <Text style={[styles.th, styles.cQty]}>Кол-во</Text>
      <Text style={[styles.th, styles.cUnit]}>Ед.</Text>
      <Text style={[styles.th, styles.cPrice]}>Цена</Text>
      <Text style={[styles.thLast, styles.cSum]}>Сумма</Text>
    </View>
  );
}

function InvoiceItemRow({ item }: { item: OrderDocumentMetadataItem }) {
  return (
    <View style={styles.tableRow} wrap={false}>
      <Text style={[styles.td, styles.cNo]}>{item.line_no}</Text>
      <Text style={[styles.td, styles.cSku]}>{str(item.product_sku, "")}</Text>
      <Text style={[styles.td, styles.cName]}>{item.product_name}</Text>
      <Text style={[styles.td, styles.cQty]}>
        {formatPdfInvoiceQty(item.quantity)}
      </Text>
      <Text style={[styles.td, styles.cUnit]}>{item.unit}</Text>
      <Text style={[styles.td, styles.cPrice]}>
        {formatPdfMoneyPlain(item.unit_price)}
      </Text>
      <Text style={[styles.tdLast, styles.cSum]}>
        {formatPdfMoneyPlain(item.line_total)}
      </Text>
    </View>
  );
}

type Props = {
  items: OrderDocumentMetadataItem[];
};

export function InvoiceItemsTable({ items }: Props) {
  return (
    <View>
      <InvoiceItemsTableHeader />
      {items.map((item) => (
        <InvoiceItemRow
          key={item.order_item_id || `${item.line_no}-${item.product_id}`}
          item={item}
        />
      ))}
    </View>
  );
}
