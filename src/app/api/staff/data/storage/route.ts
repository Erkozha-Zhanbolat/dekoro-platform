import { NextResponse } from "next/server";
import {
  AuthRouteError,
  extractBearerToken,
  requireActiveAdminUser,
} from "@/lib/supabase/routeAuth";
import {
  createSupabaseServiceClient,
  isServiceRoleConfigured,
} from "@/lib/supabase/admin";

export const runtime = "nodejs";

const PRODUCT_BUCKET = "product-images";
const ORG_BUCKET = "organization-assets";
const SUPPLY_BUCKET = "supply-documents";

type StorageBody = {
  action?: unknown;
  paths?: unknown;
};

function collectReferencedPaths(refs: Record<string, unknown>): {
  product: Set<string>;
  organization: Set<string>;
  supply: Set<string>;
} {
  const product = new Set<string>();
  const organization = new Set<string>();
  const supply = new Set<string>();

  const productImages = Array.isArray(refs.product_images) ? refs.product_images : [];
  for (const item of productImages) {
    const row = item as Record<string, unknown>;
    const path = typeof row.path === "string" ? row.path.trim() : "";
    if (path) product.add(path.replace(/^product-images\//, ""));
  }

  const documents = Array.isArray(refs.documents) ? refs.documents : [];
  for (const item of documents) {
    const row = item as Record<string, unknown>;
    const path = typeof row.path === "string" ? row.path.trim() : "";
    if (path) organization.add(path.replace(/^organization-assets\//, ""));
  }

  const org = (refs.organization_assets ?? {}) as Record<string, unknown>;
  for (const key of ["logo_path", "stamp_path", "signature_path", "kaspi_qr_path"] as const) {
    const path = typeof org[key] === "string" ? String(org[key]).trim() : "";
    if (path) organization.add(path);
  }

  const snapshots = Array.isArray(refs.snapshots) ? refs.snapshots : [];
  for (const item of snapshots) {
    const row = item as Record<string, unknown>;
    for (const key of [
      "logo_path",
      "stamp_path",
      "signature_path",
      "source_logo_path",
      "source_stamp_path",
      "source_signature_path",
    ]) {
      const path = typeof row[key] === "string" ? String(row[key]).trim() : "";
      if (path) organization.add(path);
    }
  }

  const supplyDocs = Array.isArray(refs.supply_documents) ? refs.supply_documents : [];
  for (const item of supplyDocs) {
    const row = item as Record<string, unknown>;
    const path = typeof row.path === "string" ? row.path.trim() : "";
    if (path) supply.add(path.replace(/^supply-documents\//, ""));
  }

  return { product, organization, supply };
}

async function listAllPaths(
  service: ReturnType<typeof createSupabaseServiceClient>,
  bucket: string,
  prefix = "",
): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  const queue = [prefix];

  while (queue.length > 0) {
    const current = queue.shift() ?? "";
    let offset = 0;
    for (;;) {
      const { data, error } = await service.storage.from(bucket).list(current, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) {
        throw new Error(error.message || `Не удалось прочитать bucket ${bucket}`);
      }
      if (!data || data.length === 0) break;

      for (const entry of data) {
        const full = current ? `${current}/${entry.name}` : entry.name;
        const isFolder = entry.id == null && !entry.metadata;
        // Supabase: folders often have null id; files have metadata.size
        if (entry.metadata && typeof entry.metadata.size === "number") {
          out.push({ path: full, size: Number(entry.metadata.size) || 0 });
        } else if (isFolder || entry.id == null) {
          queue.push(full);
        } else {
          out.push({
            path: full,
            size: Number(entry.metadata?.size ?? 0) || 0,
          });
        }
      }

      if (data.length < 100) break;
      offset += 100;
    }
  }

  return out;
}

export async function POST(request: Request) {
  try {
    const token = extractBearerToken(request);
    if (!token) {
      return NextResponse.json({ error: "Требуется авторизация" }, { status: 401 });
    }

    const { client } = await requireActiveAdminUser(token);

    if (!isServiceRoleConfigured()) {
      return NextResponse.json(
        {
          error:
            "Storage cleanup недоступен: на сервере не задан SUPABASE_SERVICE_ROLE_KEY.",
        },
        { status: 503 },
      );
    }

    let body: StorageBody = {};
    try {
      body = (await request.json()) as StorageBody;
    } catch {
      body = {};
    }

    const action = typeof body.action === "string" ? body.action : "scan";

    const { data: refsData, error: refsError } = await client.rpc(
      "admin_get_storage_references",
    );
    if (refsError) {
      return NextResponse.json(
        { error: refsError.message || "Не удалось получить ссылки Storage" },
        { status: 400 },
      );
    }

    const refs = (refsData ?? {}) as Record<string, unknown>;
    const referenced = collectReferencedPaths(refs);
    const service = createSupabaseServiceClient();

    const [productFiles, orgFiles, supplyFiles] = await Promise.all([
      listAllPaths(service, PRODUCT_BUCKET),
      listAllPaths(service, ORG_BUCKET),
      listAllPaths(service, SUPPLY_BUCKET),
    ]);

    const productOrphans = productFiles.filter((f) => !referenced.product.has(f.path));
    const orgOrphans = orgFiles.filter((f) => !referenced.organization.has(f.path));
    const supplyOrphans = supplyFiles.filter((f) => !referenced.supply.has(f.path));

    const productBytes = productFiles.reduce((s, f) => s + f.size, 0);
    const orgBytes = orgFiles.reduce((s, f) => s + f.size, 0);
    const supplyBytes = supplyFiles.reduce((s, f) => s + f.size, 0);
    const orphanBytes =
      productOrphans.reduce((s, f) => s + f.size, 0) +
      orgOrphans.reduce((s, f) => s + f.size, 0) +
      supplyOrphans.reduce((s, f) => s + f.size, 0);

    if (action === "scan") {
      return NextResponse.json({
        buckets: {
          [PRODUCT_BUCKET]: {
            files: productFiles.length,
            bytes: productBytes,
            orphans: productOrphans.length,
          },
          [ORG_BUCKET]: {
            files: orgFiles.length,
            bytes: orgBytes,
            orphans: orgOrphans.length,
          },
          [SUPPLY_BUCKET]: {
            files: supplyFiles.length,
            bytes: supplyBytes,
            orphans: supplyOrphans.length,
          },
        },
        totals: {
          files: productFiles.length + orgFiles.length + supplyFiles.length,
          bytes: productBytes + orgBytes + supplyBytes,
          orphan_files: productOrphans.length + orgOrphans.length + supplyOrphans.length,
          orphan_bytes: orphanBytes,
        },
        orphans: {
          [PRODUCT_BUCKET]: productOrphans.slice(0, 200),
          [ORG_BUCKET]: orgOrphans.slice(0, 200),
          [SUPPLY_BUCKET]: supplyOrphans.slice(0, 200),
        },
      });
    }

    if (action === "delete_orphans") {
      const requested = Array.isArray(body.paths) ? body.paths : [];
      const allowedProduct = new Set(productOrphans.map((f) => f.path));
      const allowedOrg = new Set(orgOrphans.map((f) => f.path));
      const allowedSupply = new Set(supplyOrphans.map((f) => f.path));

      const toDeleteProduct: string[] = [];
      const toDeleteOrg: string[] = [];
      const toDeleteSupply: string[] = [];

      for (const raw of requested) {
        if (typeof raw !== "string") continue;
        const path = raw.trim();
        if (!path) continue;
        if (path.startsWith(`${PRODUCT_BUCKET}/`)) {
          const inner = path.slice(PRODUCT_BUCKET.length + 1);
          if (allowedProduct.has(inner)) toDeleteProduct.push(inner);
        } else if (path.startsWith(`${ORG_BUCKET}/`)) {
          const inner = path.slice(ORG_BUCKET.length + 1);
          if (allowedOrg.has(inner)) toDeleteOrg.push(inner);
        } else if (path.startsWith(`${SUPPLY_BUCKET}/`)) {
          const inner = path.slice(SUPPLY_BUCKET.length + 1);
          if (allowedSupply.has(inner)) toDeleteSupply.push(inner);
        } else if (allowedProduct.has(path)) {
          toDeleteProduct.push(path);
        } else if (allowedOrg.has(path)) {
          toDeleteOrg.push(path);
        } else if (allowedSupply.has(path)) {
          toDeleteSupply.push(path);
        }
      }

      // If no explicit paths — delete all detected orphans (still only orphans).
      if (requested.length === 0) {
        toDeleteProduct.push(...allowedProduct);
        toDeleteOrg.push(...allowedOrg);
        toDeleteSupply.push(...allowedSupply);
      }

      let deleted = 0;
      if (toDeleteProduct.length > 0) {
        const { error } = await service.storage
          .from(PRODUCT_BUCKET)
          .remove(toDeleteProduct);
        if (error) {
          return NextResponse.json(
            { error: error.message || "Не удалось удалить orphan product-images" },
            { status: 400 },
          );
        }
        deleted += toDeleteProduct.length;
      }
      if (toDeleteOrg.length > 0) {
        const { error } = await service.storage.from(ORG_BUCKET).remove(toDeleteOrg);
        if (error) {
          return NextResponse.json(
            { error: error.message || "Не удалось удалить orphan organization-assets" },
            { status: 400 },
          );
        }
        deleted += toDeleteOrg.length;
      }
      if (toDeleteSupply.length > 0) {
        const { error } = await service.storage.from(SUPPLY_BUCKET).remove(toDeleteSupply);
        if (error) {
          return NextResponse.json(
            { error: error.message || "Не удалось удалить orphan supply-documents" },
            { status: 400 },
          );
        }
        deleted += toDeleteSupply.length;
      }

      return NextResponse.json({
        deleted,
        product_paths: toDeleteProduct,
        organization_paths: toDeleteOrg,
        supply_paths: toDeleteSupply,
      });
    }

    return NextResponse.json({ error: "Неизвестное действие" }, { status: 400 });
  } catch (error: unknown) {
    if (error instanceof AuthRouteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Ошибка Storage Data Center API",
      },
      { status: 500 },
    );
  }
}
