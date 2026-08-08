import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { userClaimEvents, userClaims } from "../../../db/schema";
import { getChatGPTUser } from "../../chatgpt-auth";
import { cases } from "../../cases";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  const db = getDb();
  const claims = await db
    .select()
    .from(userClaims)
    .where(eq(userClaims.userId, user.userId))
    .orderBy(desc(userClaims.updatedAt));
  return Response.json({ claims });
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  const payload = (await request.json()) as { caseId?: string; action?: string };
  const caseId = payload.caseId?.trim() ?? "";
  if (!cases.some((item) => item.id === caseId)) {
    return Response.json({ error: "Unknown case" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const db = getDb();
  const [claim] = await db.batch([
    db
      .insert(userClaims)
      .values({
        id,
        userId: user.userId,
        caseId,
        personalStatus: "continued_to_official_site",
        statusProvenance: "user_action",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [userClaims.userId, userClaims.caseId],
        set: {
          personalStatus: "continued_to_official_site",
          statusProvenance: "user_action",
          updatedAt: now,
        },
      })
      .returning(),
    db
      .insert(userClaimEvents)
      .values({
        userClaimId: id,
        userId: user.userId,
        eventType: payload.action === "submitted" ? "submitted_user_reported" : "official_site_opened",
        provenance: "user_action",
        happenedAt: now,
      })
      .returning(),
  ]);

  return Response.json({ claim: claim[0] }, { status: 201 });
}
