import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { checkPublishingToken } from "@/lib/publishing/api-auth";
import { serializePublication } from "@/lib/publishing/schedule";

export const dynamic = "force-dynamic";

type RouteProps = { params: Promise<{ id: string }> };

function deny(status: 401 | 503) {
  return NextResponse.json(
    {
      success: false,
      error: status === 503 ? "Publishing API is not configured" : "Unauthorized",
    },
    { status }
  );
}

export async function GET(
  request: NextRequest,
  { params }: RouteProps
) {
  const denied = checkPublishingToken(request.headers.get("authorization"));
  if (denied) return deny(denied);

  const { id } = await params;
  const row = await prisma.reelPublication.findUnique({
    where: { id },
    include: { insightSnapshots: { orderBy: { hoursAfter: "asc" } } },
  });
  if (!row) {
    return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true, data: serializePublication(row) });
}

/** Cancels a reel that has not started publishing yet. */
export async function DELETE(
  request: NextRequest,
  { params }: RouteProps
) {
  const denied = checkPublishingToken(request.headers.get("authorization"));
  if (denied) return deny(denied);

  const { id } = await params;
  const canceled = await prisma.reelPublication.updateMany({
    where: { id, status: "SCHEDULED" },
    data: { status: "CANCELED" },
  });
  if (canceled.count !== 1) {
    return NextResponse.json(
      { success: false, error: "Only a SCHEDULED reel can be canceled" },
      { status: 409 }
    );
  }
  return NextResponse.json({ success: true });
}
