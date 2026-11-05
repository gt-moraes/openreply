import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can disconnect accounts" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  const instagramAccountId =
    body && typeof body === "object" && !Array.isArray(body) &&
    typeof body.instagramAccountId === "string" ? body.instagramAccountId.trim() : "";
  if (!instagramAccountId) {
    return NextResponse.json({ success: false, error: "Selecione a conta que deseja desconectar." }, { status: 400 });
  }

  // Removing an account cascades into campaigns, delivery records and links.
  // A rename/token renewal must use OAuth reconnection, retaining this account ID.
  const result = await prisma.$transaction(async tx => {
    const account = await tx.instagramAccount.findFirst({
      where: { id: instagramAccountId, workspaceId: context.workspaceId },
      select: {
        id: true,
        _count: { select: { automations: true, dmLogs: true, linkClicks: true, followerSnapshots: true, reelPublications: true } },
      },
    });
    if (!account) return { status: 404, error: "Conta não encontrada neste workspace." };
    if (Object.values(account._count).some(count => count > 0)) {
      return { status: 409, error: "Esta conta possui campanhas ou histórico. Para renovar o acesso, conecte o Instagram novamente sem desconectar. Os dados foram preservados." };
    }
    await tx.instagramAccount.deleteMany({ where: { id: instagramAccountId, workspaceId: context.workspaceId } });
    return { status: 200, error: null };
  }, { isolationLevel: "Serializable" });

  return NextResponse.json(
    { success: result.status === 200, ...(result.error ? { error: result.error } : {}) },
    { status: result.status },
  );
}
