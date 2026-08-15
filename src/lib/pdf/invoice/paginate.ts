import {
  INVOICE_COL,
  INVOICE_TYPE,
  invoiceContentHeight,
  invoiceContentWidth,
} from "./constants";
import type { InvoiceViewModel } from "./viewModel";

export type InvoicePdfPage<T> = {
  items: T[];
  isFirst: boolean;
  isLast: boolean;
};

function avgCharWidth(fontSize: number): number {
  return fontSize * 0.51;
}

export function estimateTextLines(
  text: string,
  widthPt: number,
  fontSize: number,
  maxLines = 4,
): number {
  const perLine = Math.max(8, Math.floor(widthPt / avgCharWidth(fontSize)));
  const lines = Math.ceil(Math.max(1, text.length) / perLine);
  return Math.min(maxLines, Math.max(1, lines));
}

export function estimateItemRowHeight(
  name: string,
  sku: string | null | undefined,
): number {
  const contentWidth = invoiceContentWidth();
  const nameWidth = contentWidth * (parseFloat(INVOICE_COL.name) / 100) - 4;
  const skuWidth = contentWidth * (parseFloat(INVOICE_COL.sku) / 100) - 4;
  const nameLines = estimateTextLines(name || " ", nameWidth, INVOICE_TYPE.tableFont, 3);
  const skuLines = estimateTextLines(sku || " ", skuWidth, INVOICE_TYPE.tableFont, 2);
  const lines = Math.max(nameLines, skuLines);
  return (
    INVOICE_TYPE.tablePadY * 2 +
    INVOICE_TYPE.tableFont * INVOICE_TYPE.tableLineHeight * lines +
    INVOICE_TYPE.tableBorder
  );
}

export function estimateNoticeHeight(): number {
  return 3 * INVOICE_TYPE.noticeFont * INVOICE_TYPE.noticeLineHeight + 4;
}

export function estimateBankBlockHeight(): number {
  const title = 9;
  const row1 =
    INVOICE_TYPE.bankPadY * 2 +
    INVOICE_TYPE.bankLabelFont * 1.1 * 2 +
    INVOICE_TYPE.bankValueFont * 1.12;
  const row2 =
    INVOICE_TYPE.bankPadY * 2 +
    INVOICE_TYPE.bankLabelFont * 1.1 +
    INVOICE_TYPE.bankValueFont * 1.12;
  return title + row1 + row2 + INVOICE_TYPE.tableBorder * 3 + 5;
}

export function estimateTitleHeight(): number {
  return 2 + INVOICE_TYPE.titleFont * 1.15 + 2 + 1 + 4;
}

export function estimatePartiesHeight(
  model: Pick<InvoiceViewModel, "supplierLine" | "buyerLine" | "basisLine">,
): number {
  const valueWidth = invoiceContentWidth() - INVOICE_TYPE.partyLabelWidth - 6;
  const rows = [model.supplierLine, model.buyerLine, model.basisLine];
  let height = 0;
  for (const row of rows) {
    const lines = estimateTextLines(row, valueWidth, INVOICE_TYPE.bodyFont, 2);
    height += INVOICE_TYPE.bodyFont * INVOICE_TYPE.bodyLineHeight * lines + 1.5;
  }
  return height + 4;
}

export function estimateTableHeaderHeight(): number {
  return (
    INVOICE_TYPE.tablePadY * 2 +
    INVOICE_TYPE.tableHeaderFont * INVOICE_TYPE.tableLineHeight +
    INVOICE_TYPE.tableBorder * 2
  );
}

export function estimateFirstPageChrome(
  model: Pick<InvoiceViewModel, "supplierLine" | "buyerLine" | "basisLine">,
): number {
  return (
    estimateNoticeHeight() +
    estimateBankBlockHeight() +
    estimateTitleHeight() +
    estimatePartiesHeight(model) +
    12
  );
}

export function estimateFooterHeight(taxMode: string): number {
  const vatLines = taxMode === "without_vat" ? 3 : 4;
  const totals = 4 + vatLines * 10 + 2;
  const count = 10;
  const words = 4 + INVOICE_TYPE.bodyFont * 1.15 * 2;
  const rule = 8;
  const signLabel = 10;
  const stampRow = Math.max(INVOICE_TYPE.stampSize, INVOICE_TYPE.signatureHeight) + 4;
  const director = 12;
  return totals + count + words + rule + signLabel + stampRow + director + 8;
}

export function paginateInvoiceItems<
  T extends { product_name: string; product_sku: string | null },
>(
  items: T[],
  firstPageChrome: number,
  footerHeight: number,
): InvoicePdfPage<T>[] {
  const contentHeight = invoiceContentHeight();
  const tableHeader = estimateTableHeaderHeight();
  const safety = 16;
  const heights = items.map((item) =>
    estimateItemRowHeight(item.product_name, item.product_sku),
  );
  const count = items.length;

  if (count === 0) {
    return [{ items: [], isFirst: true, isLast: true }];
  }

  const sumRange = (start: number, end: number) => {
    let total = 0;
    for (let i = start; i < end; i += 1) {
      total += heights[i] ?? 0;
    }
    return total;
  };

  const fits = (
    chrome: number,
    start: number,
    end: number,
    includeFooter: boolean,
  ) => {
    const body =
      tableHeader +
      sumRange(start, end) +
      (includeFooter ? footerHeight : 0) +
      safety;
    return chrome + body <= contentHeight;
  };

  const take = (chrome: number, from: number, includeFooter: boolean) => {
    let end = from;
    while (end < count && fits(chrome, from, end + 1, includeFooter)) {
      end += 1;
    }
    if (end === from && from < count) {
      end = from + 1;
    }
    return end;
  };

  if (fits(firstPageChrome, 0, count, true)) {
    return [{ items, isFirst: true, isLast: true }];
  }

  const splitTailForFooter = (chrome: number, from: number): InvoicePdfPage<T>[] => {
    let startLast = count - 1;
    while (startLast > from) {
      if (fits(chrome, from, startLast, false) && fits(0, startLast, count, true)) {
        break;
      }
      startLast -= 1;
    }
    if (startLast <= from) {
      return [{ items: items.slice(from), isFirst: chrome > 0, isLast: true }];
    }
    return [
      {
        items: items.slice(from, startLast),
        isFirst: chrome > 0,
        isLast: false,
      },
      {
        items: items.slice(startLast),
        isFirst: false,
        isLast: true,
      },
    ];
  };

  const firstEnd = take(firstPageChrome, 0, false);
  if (firstEnd >= count) {
    const split = splitTailForFooter(firstPageChrome, 0);
    if (split[0]) split[0].isFirst = true;
    return split;
  }

  const pages: InvoicePdfPage<T>[] = [
    { items: items.slice(0, firstEnd), isFirst: true, isLast: false },
  ];
  let index = firstEnd;

  while (index < count) {
    if (fits(0, index, count, true)) {
      pages.push({ items: items.slice(index), isFirst: false, isLast: true });
      break;
    }

    const end = take(0, index, false);
    if (end >= count) {
      const split = splitTailForFooter(0, index);
      for (const page of split) {
        page.isFirst = false;
      }
      pages.push(...split);
      break;
    }

    pages.push({ items: items.slice(index, end), isFirst: false, isLast: false });
    index = end;
  }

  const last = pages[pages.length - 1];
  if (last) last.isLast = true;
  const first = pages[0];
  if (first) first.isFirst = true;

  return pages;
}

export function invoiceFitsOnOnePage(
  itemCount: number,
  rowHeight = estimateItemRowHeight("Товар", "SKU-001"),
  firstPageChrome: number,
  footerHeight: number,
): boolean {
  const used =
    firstPageChrome +
    estimateTableHeaderHeight() +
    rowHeight * itemCount +
    footerHeight +
    10;
  return used <= invoiceContentHeight();
}
