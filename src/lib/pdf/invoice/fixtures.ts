import type {
  OrderDocumentMetadata,
  OrderDocumentMetadataItem,
  OrderDocumentPdfSource,
} from "@/types/database";
import type { ResolvedSupplierImages } from "../types";

const EMPTY_IMAGES: ResolvedSupplierImages = {
  logoUrl: null,
  stampUrl: null,
  signatureUrl: null,
};

const STAMP_IMAGES: ResolvedSupplierImages = {
  logoUrl: null,
  stampUrl: "https://example.invalid/stamp.png",
  signatureUrl: "https://example.invalid/signature.png",
};

const ISSUED_AT = "2026-08-14T09:00:00.000+05:00";
const ORDER_CREATED_AT = "2026-08-13T11:30:00.000+05:00";

type ItemSeed = {
  name: string;
  sku: string;
  qty: number;
  price: number;
  unit?: string;
};

const SHORT_NAMES = [
  "Смеситель для раковины",
  "Сифон бутылочный",
  "Шланг гибкий 50 см",
  "Полотенцесушитель",
  "Термостат комнатный",
  "Фильтр грубой очистки",
  "Кран шаровый 1/2",
  "Гофра для унитаза",
  "Смеситель для душа",
  "Душевая лейка",
  "Карниз для ванны",
  "Шторка для ванны",
  "Зеркало 60 см",
  "Пенал подвесной",
  "Раковина накладная",
  "Унитаз подвесной",
  "Инсталляция",
  "Кнопка смыва",
  "Трап душевой",
  "Плитка настенная",
  "Плитка напольная",
  "Затирка белая",
  "Клей плиточный",
  "Грунтовка",
  "Герметик санитарный",
  "Сиденье для унитаза",
];

const LONG_NAME =
  "Смеситель для раковины настольный однорычажный с донным клапаном, хромированный, коллекция DEKORO Compact Line 2026";

function line(seed: ItemSeed, index: number): OrderDocumentMetadataItem {
  const qty = seed.qty;
  const price = seed.price;
  return {
    line_no: index + 1,
    order_item_id: `item-${index + 1}`,
    product_id: `prod-${index + 1}`,
    product_name: seed.name,
    product_sku: seed.sku,
    unit: seed.unit ?? "шт",
    quantity: qty,
    unit_price: price,
    line_total: Math.round(qty * price * 100) / 100,
  };
}

export function buildInvoiceFixtureItems(
  count: number,
  longNameIndexes: number[] = [],
): OrderDocumentMetadataItem[] {
  const seeds: ItemSeed[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = SHORT_NAMES[i % SHORT_NAMES.length] ?? "Товар";
    const name = longNameIndexes.includes(i) ? `${LONG_NAME} (${i + 1})` : `${base} ${i + 1}`;
    seeds.push({
      name,
      sku: `DK-${String(1000 + i)}`,
      qty: i % 3 === 0 ? 23 : i % 3 === 1 ? 2 : 5,
      price: 15_900 + i * 250,
    });
  }
  return seeds.map(line);
}

function totalsFromItems(
  items: OrderDocumentMetadataItem[],
  taxMode: "with_vat" | "without_vat",
  vatRate = 16,
) {
  const subtotal = items.reduce((sum, item) => sum + item.line_total, 0);
  const vatAmount =
    taxMode === "with_vat" ? Math.round(subtotal * vatRate) / 100 : 0;
  const finalTotal = taxMode === "with_vat" ? subtotal + vatAmount : subtotal;
  return {
    subtotal,
    items_subtotal: subtotal,
    discount: 0,
    order_total: subtotal,
    amount_without_vat: subtotal,
    vat_rate: taxMode === "with_vat" ? vatRate : 0,
    vat_amount: vatAmount,
    final_total: finalTotal,
    total: finalTotal,
    items_count: items.length,
    item_count: items.length,
    total_quantity: items.reduce((sum, item) => sum + item.quantity, 0),
    currency: "KZT",
    tax_mode: taxMode,
    tax_label: taxMode === "with_vat" ? "С учетом НДС" : "Без НДС",
    formula: "fixture",
    prices_include_vat: false,
    amount_in_words: null,
  };
}

const PAYMENT_PROFILE = {
  id: "pay-1",
  customer_type: "company",
  beneficiary_name: "ИП DEKORO",
  bin_iin: "123456789012",
  bank_name: "АО «Kaspi Bank»",
  bank_bik: "CASPKZKA",
  bank_iik: "KZ539470398991137318",
  bank_kbe: "19",
  payment_purpose_code: "710",
  is_active: true,
};

const SUPPLIER = {
  legal_name: "ИП DEKORO",
  bin: "123456789012",
  address: "Республика Казахстан, г. Алматы, ул. Примерная, д. 1",
  city: "Алматы",
  phone: "+7 700 000 00 00",
  email: "hello@dekoro.kz",
  website: "https://dekoro.kz",
  bank_name: "АО «Kaspi Bank»",
  bank_bik: "CASPKZKA",
  bank_iik: "KZ539470398991137318",
  bank_kbe: "19",
  director_name: "Иванов И.И.",
  logo_path: null,
  stamp_path: null,
  signature_path: null,
};

const COMPANY_BUYER = {
  customer_id: "cust-1",
  customer_type: "company",
  display_name: "ТОО Покупатель",
  legal_name: "ТОО «Покупатель»",
  iin: null,
  bin: "987654321098",
  iin_bin: "987654321098",
  phone: "+7 701 111 11 11",
  email: "buyer@example.kz",
  contact_person: "Петров П.П.",
  address: "Республика Казахстан, г. Астана, пр. Мангилик Ел, д. 10",
  city: "Астана",
};

const INDIVIDUAL_BUYER = {
  customer_id: "cust-2",
  customer_type: "individual",
  display_name: "Сидоров С.С.",
  legal_name: null,
  iin: null,
  bin: null,
  iin_bin: null,
  phone: "+7 702 222 22 22",
  email: "sidorov@example.kz",
  contact_person: null,
  address: null,
  city: "Алматы",
};

function metadata(options: {
  items: OrderDocumentMetadataItem[];
  template: "company" | "individual";
  taxMode: "with_vat" | "without_vat";
  number?: string;
}): OrderDocumentMetadata {
  const { items, template, taxMode, number = "INV-000123" } = options;
  const buyer = template === "company" ? COMPANY_BUYER : INDIVIDUAL_BUYER;
  return {
    schema_version: 3,
    document_type: "invoice",
    document_number: number,
    form_hint:
      template === "company" ? "kz_invoice_company" : "kz_invoice_individual",
    invoice_template: template,
    generated_at: ISSUED_AT,
    warning_text: null,
    order: {
      id: "order-1",
      order_number: "DK-000456",
      status: "new",
      created_at: ORDER_CREATED_AT,
      customer_id: buyer.customer_id,
    },
    supplier: { ...SUPPLIER },
    payment_profile: {
      ...PAYMENT_PROFILE,
      customer_type: template,
    },
    buyer: { ...buyer },
    items,
    totals: totalsFromItems(items, taxMode),
    basis: {
      label: "Заказ DK-000456",
      order_number: "DK-000456",
      order_date: ORDER_CREATED_AT,
      contract_number: null,
      contract_date: null,
      contract_label: "Без договора",
    },
    form_3_2: {},
  };
}

function documentFromMetadata(meta: OrderDocumentMetadata): OrderDocumentPdfSource {
  return {
    id: "doc-1",
    order_id: "order-1",
    document_type: "invoice",
    number: meta.document_number,
    metadata: meta,
  };
}

export type InvoiceLayoutFixture = {
  id: string;
  label: string;
  variant: "company" | "individual";
  document: OrderDocumentPdfSource;
  images: ResolvedSupplierImages;
};

export const INVOICE_LAYOUT_FIXTURES: InvoiceLayoutFixture[] = [
  {
    id: "A",
    label: "2 short items",
    variant: "company",
    document: documentFromMetadata(
      metadata({ items: buildInvoiceFixtureItems(2), template: "company", taxMode: "with_vat" }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "B",
    label: "10 mixed items",
    variant: "company",
    document: documentFromMetadata(
      metadata({
        items: buildInvoiceFixtureItems(10, [2, 7]),
        template: "company",
        taxMode: "with_vat",
      }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "C",
    label: "20 ordinary items",
    variant: "company",
    document: documentFromMetadata(
      metadata({ items: buildInvoiceFixtureItems(20), template: "company", taxMode: "with_vat" }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "D",
    label: "20 items with long names",
    variant: "company",
    document: documentFromMetadata(
      metadata({
        items: buildInvoiceFixtureItems(20, [1, 8, 14, 19]),
        template: "company",
        taxMode: "with_vat",
      }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "E",
    label: "25+ items multi-page",
    variant: "company",
    document: documentFromMetadata(
      metadata({
        items: buildInvoiceFixtureItems(48, [0, 5, 11, 18, 24, 30, 37, 44]),
        template: "company",
        taxMode: "with_vat",
        number: "INV-000125",
      }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "F",
    label: "company buyer",
    variant: "company",
    document: documentFromMetadata(
      metadata({ items: buildInvoiceFixtureItems(5), template: "company", taxMode: "with_vat" }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "G",
    label: "individual buyer",
    variant: "individual",
    document: documentFromMetadata(
      metadata({
        items: buildInvoiceFixtureItems(5),
        template: "individual",
        taxMode: "with_vat",
        number: "INV-000126",
      }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "H",
    label: "VAT payer",
    variant: "company",
    document: documentFromMetadata(
      metadata({ items: buildInvoiceFixtureItems(4), template: "company", taxMode: "with_vat" }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "I",
    label: "without VAT",
    variant: "company",
    document: documentFromMetadata(
      metadata({ items: buildInvoiceFixtureItems(4), template: "company", taxMode: "without_vat" }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "J",
    label: "with stamp/signature",
    variant: "company",
    document: documentFromMetadata(
      metadata({ items: buildInvoiceFixtureItems(3), template: "company", taxMode: "with_vat" }),
    ),
    images: STAMP_IMAGES,
  },
  {
    id: "K",
    label: "without stamp/signature",
    variant: "company",
    document: documentFromMetadata(
      metadata({ items: buildInvoiceFixtureItems(3), template: "company", taxMode: "with_vat" }),
    ),
    images: EMPTY_IMAGES,
  },
];

export function getInvoiceLayoutFixture(id: string): InvoiceLayoutFixture {
  const found = INVOICE_LAYOUT_FIXTURES.find((fixture) => fixture.id === id);
  if (!found) {
    throw new Error(`Unknown invoice fixture: ${id}`);
  }
  return found;
}
