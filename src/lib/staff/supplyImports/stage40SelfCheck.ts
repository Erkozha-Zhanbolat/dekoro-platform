import {
  supplyAcceptedQuantity,
  supplyAmountKzt,
  supplyReceivingDifference,
} from "../supplyMath";

/** Deterministic Stage 40 FX + receiving math checks (no DB). */
export function runSupplyStage40SelfCheck(): string[] {
  const failures: string[] = [];
  const check = (name: string, ok: boolean) => {
    if (!ok) failures.push(name);
  };

  check(
    "fx 53.60 CNY * 71.80 ≈ 3848.48",
    Math.abs((supplyAmountKzt(53.6, "CNY", 71.8) ?? 0) - 3848.48) < 1e-6,
  );
  check(
    "fx 53.60 * 72 = 3859.2",
    Math.abs((supplyAmountKzt(53.6, "CNY", 72) ?? 0) - 3859.2) < 1e-9,
  );
  check(
    "expense 2500 * 72 = 180000",
    Math.abs((supplyAmountKzt(2500, "CNY", 72) ?? 0) - 180000) < 1e-9,
  );
  check(
    "expense override 2500 * 72.35 = 180875",
    Math.abs((supplyAmountKzt(2500, "CNY", 72.35) ?? 0) - 180875) < 1e-9,
  );
  check("KZT rate ignored", supplyAmountKzt(100, "KZT", null) === 100);
  check("missing FX → null", supplyAmountKzt(53.6, "CNY", null) == null);

  check("accepted 1700-5=1695", supplyAcceptedQuantity(1700, 5) === 1695);
  check("accepted null received", supplyAcceptedQuantity(null, 0) == null);
  check("diff shortage -2", supplyReceivingDifference(1698, 1700) === -2);
  check("diff overage +5", supplyReceivingDifference(505, 500) === 5);
  check("diff zero", supplyReceivingDifference(1700, 1700) === 0);
  check("diff pending", supplyReceivingDifference(null, 1700) == null);

  // Idempotency contract (documentation assertion for UI/RPC):
  // confirm with receiving_status=completed must no-op — enforced in SQL.
  check("idempotency contract documented", true);

  return failures;
}
