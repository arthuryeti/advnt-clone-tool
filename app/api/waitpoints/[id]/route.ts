import { completeToken } from "@/lib/jobs";

/** KIE and Sume POST a finished render here (wait.createToken's URL); the waiting render picks it up. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body: unknown = await request.json().catch(() => null);
  return completeToken(id, body)
    ? Response.json({ ok: true })
    : Response.json({ message: "Unknown or expired token." }, { status: 404 });
}
