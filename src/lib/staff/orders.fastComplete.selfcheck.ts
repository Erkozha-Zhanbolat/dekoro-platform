/**
 * Deterministic fast-complete order workflow self-check.
 * Run: npx --yes tsx src/lib/staff/orders.fastComplete.selfcheck.ts
 */
import {
  canStaffFastCompleteOrder,
  FAST_COMPLETE_ELIGIBLE_STATUSES,
  getFastCompleteRemainingSteps,
} from "./orders.fastComplete";
import type { OrderStatus } from "@/types/database";

function assert(label: string, ok: boolean) {
  if (!ok) throw new Error(label);
}

function assertEq(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const ALL_STATUSES: OrderStatus[] = [
  "new",
  "awaiting_payment",
  "paid",
  "picking",
  "ready_for_shipment",
  "shipped",
  "completed",
  "cancelled",
];

// A — paid + manager + items → allowed
assert(
  "A paid manager allowed",
  canStaffFastCompleteOrder({ status: "paid", role: "manager", hasItems: true }),
);

// B — awaiting_payment → no button
assert(
  "B awaiting_payment blocked",
  !canStaffFastCompleteOrder({
    status: "awaiting_payment",
    role: "manager",
    hasItems: true,
  }),
);

// C — cancelled → reject UI
assert(
  "C cancelled blocked",
  !canStaffFastCompleteOrder({ status: "cancelled", role: "admin", hasItems: true }),
);

// D — completed → no button (idempotent handled by RPC)
assert(
  "D completed blocked in UI",
  !canStaffFastCompleteOrder({ status: "completed", role: "admin", hasItems: true }),
);

// E — empty items → unsafe
assert(
  "E empty items blocked",
  !canStaffFastCompleteOrder({ status: "paid", role: "manager", hasItems: false }),
);

// F — picking remaining steps resume (no rewind to paid)
assertEq("F picking steps", getFastCompleteRemainingSteps("picking"), [
  "ready_for_shipment",
  "shipped",
  "completed",
]);

// G — ready_for_shipment continues from current
assertEq("G ready steps", getFastCompleteRemainingSteps("ready_for_shipment"), [
  "shipped",
  "completed",
]);

// H — shipped only completes
assertEq("H shipped steps", getFastCompleteRemainingSteps("shipped"), ["completed"]);

// I — warehouse / accountant / client never get the action
for (const role of ["warehouse", "accountant", "client", null, undefined] as const) {
  assert(
    `I role ${String(role)} blocked`,
    !canStaffFastCompleteOrder({ status: "paid", role, hasItems: true }),
  );
}

// J — paid path is full chain
assertEq("J paid steps", getFastCompleteRemainingSteps("paid"), [
  "picking",
  "ready_for_shipment",
  "shipped",
  "completed",
]);

// Eligible set matches product rule (from paid inclusive)
assertEq(
  "eligible statuses",
  [...FAST_COMPLETE_ELIGIBLE_STATUSES],
  ["paid", "picking", "ready_for_shipment", "shipped"],
);

for (const status of ALL_STATUSES) {
  const allowed = canStaffFastCompleteOrder({
    status,
    role: "admin",
    hasItems: true,
  });
  const expected = (FAST_COMPLETE_ELIGIBLE_STATUSES as readonly string[]).includes(status);
  assert(`matrix ${status}`, allowed === expected);
}

console.log("orders.fastComplete.selfcheck: OK");
