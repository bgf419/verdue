import { eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { profiles } from "../../../db/schema";
import { getChatGPTUser } from "../../chatgpt-auth";

const MAX_LENGTHS = {
  fullName: 160,
  phone: 40,
  address: 220,
  city: 100,
  state: 2,
  zip: 12,
};

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  const db = getDb();
  const [profile] = await db.select().from(profiles).where(eq(profiles.userId, user.userId)).limit(1);
  return Response.json({ profile: profile ?? null });
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  const payload = (await request.json()) as Record<string, unknown>;
  const now = new Date().toISOString();
  const fullName = clean(payload.fullName, MAX_LENGTHS.fullName);
  if (!fullName) return Response.json({ error: "Full name is required" }, { status: 400 });

  const values = {
    userId: user.userId,
    email: user.email,
    fullName,
    phone: clean(payload.phone, MAX_LENGTHS.phone),
    address: clean(payload.address, MAX_LENGTHS.address),
    city: clean(payload.city, MAX_LENGTHS.city),
    state: clean(payload.state, MAX_LENGTHS.state).toUpperCase(),
    zip: clean(payload.zip, MAX_LENGTHS.zip),
    createdAt: now,
    updatedAt: now,
  };

  const db = getDb();
  const [profile] = await db
    .insert(profiles)
    .values(values)
    .onConflictDoUpdate({
      target: profiles.userId,
      set: {
        email: values.email,
        fullName: values.fullName,
        phone: values.phone,
        address: values.address,
        city: values.city,
        state: values.state,
        zip: values.zip,
        updatedAt: now,
      },
    })
    .returning();

  return Response.json({ profile });
}
