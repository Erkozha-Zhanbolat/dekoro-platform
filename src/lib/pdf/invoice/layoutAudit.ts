import { invoiceContentHeight } from "./constants";
import { INVOICE_LAYOUT_FIXTURES, buildInvoiceFixtureItems } from "./fixtures";
import {
  estimateFirstPageChrome,
  estimateFooterHeight,
  invoiceFitsOnOnePage,
  paginateInvoiceItems,
} from "./paginate";
import { buildInvoiceViewModel } from "./viewModel";

export type InvoiceLayoutAuditRow = {
  id: string;
  label: string;
  itemCount: number;
  pages: number;
  firstPageItems: number;
  lastPageItems: number;
  contentHeight: number;
  firstPageChrome: number;
  footerHeight: number;
  itemsBudgetFirstPage: number;
  shortRowFits20: boolean;
};

function auditRow(
  id: string,
  label: string,
  items: { product_name: string; product_sku: string | null }[],
  firstPageChrome: number,
  footerHeight: number,
  contentHeight: number,
): InvoiceLayoutAuditRow {
  const pages = paginateInvoiceItems(items, firstPageChrome, footerHeight);
  const first = pages[0];
  const last = pages[pages.length - 1];
  return {
    id,
    label,
    itemCount: items.length,
    pages: pages.length,
    firstPageItems: first?.items.length ?? 0,
    lastPageItems: last?.items.length ?? 0,
    contentHeight,
    firstPageChrome,
    footerHeight,
    itemsBudgetFirstPage: contentHeight - firstPageChrome - footerHeight,
    shortRowFits20: invoiceFitsOnOnePage(20, undefined, firstPageChrome, footerHeight),
  };
}

export function auditInvoiceLayout(): InvoiceLayoutAuditRow[] {
  const contentHeight = invoiceContentHeight();
  const rows: InvoiceLayoutAuditRow[] = [];

  for (const fixture of INVOICE_LAYOUT_FIXTURES) {
    const model = buildInvoiceViewModel(
      fixture.document,
      fixture.images,
      fixture.variant,
    );
    const firstPageChrome = estimateFirstPageChrome(model);
    const footerHeight = estimateFooterHeight(model.taxMode);
    rows.push(
      auditRow(
        fixture.id,
        fixture.label,
        model.items,
        firstPageChrome,
        footerHeight,
        contentHeight,
      ),
    );
  }

  const base = INVOICE_LAYOUT_FIXTURES.find((fixture) => fixture.id === "C");
  if (base) {
    const model = buildInvoiceViewModel(base.document, base.images, base.variant);
    const firstPageChrome = estimateFirstPageChrome(model);
    const footerHeight = estimateFooterHeight(model.taxMode);
    for (const count of [2, 10, 15, 20, 25]) {
      rows.push(
        auditRow(
          `${count}`,
          `${count} ordinary short items`,
          buildInvoiceFixtureItems(count),
          firstPageChrome,
          footerHeight,
          contentHeight,
        ),
      );
    }
  }

  return rows;
}

export function formatInvoiceLayoutAudit(rows = auditInvoiceLayout()): string {
  const lines = [
    "Stage 36 invoice layout audit",
    `contentHeight=${rows[0]?.contentHeight.toFixed(1) ?? "—"}pt`,
    "",
  ];
  for (const row of rows) {
    lines.push(
      [
        `${row.id}: ${row.label}`,
        `items=${row.itemCount}`,
        `pages=${row.pages}`,
        `p1=${row.firstPageItems}`,
        `last=${row.lastPageItems}`,
        `chrome=${row.firstPageChrome.toFixed(1)}`,
        `footer=${row.footerHeight.toFixed(1)}`,
        `budget=${row.itemsBudgetFirstPage.toFixed(1)}`,
        `20short=${row.shortRowFits20 ? "yes" : "NO"}`,
      ].join(" | "),
    );
  }
  return lines.join("\n");
}
