import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { checkPublishingToken } from "@/lib/publishing/api-auth";
import {
  ScheduleError,
  scheduleReel,
  scheduleReelSchema,
  serializePublication,
} from "@/lib/publishing/schedule";

export const dynamic = "force-dynamic";

function deny(status: 401 | 503) {
  return NextResponse.json(
    {
      success: false,
      error: status === 503 ? "Publishing API is not configured" : "Unauthorized",
    },
    { status }
  );
}

export async function POST(request: NextRequest) {
  const denied = checkPublishingToken(request.headers.get("authorization"));
  if (denied) return deny(denied);

  const body = await request.json().catch(() => null);
  const parsed = scheduleReelSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: "Invalid request", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const { publication, created } = await scheduleReel(parsed.data);
    return NextResponse.json(
      { success: true, created, data: serializePublication(publication) },
      { status: created ? 201 : 200 }
    );
  } catch (error) {
    if (error instanceof ScheduleError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const denied = checkPublishingToken(request.headers.get("authorization"));
  if (denied) return deny(denied);

  const limit = Math.min(
    Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 20) || 20, 1),
    100
  );
  const rows = await prisma.reelPublication.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      insightSnapshots: { orderBy: { hoursAfter: "asc" } },
    },
  });
  return NextResponse.json({
    success: true,
    data: rows.map(serializePublication),
  });
}
