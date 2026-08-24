/**
 * Deterministic inventory balance self-check (scenarios A–H + Excel).
 * Run: npx --yes tsx src/lib/staff/inventoryBalance.selfcheck.ts
 */
import {
  computeInventoryBalance,
  filterInventoryBalanceProducts,
  incomingLineQuantity,
  isIncomingSupply,
  mapInventoryBalanceReport,
  sortInventoryBalanceProducts,
  summarizeFilteredProducts,
  type InventoryBalanceProduct,
} from "./inventoryBalance";
import {
  buildInventoryBalanceWorkbook,
  inventoryBalanceExcelFileName,
} from "./inventoryBalanceExcel";

function assert(label: string, ok: boolean) {
  if (!ok) throw new Error(label);
}

function assertEq(label: string, actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function baseProduct(
  overrides: Partial<InventoryBalanceProduct> & Pick<InventoryBalanceProduct, "product_id" | "sku">,
): InventoryBalanceProduct {
  return {
    name: overrides.name ?? overrides.sku,
    original_sku: null,
    dimensions: null,
    unit: "шт.",
    weight_kg: 1,
    status: "active",
    category_id: "cat-1",
    category_name: "Бамбуковые панели",
    category_sort_order: 10,
    subcategory_id: null,
    subcategory_name: null,
    subcategory_sort_order: 2147483647,
    physical_qty: 0,
    reserved_qty: 0,
    available_qty: 0,
    incoming_qty: 0,
    expected_available_qty: 0,
    incoming_breakdown: [],
    catalogs: [],
    ...overrides,
  };
}

// A — ordinary
{
  const r = computeInventoryBalance({ physical: 500, reserved: 100, incoming: 0 });
  assertEq("A available", r.available, 400);
  assertEq("A expected", r.expected_available, 400);
}

// B — with supply
{
  const r = computeInventoryBalance({ physical: 500, reserved: 100, incoming: 300 });
  assertEq("B available", r.available, 400);
  assertEq("B expected", r.expected_available, 700);
}

// C — almost all reserved
{
  const r = computeInventoryBalance({ physical: 500, reserved: 450, incoming: 0 });
  assertEq("C available", r.available, 50);
  assert("C not showing 500 as available", r.available !== 500);
}

// D — zero stock, incoming
{
  const r = computeInventoryBalance({ physical: 0, reserved: 0, incoming: 500 });
  assertEq("D available", r.available, 0);
  assertEq("D incoming", r.incoming, 500);
  assertEq("D expected", r.expected_available, 500);
}

// E — receiving completed: physical gains, incoming clears; expected stays 500
{
  const before = computeInventoryBalance({ physical: 0, reserved: 0, incoming: 500 });
  const after = computeInventoryBalance({ physical: 500, reserved: 0, incoming: 0 });
  assertEq("E before expected", before.expected_available, 500);
  assertEq("E after expected", after.expected_available, 500);
  assertEq("E after incoming", after.incoming, 0);
  assert("E no double count", after.expected_available !== 1000);
}

// F — draft supply excluded
{
  assert("F draft excluded", !isIncomingSupply({ receiving_status: "not_started", logistics_status: "draft" }));
  assert(
    "F ordered included",
    isIncomingSupply({ receiving_status: "not_started", logistics_status: "ordered" }),
  );
  assert(
    "F completed receiving excluded",
    !isIncomingSupply({ receiving_status: "completed", logistics_status: "to_almaty" }),
  );
}

// G — several supplies → 650; qty fallback chain
{
  const lines = [
    { shipped_quantity: 200, ordered_quantity: 999, quantity: 1 },
    { shipped_quantity: null, ordered_quantity: 300, quantity: 1 },
    { shipped_quantity: null, ordered_quantity: null, quantity: 150 },
  ];
  const incoming = lines.reduce((s, line) => s + incomingLineQuantity(line), 0);
  assertEq("G incoming sum", incoming, 650);
  assertEq("G prefers shipped", incomingLineQuantity(lines[0]!), 200);
  assertEq("G then ordered", incomingLineQuantity(lines[1]!), 300);
  assertEq("G then quantity", incomingLineQuantity(lines[2]!), 150);
}

// H — reserve + incoming
{
  const r = computeInventoryBalance({ physical: 100, reserved: 80, incoming: 300 });
  assertEq("H available", r.available, 20);
  assertEq("H expected", r.expected_available, 320);
}

// Filter / sort / summary
{
  const products = [
    baseProduct({
      product_id: "1",
      sku: "DK-B",
      name: "Beta",
      physical_qty: 10,
      reserved_qty: 2,
      available_qty: 8,
      incoming_qty: 0,
      expected_available_qty: 8,
      category_sort_order: 20,
    }),
    baseProduct({
      product_id: "2",
      sku: "DK-A",
      name: "Alpha",
      physical_qty: 0,
      reserved_qty: 0,
      available_qty: 0,
      incoming_qty: 100,
      expected_available_qty: 100,
      category_sort_order: 10,
      incoming_breakdown: [
        {
          supply_id: "s1",
          supply_number: "П-000123",
          logistics_status: "ready_at_factory",
          receiving_status: "not_started",
          supply_date: "2026-08-01",
          quantity: 100,
          label: "Готово на заводе",
        },
      ],
    }),
  ];

  const out = filterInventoryBalanceProducts(products, { stockState: "out_of_stock" });
  assertEq("filter out of stock count", out.length, 1);
  assertEq("filter out of stock sku", out[0]!.sku, "DK-A");

  const incomingOnly = filterInventoryBalanceProducts(products, { stockState: "incoming" });
  assertEq("filter incoming", incomingOnly.length, 1);

  const byAvailable = sortInventoryBalanceProducts(products, "available_qty", "asc");
  assertEq("sort available asc first", byAvailable[0]!.sku, "DK-A");

  const byCatalog = sortInventoryBalanceProducts(products, null, "asc");
  assertEq("default category order first", byCatalog[0]!.sku, "DK-A");

  const summary = summarizeFilteredProducts(products);
  assertEq("summary total", summary.total_sku, 2);
  assertEq("summary incoming units", summary.incoming_units, 100);
}

// Mapper + Excel
{
  const mapped = mapInventoryBalanceReport({
    generated_at: "2026-08-24T00:00:00Z",
    timezone: "Asia/Almaty",
    warehouse: { id: "w1", code: "ALMATY-01", name: "Алматы" },
    catalogs: [{ id: "c1", name: "Белая книга", color: "slate", sort_order: 1, is_active: true }],
    categories: [{ id: "cat-1", name: "Бамбуковые панели", parent_id: null, sort_order: 10, is_active: true }],
    summary: {
      total_sku: 1,
      in_stock_sku: 1,
      out_of_stock_sku: 0,
      reserved_units: 100,
      incoming_units: 300,
    },
    products: [
      {
        product_id: "p1",
        sku: "DK-1",
        original_sku: "FAC-1",
        name: "Панель",
        category_id: "cat-1",
        category_name: "Бамбуковые панели",
        category_sort_order: 10,
        physical_qty: 500,
        reserved_qty: 100,
        available_qty: 400,
        incoming_qty: 300,
        expected_available_qty: 700,
        weight_kg: 2.5,
        catalogs: [{ id: "c1", name: "Белая книга", color: "slate", sort_order: 1 }],
        incoming_breakdown: [
          {
            supply_id: "s1",
            supply_number: "П-000128",
            logistics_status: "khorgos_queue",
            receiving_status: "not_started",
            quantity: 300,
            label: "Очередь Хоргос",
          },
        ],
      },
    ],
  });

  assertEq("map available", mapped.products[0]!.available_qty, 400);
  assertEq("map expected", mapped.products[0]!.expected_available_qty, 700);
  assertEq("map warehouse", mapped.warehouse.code, "ALMATY-01");

  const { workbook, fileName } = buildInventoryBalanceWorkbook({
    report: mapped,
    products: mapped.products,
  });
  assert("excel file name", fileName.startsWith("DEKORO_Остатки_"));
  assertEq("excel sheets", workbook.SheetNames.join(","), "Остатки,В пути");
  const balance = workbook.Sheets["Остатки"];
  assert("excel has DEKORO", String(balance?.A1?.v) === "DEKORO");
  assert("excel has title", String(balance?.A2?.v).includes("остаткам"));
  const incoming = workbook.Sheets["В пути"];
  assert("incoming sheet title", String(incoming?.A2?.v).includes("пути"));
  assert("file name helper", inventoryBalanceExcelFileName(new Date("2026-08-24T12:00:00+05:00")).includes("2026-08-24"));
}

console.log("inventoryBalance.selfcheck: OK");
