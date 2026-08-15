import { Document, Page, Text, View } from "@react-pdf/renderer";
import type { OrderDocumentPdfSource } from "@/types/database";
import { PDF_PAGE_SIZE } from "../format";
import type { ResolvedSupplierImages } from "../types";
import { InvoiceItemsTable } from "./InvoiceItemsTable";
import { InvoicePartiesBlock } from "./InvoicePartiesBlock";
import { InvoicePaymentBankBlock } from "./InvoicePaymentBankBlock";
import { InvoiceSignatureBlock } from "./InvoiceSignatureBlock";
import { InvoiceTotals } from "./InvoiceTotals";
import {
  estimateFirstPageChrome,
  estimateFooterHeight,
  paginateInvoiceItems,
} from "./paginate";
import { invoiceStyles as styles } from "./styles";
import {
  buildInvoiceViewModel,
  type InvoicePdfVariant,
} from "./viewModel";

type Props = {
  document: OrderDocumentPdfSource;
  images: ResolvedSupplierImages;
  variant: InvoicePdfVariant;
};

export function InvoiceCompactDocument({ document, images, variant }: Props) {
  const model = buildInvoiceViewModel(document, images, variant);
  const firstPageChrome = estimateFirstPageChrome(model);
  const footerHeight = estimateFooterHeight(model.taxMode);
  const pages = paginateInvoiceItems(model.items, firstPageChrome, footerHeight);

  return (
    <Document
      title={`Счёт ${model.documentNumber}`}
      author={model.payment.beneficiaryName || "DEKORO"}
      subject={model.basisLine}
      language="ru"
    >
      {pages.map((page, pageIndex) => (
        <Page
          key={`invoice-page-${pageIndex}`}
          size={PDF_PAGE_SIZE}
          orientation="portrait"
          style={styles.page}
        >
          {page.isFirst ? (
            <View wrap={false}>
              <View style={styles.notice}>
                {model.noticeLines.map((line) => (
                  <Text key={line} style={styles.noticeLine}>
                    {line}
                  </Text>
                ))}
              </View>
              <InvoicePaymentBankBlock payment={model.payment} />
              <Text style={styles.title}>
                Счет на оплату № {model.documentNumber} от {model.invoiceDateLabel}
              </Text>
              <View style={styles.titleRule} />
              <InvoicePartiesBlock
                supplierLine={model.supplierLine}
                buyerLine={model.buyerLine}
                basisLine={model.basisLine}
              />
            </View>
          ) : null}

          <InvoiceItemsTable items={page.items} />

          {page.isLast ? (
            <View style={styles.footer} wrap={false}>
              <InvoiceTotals
                taxMode={model.taxMode}
                vatRateLabel={model.vatRateLabel}
                vatAmount={model.vatAmount}
                finalTotal={model.finalTotal}
                itemCount={model.itemCount}
                amountWords={model.amountWords}
                totalLine={model.totalLine}
              />
              <InvoiceSignatureBlock
                directorName={model.directorName}
                issuedDateLabel={model.issuedDateLabel}
                images={model.images}
              />
            </View>
          ) : null}
        </Page>
      ))}
    </Document>
  );
}
